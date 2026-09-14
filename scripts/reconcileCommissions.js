/**
 * Finds placements whose commission never ran, and settles them.
 *
 *   npm run reconcile:commissions           report only
 *   npm run reconcile:commissions -- --apply settle what it finds
 *
 * This closes the one gap the design deliberately accepts. Commission runs
 * AFTER the placement transaction commits, so a crash, a dropped connection or
 * a thrown error in settle() leaves a member placed with no ledger rows. The
 * placement is correct; only the payout is missing.
 *
 * Run it on a schedule. Every hour is plenty — the window it covers is the few
 * milliseconds between a commit and the settle that follows it.
 *
 * It also reports the inverse failure: carry that moved without a ledger row to
 * explain it, which is what a crash between the $inc and the deduction leaves
 * behind. That one is NOT auto-repaired — see the note at the bottom.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Associate = require('../models/Associate');
const CommissionLedger = require('../models/CommissionLedger');
const { settle } = require('../services/commissionService');
const { ROLES, STATUSES, TREE_STATUSES, TIERS } = require('../config/constants');

const apply = process.argv.includes('--apply');

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  // --- 1. Placed and approved, but never settled ---------------------------
  const eligible = await Associate.find({
    role: ROLES.ASSOCIATE,
    status: STATUSES.APPROVED,
    treeStatus: { $ne: TREE_STATUSES.UNPLACED },
    tier: TIERS.ONE
  })
    .select('memberCode createdAt depth')
    .sort({ createdAt: 1 })
    .lean();

  const settledIds = new Set(
    (await CommissionLedger.find().select('sourceMember').lean()).map((r) => String(r.sourceMember))
  );

  const missing = eligible.filter((m) => !settledIds.has(String(m._id)));

  console.log(`${eligible.length} eligible member(s); ${missing.length} with no ledger rows.\n`);

  if (missing.length) {
    missing.slice(0, 25).forEach((m) =>
      console.log(`  unsettled  ${m.memberCode}  depth ${m.depth}  placed ${m.createdAt.toISOString().slice(0, 10)}`)
    );
    if (missing.length > 25) console.log(`  … and ${missing.length - 25} more`);
    console.log('');
  }

  // --- 2. Carry that should already have paired ----------------------------
  // Both legs holding volume means the engine failed to pair them — the match
  // should have fired the instant the second leg landed.
  const stranded = await Associate.aggregate([
    { $match: { carryLeft: { $gt: 0 }, carryRight: { $gt: 0 } } },
    { $project: { memberCode: 1, carryLeft: 1, carryRight: 1, matchable: { $min: ['$carryLeft', '$carryRight'] } } },
    { $sort: { matchable: -1 } }
  ]);

  if (stranded.length) {
    const total = stranded.reduce((s, m) => s + m.matchable, 0);
    console.log(`${stranded.length} member(s) holding matchable volume on BOTH legs (total ${total}):`);
    stranded.slice(0, 25).forEach((m) =>
      console.log(`  stranded   ${m.memberCode}  L=${m.carryLeft} R=${m.carryRight}  matchable ${m.matchable}`)
    );
    if (stranded.length > 25) console.log(`  … and ${stranded.length - 25} more`);
    console.log('');
  }

  if (!missing.length && !stranded.length) {
    console.log('Nothing to reconcile.');
    await mongoose.disconnect();
    return;
  }

  if (!apply) {
    console.log('Report only. Re-run with --apply to settle the unsettled members.');
    if (stranded.length) {
      console.log(
        '\nStranded carry is NOT settled by --apply. Pairing it would need a ledger row\n' +
          'with no source member to attribute it to, which the schema does not allow and\n' +
          'an audit could not defend. Investigate the members above individually.'
      );
    }
    await mongoose.disconnect();
    process.exit(1);
  }

  let ok = 0;
  let failed = 0;

  for (const member of missing) {
    const result = await settle(member._id, 'reconcile');
    if (result?.error) {
      failed++;
      console.error(`  FAIL  ${member.memberCode}: ${result.error}`);
    } else {
      ok++;
      console.log(`  settled  ${member.memberCode}`);
    }
  }

  console.log(`\nSettled ${ok}, failed ${failed}.`);
  if (stranded.length) {
    console.log(`${stranded.length} member(s) still hold stranded carry — those need a human.`);
  }
  console.log('Run `npm run verify:commissions` to confirm.');

  await mongoose.disconnect();
  if (failed) process.exit(1);
};

run().catch(async (err) => {
  console.error('Reconcile failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
