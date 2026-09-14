/**
 * Commission ledger integrity checker.
 *
 *   npm run verify:commissions          read-only
 *   npm run verify:commissions -- --fix rebuild the cached fields
 *
 * The counterpart to verifyTree.js. CommissionLedger is the source of truth;
 * directIncome / matchingIncome / carry / totalVolume on Associate are a cache
 * that exists so a dashboard is one document read. Caches drift — a failed
 * $inc, a replayed backfill, a hand edit in Compass — and the drift is silent:
 * every screen keeps rendering, showing numbers the ledger does not support.
 *
 * --fix rewrites the income and volume caches from the ledger. It deliberately
 * does NOT rebuild carry: carry is a running balance whose history depends on
 * the ORDER members were placed in, and that order cannot be reconstructed from
 * the ledger alone. Carry problems are reported for a human to judge.
 *
 * Exits 1 if any problem is found, so it can gate CI or a cron alert.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Associate = require('../models/Associate');
const CommissionLedger = require('../models/CommissionLedger');
const Referral = require('../models/Referral');
const { resolveLegSides } = require('../services/commissionService');
const {
  ROLES,
  COMMISSION_TYPES,
  POSITIONS,
  TREE_STATUSES,
  REFERRAL_STATUSES
} = require('../config/constants');

const fix = process.argv.includes('--fix');
const problems = [];
const report = (check, detail) => problems.push({ check, detail });

const round2 = (n) => Math.round(n * 100) / 100;

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to MongoDB${fix ? '  [--fix: caches will be rewritten]' : '  [read-only]'}\n`);

  const members = await Associate.find({ role: ROLES.ASSOCIATE })
    .select(
      'memberCode directIncome matchingIncome carryLeft carryRight ' +
        'totalLeftVolume totalRightVolume ancestors depth treeStatus position'
    )
    .lean();

  if (!members.length) {
    console.log('No associates — nothing to verify.');
    await mongoose.disconnect();
    return;
  }

  const byId = new Map(members.map((m) => [String(m._id), m]));
  console.log(`Checking ${members.length} associates against the ledger…\n`);

  // --- 1. Income caches match the ledger -----------------------------------
  const totals = await CommissionLedger.aggregate([
    { $group: { _id: { beneficiary: '$beneficiary', type: '$type' }, total: { $sum: '$amount' } } }
  ]);

  const ledgerBy = new Map();
  for (const row of totals) {
    const key = String(row._id.beneficiary);
    if (!ledgerBy.has(key)) ledgerBy.set(key, { direct: 0, matching: 0, reversal: 0 });
    const bucket = ledgerBy.get(key);
    if (row._id.type === COMMISSION_TYPES.DIRECT) bucket.direct = row.total;
    if (row._id.type === COMMISSION_TYPES.MATCHING) bucket.matching = row.total;
    if (row._id.type === COMMISSION_TYPES.REVERSAL) bucket.reversal = row.total;
  }

  const repairs = [];

  for (const m of members) {
    const led = ledgerBy.get(String(m._id)) || { direct: 0, matching: 0, reversal: 0 };

    // A reversal row carries the negative of whatever it undid, so it has to be
    // folded back into the same bucket the original bumped. Without the row's
    // own type we cannot split a mixed reversal total, so it is attributed
    // whole — which is why reverseRow() adjusts the cache itself at write time
    // and this check treats any residual as drift worth a human look.
    const expectedDirect = round2(led.direct);
    const expectedMatching = round2(led.matching);

    const driftDirect = round2((m.directIncome || 0) - expectedDirect);
    const driftMatching = round2((m.matchingIncome || 0) - expectedMatching);

    if (driftDirect !== 0 || driftMatching !== 0) {
      // Reversals explain some drift legitimately; flag the size so it can be
      // told apart from a genuinely lost write.
      const reversalNote = led.reversal !== 0 ? ` (reversals on this member: ${led.reversal})` : '';
      report(
        'incomeCache',
        `${m.memberCode}: cached direct=${m.directIncome} matching=${m.matchingIncome}, ` +
          `ledger says direct=${expectedDirect} matching=${expectedMatching}${reversalNote}.`
      );
      repairs.push({
        updateOne: {
          filter: { _id: m._id },
          update: { $set: { directIncome: expectedDirect, matchingIncome: expectedMatching } }
        }
      });
    }
  }

  // --- 2. Leg volume matches the tree --------------------------------------
  // Every placed member contributes their commission base to ONE leg of EVERY
  // ancestor. Recomputing that from the tree is what catches a settle() run
  // that died partway up the chain — the ledger looks plausible, but the
  // ancestors above the failure point are short.
  const bases = new Map(
    (
      await Referral.find({ status: { $in: [REFERRAL_STATUSES.UNUSED, REFERRAL_STATUSES.USED] } })
        .select('member amountPaid')
        .lean()
    ).map((r) => [String(r.member), r.amountPaid || 0])
  );

  const expectedVolume = new Map(); // ancestorId -> { left, right }
  const bump = (id, side, amount) => {
    const key = String(id);
    if (!expectedVolume.has(key)) expectedVolume.set(key, { left: 0, right: 0 });
    expectedVolume.get(key)[side === POSITIONS.LEFT ? 'left' : 'right'] += amount;
  };

  for (const m of members) {
    if (m.treeStatus === TREE_STATUSES.UNPLACED) continue;
    const base = bases.get(String(m._id)) || 0;
    if (base <= 0) continue;

    const ordered = (m.ancestors || []).map((id) => byId.get(String(id)));
    if (ordered.some((a) => !a)) {
      report('ancestors', `${m.memberCode}: ancestor chain has a missing record — run npm run verify:tree first.`);
      continue;
    }

    try {
      for (const { ancestor, side } of resolveLegSides(m, ordered)) {
        bump(ancestor._id, side, base);
      }
    } catch (err) {
      report('legSide', `${m.memberCode}: ${err.message}`);
    }
  }

  for (const m of members) {
    const exp = expectedVolume.get(String(m._id)) || { left: 0, right: 0 };
    const actualL = m.totalLeftVolume || 0;
    const actualR = m.totalRightVolume || 0;

    if (round2(actualL) !== round2(exp.left) || round2(actualR) !== round2(exp.right)) {
      report(
        'legVolume',
        `${m.memberCode}: stored volume L=${actualL} R=${actualR}, but the tree implies L=${exp.left} R=${exp.right}.`
      );
      repairs.push({
        updateOne: {
          filter: { _id: m._id },
          update: { $set: { totalLeftVolume: round2(exp.left), totalRightVolume: round2(exp.right) } }
        }
      });
    }
  }

  // --- 2b. Ledger rows point at members that still exist -------------------
  const referenced = await CommissionLedger.aggregate([
    { $group: { _id: null, sources: { $addToSet: '$sourceMember' }, beneficiaries: { $addToSet: '$beneficiary' } } }
  ]);
  for (const id of referenced[0]?.sources || []) {
    if (!byId.has(String(id))) report('orphanRow', `Ledger rows reference source member ${id}, which no longer exists.`);
  }
  for (const id of referenced[0]?.beneficiaries || []) {
    if (!byId.has(String(id))) report('orphanRow', `Ledger rows pay beneficiary ${id}, which no longer exists.`);
  }

  // --- 3. Carry is never negative ------------------------------------------
  for (const m of members) {
    if ((m.carryLeft || 0) < 0 || (m.carryRight || 0) < 0) {
      report('carry', `${m.memberCode}: negative carry (L=${m.carryLeft}, R=${m.carryRight}). A deduction ran without its guard.`);
    }
    // Both legs holding matchable volume means a match was missed — the engine
    // should have paired them the moment the second leg landed.
    const matchable = Math.min(m.carryLeft || 0, m.carryRight || 0);
    if (matchable > 0) {
      report(
        'unmatchedCarry',
        `${m.memberCode}: ${matchable} sits matchable on BOTH legs (L=${m.carryLeft}, R=${m.carryRight}) ` +
          'but was never paired. A settle() run died between the $inc and the deduction.'
      );
    }
  }

  // --- 4. Idempotency keys are unique --------------------------------------
  const dupes = await CommissionLedger.aggregate([
    { $group: { _id: '$idempotencyKey', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]);
  for (const d of dupes) {
    report('idempotency', `Key "${d._id}" appears ${d.count} times — the unique index is missing. Run npm run sync:indexes.`);
  }

  // --- 5. Reversals point at a real row ------------------------------------
  const reversals = await CommissionLedger.find({ type: COMMISSION_TYPES.REVERSAL })
    .select('reversalOf amount beneficiaryCode')
    .lean();
  const originalIds = reversals.map((r) => r.reversalOf).filter(Boolean);
  const foundOriginals = new Set(
    (await CommissionLedger.find({ _id: { $in: originalIds } }).select('_id').lean()).map((r) => String(r._id))
  );
  for (const r of reversals) {
    if (!r.reversalOf) {
      report('reversal', `A reversal for ${r.beneficiaryCode} has no reversalOf pointer.`);
    } else if (!foundOriginals.has(String(r.reversalOf))) {
      report('reversal', `Reversal for ${r.beneficiaryCode} points at ${r.reversalOf}, which does not exist.`);
    }
  }

  // --- Apply repairs --------------------------------------------------------
  if (fix && repairs.length) {
    await Associate.bulkWrite(repairs);
    console.log(`Rewrote ${repairs.length} cached field set(s) from the ledger and tree.\n`);
  }

  // --- Result ---------------------------------------------------------------
  const ledgerCount = await CommissionLedger.countDocuments();
  const paidOut = await CommissionLedger.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]);

  if (!problems.length) {
    console.log('All checks passed — ledger and caches agree.');
    console.log(`  rows: ${ledgerCount}  |  net paid: ${round2(paidOut[0]?.total || 0)}`);
    await mongoose.disconnect();
    return;
  }

  console.log(`${problems.length} problem(s) found:\n`);
  const grouped = problems.reduce((acc, p) => {
    (acc[p.check] ||= []).push(p.detail);
    return acc;
  }, {});
  for (const [check, details] of Object.entries(grouped)) {
    console.log(`[${check}]`);
    details.forEach((d) => console.log(`  - ${d}`));
    console.log('');
  }

  if (!fix && repairs.length) {
    console.log(`Re-run with --fix to rewrite ${repairs.length} income cache(s).`);
    console.log('Carry problems are NOT auto-fixable — they need a human decision.\n');
  }

  await mongoose.disconnect();
  process.exit(1);
};

run().catch(async (err) => {
  console.error('Verification failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
