/**
 * Seeds commission dated across two windows so two payouts can be generated:
 * the 1st–10th of this month, and the 11th–20th.
 *
 *   npm run seed:periods            dry run — prints the plan
 *   npm run seed:periods -- --apply write it
 *   npm run seed:periods -- --undo --apply  remove only what this created
 *
 * Members are created and placed through the real services, so the tree, carry
 * and matching are all genuine. The ledger rows they produce are then BACKDATED
 * into the target window — that is the only artificial part, and it is the
 * whole point: commission normally lands at the moment of placement, which
 * would put every row on today's date and make period testing impossible.
 *
 * Existing members are untouched.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const Associate = require('../models/Associate');
const Referral = require('../models/Referral');
const CommissionLedger = require('../models/CommissionLedger');
const { createAndPlace } = require('../services/placementService');
const { settle } = require('../services/commissionService');
const { withTransaction } = require('../utils/transaction');
const { nextMemberCode, nextReferralNo, nextInvoiceNo } = require('../utils/codes');
const { encrypt } = require('../utils/secretBox');
const { STATUSES, TIERS, POSITIONS, TREE_STATUSES, REFERRAL_STATUSES } = require('../config/constants');

const apply = process.argv.includes('--apply');
const undo = process.argv.includes('--undo');
// Re-apply the dates to members that already exist, without recreating them.
const redate = process.argv.includes('--redate');

/**
 * Backdate a record, going around Mongoose.
 *
 * `timestamps` makes `createdAt` IMMUTABLE by default, so a normal
 * `$set: { createdAt }` is dropped in silence — no error, and modifiedCount
 * comes back undefined. The native driver has no such notion, which is exactly
 * what is wanted here: commission always lands "now", and period testing needs
 * rows spread across the month.
 */
const backdate = async (Model, filter, fields) => {
  const res = await Model.collection.updateMany(filter, { $set: fields });
  return res.modifiedCount;
};

const SEED_DOMAIN = '@period.test';
const PASSWORD = 'Test@1234';
const AMOUNT = 50000;

// This month, so the windows line up with whatever "now" is.
const now = new Date();
const Y = now.getFullYear();
const M = now.getMonth();
/** Midday local, so no timezone shift can push a row into the wrong day. */
const on = (day) => new Date(Y, M, day, 12, 0, 0, 0);

/**
 * `under` is the requested parent. Spillover may place them deeper, which is
 * fine — the volume still flows up the same legs.
 */
const PLAN = [
  // --- window one: 1st – 10th -------------------------------------------
  { day: 3, name: 'ARJUN MEHTA', sponsor: 'TGE0002', under: 'TGE0002', position: POSITIONS.RIGHT },
  { day: 5, name: 'NEHA SHARMA', sponsor: 'TGE0003', under: 'TGE0003', position: POSITIONS.LEFT },
  { day: 7, name: 'ROHIT VERMA', sponsor: 'TGE0004', under: 'TGE0004', position: POSITIONS.LEFT },
  { day: 9, name: 'KAVITA NAIR', sponsor: 'TGE0005', under: 'TGE0005', position: POSITIONS.RIGHT },

  // --- window two: 11th – 20th ------------------------------------------
  { day: 12, name: 'SANJAY GUPTA', sponsor: 'TGE0004', under: 'TGE0004', position: POSITIONS.RIGHT },
  { day: 14, name: 'PRIYA RAO', sponsor: 'TGE0005', under: 'TGE0005', position: POSITIONS.LEFT },
  { day: 16, name: 'IMRAN KHAN', sponsor: 'TGE0002', under: 'TGE0006', position: POSITIONS.LEFT },
  { day: 18, name: 'DIVYA MENON', sponsor: 'TGE0003', under: 'TGE0007', position: POSITIONS.RIGHT },
];

const slug = (name) => name.toLowerCase().replace(/[^a-z]+/g, '.');
const d10 = (date) => date.toISOString().slice(0, 10);

/** Everything one placement produced, moved onto the target date. */
const applyDates = async (memberId, when) => {
  const rows = await backdate(CommissionLedger, { sourceMember: memberId }, { createdAt: when });
  await backdate(Associate, { _id: memberId }, { createdAt: when });
  await backdate(Referral, { member: memberId }, { createdAt: when, receivedOn: when, usedAt: when });
  return rows;
};

/** Unpaid commission sitting inside a window — what a payout there would pay. */
const summarise = async (from, to) => {
  const rows = await CommissionLedger.aggregate([
    { $match: { payoutBatch: null, createdAt: { $gte: from, $lte: to } } },
    { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.total]));
  return {
    gross: rows.reduce((s, r) => s + r.total, 0),
    direct: by.direct || 0,
    matching: by.matching || 0,
    rows: rows.reduce((s, r) => s + r.count, 0),
  };
};

const report = async () => {
  const a = await summarise(on(1), new Date(Y, M, 10, 23, 59, 59, 999));
  const b = await summarise(on(11), new Date(Y, M, 20, 23, 59, 59, 999));
  console.log('\nUnpaid commission now available:');
  console.log(`  ${d10(on(1))} → ${d10(on(10))}   gross ${a.gross}  (direct ${a.direct} + matching ${a.matching})  ${a.rows} rows`);
  console.log(`  ${d10(on(11))} → ${d10(on(20))}  gross ${b.gross}  (direct ${b.direct} + matching ${b.matching})  ${b.rows} rows`);
  console.log('\nIn Create Payout: set start to the 1st and close to the 10th, finalize,');
  console.log('then the next start defaults to the 11th — close that one on the 20th.');
};

const runRedate = async () => {
  const seeded = await Associate.find({ email: new RegExp(`${SEED_DOMAIN}$`) })
    .select('_id memberCode fullName email')
    .lean();

  if (!seeded.length) {
    console.log('Nothing seeded yet — run with --apply first.');
    return;
  }

  const dayFor = new Map(PLAN.map((p) => [`${slug(p.name)}${SEED_DOMAIN}`, p.day]));
  console.log(`Re-dating ${seeded.length} seeded member(s)…\n`);

  for (const s of seeded) {
    const day = dayFor.get(s.email);
    if (!day) {
      console.log(`  skip  ${s.memberCode}  ${s.fullName} — not in the plan`);
      continue;
    }
    if (!apply) {
      console.log(`  ${d10(on(day))}  ${s.memberCode}  ${s.fullName}`);
      continue;
    }
    const rows = await applyDates(s._id, on(day));
    console.log(`  ${d10(on(day))}  ${s.memberCode}  ${s.fullName.padEnd(14)} ${rows} ledger row(s) dated`);
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --redate --apply.');
    return;
  }
  await report();
};

const runUndo = async () => {
  const seeded = await Associate.find({ email: new RegExp(`${SEED_DOMAIN}$`) })
    .select('_id memberCode parentId position')
    .lean();

  if (!seeded.length) {
    console.log('No seeded associates found — nothing to undo.');
    return;
  }

  const ids = seeded.map((s) => s._id);
  console.log(`Removing ${seeded.length}: ${seeded.map((s) => s.memberCode).join(', ')}\n`);

  if (!apply) {
    console.log('Dry run. Re-run with --undo --apply to remove them.');
    return;
  }

  const outsiders = await Associate.countDocuments({ ancestors: { $in: ids }, _id: { $nin: ids } });
  if (outsiders) {
    console.error(
      `REFUSED: ${outsiders} non-seeded member(s) sit beneath a seeded one. Removing these would orphan them.`
    );
    process.exitCode = 1;
    return;
  }

  // Take back the volume and income they pushed up the tree, so the members
  // left behind are as they were.
  for (const row of await CommissionLedger.find({ sourceMember: { $in: ids } }).lean()) {
    const field = row.type === 'matching' ? 'matchingIncome' : 'directIncome';
    await Associate.updateOne({ _id: row.beneficiary }, { $inc: { [field]: -row.amount } });
  }

  for (const s of seeded) {
    if (!s.parentId) continue;
    const field = s.position === POSITIONS.LEFT ? 'leftChild' : 'rightChild';
    await Associate.updateOne({ _id: s.parentId, [field]: s._id }, { [field]: null });
  }

  const a = await Associate.deleteMany({ _id: { $in: ids } });
  const r = await Referral.deleteMany({ member: { $in: ids } });
  const l = await CommissionLedger.deleteMany({ sourceMember: { $in: ids } });
  console.log(`Deleted ${a.deletedCount} associate(s), ${r.deletedCount} referral(s), ${l.deletedCount} ledger row(s).`);
  console.log('\nCarry is NOT recomputed — run: npm run verify:commissions -- --fix');
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to "${mongoose.connection.name}"${apply ? '  [--apply]' : '  [DRY RUN]'}\n`);

  if (undo) {
    await runUndo();
    await mongoose.disconnect();
    return;
  }

  if (redate) {
    await runRedate();
    await mongoose.disconnect();
    return;
  }

  if (await Associate.countDocuments({ email: new RegExp(`${SEED_DOMAIN}$`) })) {
    console.error('Already seeded. Run with --undo --apply first.');
    await mongoose.disconnect();
    process.exit(1);
  }

  const w1 = PLAN.filter((p) => p.day <= 10);
  const w2 = PLAN.filter((p) => p.day > 10);
  console.log(`Window 1 — ${d10(on(1))} to ${d10(on(10))}`);
  w1.forEach((p) => console.log(`   ${d10(on(p.day))}  ${p.name.padEnd(14)} ${p.position} of ${p.under}, sponsored by ${p.sponsor}`));
  console.log(`\nWindow 2 — ${d10(on(11))} to ${d10(on(20))}`);
  w2.forEach((p) => console.log(`   ${d10(on(p.day))}  ${p.name.padEnd(14)} ${p.position} of ${p.under}, sponsored by ${p.sponsor}`));
  console.log(`\nEach pays ${AMOUNT}. Every member must already exist as a parent/sponsor.`);

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  const creds = { password: await bcrypt.hash(PASSWORD, await bcrypt.genSalt(10)), passwordEnc: encrypt(PASSWORD) };
  const phoneBase = 9100000000 + (Math.floor(Date.now() / 1000) % 100000) * 10;

  console.log('\nCreating…');
  for (const [i, spec] of PLAN.entries()) {
    const sponsor = await Associate.findOne({ memberCode: spec.sponsor }).select('_id memberCode').lean();
    const under = await Associate.findOne({ memberCode: spec.under }).select('_id memberCode').lean();
    if (!sponsor || !under) throw new Error(`${spec.sponsor} or ${spec.under} not found — tree changed?`);

    const when = on(spec.day);
    const memberCode = await nextMemberCode();
    const referralNo = await nextReferralNo();
    const invoiceNo = await nextInvoiceNo();

    const { member, parent } = await withTransaction(async (session) => {
      const created = await createAndPlace(
        {
          memberData: {
            ...creds,
            memberCode,
            title: 'Mr.',
            fullName: spec.name,
            gender: 'Male',
            phone: String(phoneBase + i),
            email: `${slug(spec.name)}${SEED_DOMAIN}`,
            country: 'India',
            state: 'Uttar Pradesh',
            tier: TIERS.ONE,
            status: STATUSES.APPROVED,
            treeStatus: TREE_STATUSES.UNPLACED,
            referredBy: sponsor._id,
            referredByCode: sponsor.memberCode,
            sponsorId: sponsor._id,
            sponsorMemberCode: sponsor.memberCode,
          },
          requestedParentId: under._id,
          position: spec.position,
        },
        session
      );

      await Associate.findByIdAndUpdate(sponsor._id, { $inc: { directCount: 1 } }, { session });
      const placedUnder = await Associate.findById(created.parentId).select('memberCode').session(session);

      await Referral.create(
        [
          {
            referralNo,
            invoiceNo,
            amountPaid: AMOUNT,
            paymentMode: 'Cash',
            receivedOn: when,
            tier: TIERS.ONE,
            member: created._id,
            memberCode,
            memberName: spec.name,
            issuedTo: sponsor._id,
            issuedToCode: sponsor.memberCode,
            issuedBy: sponsor._id,
            notes: '[seed:payout-periods]',
            status: REFERRAL_STATUSES.USED,
            usedAt: when,
            placedBy: 'admin',
            placedPosition: spec.position,
            placedUnderCode: placedUnder.memberCode,
          },
        ],
        { session }
      );

      return { member: created, parent: placedUnder };
    });

    await settle(member._id, 'seed:periods');

    const dated = await applyDates(member._id, when);

    const spill = String(parent._id) !== String(under._id);
    console.log(
      `  ${d10(when)}  ${memberCode}  ${spec.name.padEnd(14)} under ${parent.memberCode}${spill ? ' (spillover)' : ''}  ${dated} ledger row(s) dated`
    );
  }

  await report();
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('\nSeed failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
