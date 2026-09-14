/**
 * Replay commission for members placed before the engine existed.
 *
 *   npm run backfill:commissions -- --dry     report what would be paid
 *   npm run backfill:commissions -- --apply   write it
 *
 * Safe to re-run. Every write goes through commissionService, whose
 * idempotencyKey unique index turns a repeat into a no-op — so a run that dies
 * halfway can simply be run again.
 *
 * ORDER MATTERS. Matching is a running balance: a member only pays a match when
 * a counterpart has already landed on the other leg. Replaying members in the
 * wrong order produces different intermediate carry and therefore a different
 * set of matching rows. Members are processed in PLACEMENT order (createdAt),
 * which is the closest reconstruction of how the tree actually filled.
 *
 * Carry is NOT reset first. If carry already holds values from a partial run,
 * clear it deliberately with --reset-carry — and understand that doing so on a
 * live system discards balances members can see in their portal.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Associate = require('../models/Associate');
const Referral = require('../models/Referral');
const CommissionLedger = require('../models/CommissionLedger');
const { onPlacement } = require('../services/commissionService');
const { ROLES, STATUSES, TREE_STATUSES, TIERS, REFERRAL_STATUSES } = require('../config/constants');

const apply = process.argv.includes('--apply');
const resetCarry = process.argv.includes('--reset-carry');

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  if (!apply) {
    console.log('DRY RUN — nothing will be written. Re-run with --apply to commit.\n');
  }

  // Placement order. createdAt is a proxy: a member created early but placed
  // late will replay out of order, which changes WHICH pairing each match is
  // attributed to, though not any member's lifetime total on a balanced tree.
  const candidates = await Associate.find({
    role: ROLES.ASSOCIATE,
    status: STATUSES.APPROVED,
    treeStatus: { $ne: TREE_STATUSES.UNPLACED },
    tier: TIERS.ONE
  })
    .select('memberCode createdAt depth')
    .sort({ createdAt: 1 })
    .lean();

  console.log(`${candidates.length} placed, approved Tier I associate(s) in placement order.\n`);

  const alreadyPaid = new Set(
    (await CommissionLedger.find().select('sourceMember').lean()).map((r) => String(r.sourceMember))
  );

  const pending = candidates.filter((c) => !alreadyPaid.has(String(c._id)));
  console.log(`  ${alreadyPaid.size} already have ledger rows`);
  console.log(`  ${pending.length} to replay\n`);

  if (!pending.length) {
    console.log('Nothing to backfill.');
    await mongoose.disconnect();
    return;
  }

  // Projected outflow, so the size of the commitment is visible BEFORE it is
  // written rather than discovered afterwards.
  const bases = await Referral.aggregate([
    {
      $match: {
        member: { $in: pending.map((p) => p._id) },
        status: { $in: [REFERRAL_STATUSES.UNUSED, REFERRAL_STATUSES.USED] }
      }
    },
    { $group: { _id: null, total: { $sum: '$amountPaid' }, count: { $sum: 1 } } }
  ]);
  const inflow = bases[0]?.total || 0;
  const projected = pending.reduce((sum, p) => sum + 5000 + 1250 * (p.depth || 0), 0);

  console.log(`Base volume behind these members : ${inflow}`);
  console.log(`Projected payout (5,000 + 1,250 x depth) : ~${projected}`);
  console.log(`  ratio : ~${inflow > 0 ? Math.round((projected / inflow) * 1000) / 10 : 0}% of collections\n`);

  if (!apply) {
    console.log('Members that would be replayed (first 20):');
    pending.slice(0, 20).forEach((p) => console.log(`  ${p.memberCode}  depth ${p.depth}`));
    if (pending.length > 20) console.log(`  … and ${pending.length - 20} more`);
    await mongoose.disconnect();
    return;
  }

  if (resetCarry) {
    const { modifiedCount } = await Associate.updateMany(
      { role: ROLES.ASSOCIATE },
      { $set: { carryLeft: 0, carryRight: 0, totalLeftVolume: 0, totalRightVolume: 0 } }
    );
    console.log(`Reset carry and volume on ${modifiedCount} associate(s).\n`);
  }

  let settled = 0;
  let skipped = 0;
  let failed = 0;

  for (const member of pending) {
    try {
      const result = await onPlacement(member._id);
      if (result.skipped) {
        skipped++;
        console.log(`  skip  ${member.memberCode}  (${result.skipped})`);
      } else {
        settled++;
        const rows = (result.direct ? 1 : 0) + (result.matching?.length || 0);
        console.log(`  ok    ${member.memberCode}  depth ${member.depth}  ${rows} row(s)`);
      }
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${member.memberCode}: ${err.message}`);
    }
  }

  const paid = await CommissionLedger.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]);

  console.log(`\nsettled ${settled}  |  skipped ${skipped}  |  failed ${failed}`);
  console.log(`Ledger net total is now ${Math.round((paid[0]?.total || 0) * 100) / 100}`);
  console.log('\nRun `npm run verify:commissions` to confirm the caches agree.');

  await mongoose.disconnect();
  if (failed) process.exit(1);
};

run().catch(async (err) => {
  console.error('Backfill failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
