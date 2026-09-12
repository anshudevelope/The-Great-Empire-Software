/**
 * One-time: fills Associate.referredBy (who paid) for members created before
 * the field existed.
 *
 *   node scripts/backfillReferredBy.js          # dry run — prints the plan, writes nothing
 *   node scripts/backfillReferredBy.js --apply  # saves a backup, then writes
 *
 * Source, per member: their live referral's issuedTo (the payer on the invoice),
 * otherwise their current sponsor — until now the two were always the same
 * person. Only members whose referredBy is empty are touched, and only the two
 * referredBy fields are set: sponsor, tree position and counts are never
 * changed. Safe to re-run.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const associates = db.collection('associates');

  const members = await associates
    .find(
      { role: 'associate' },
      { projection: { memberCode: 1, sponsorId: 1, sponsorMemberCode: 1, referredBy: 1, referredByCode: 1 } }
    )
    .sort({ memberCode: 1 })
    .toArray();

  const referrals = await db
    .collection('referrals')
    .find({ status: { $in: ['unused', 'used'] } }, { projection: { member: 1, issuedTo: 1, issuedToCode: 1 } })
    .toArray();
  const referralByMember = new Map(referrals.map((r) => [String(r.member), r]));

  const plan = [];
  for (const m of members) {
    if (m.referredBy) continue; // already set — never overwritten
    const ref = referralByMember.get(String(m._id));
    const referredBy = ref ? ref.issuedTo : m.sponsorId;
    const referredByCode = ref ? ref.issuedToCode : m.sponsorMemberCode;
    if (!referredBy) continue; // the tree root, or never sponsored — nothing to fill
    plan.push({
      _id: m._id,
      memberCode: m.memberCode,
      referredBy,
      referredByCode,
      source: ref ? 'referral' : 'sponsor',
      matchesSponsor: String(referredBy) === String(m.sponsorId)
    });
  }

  console.log(`Associates: ${members.length} | to fill: ${plan.length} | already set: ${members.filter((m) => m.referredBy).length}\n`);
  if (plan.length) {
    console.table(plan.map(({ memberCode, referredByCode, source, matchesSponsor }) => ({ memberCode, referredByCode, source, matchesSponsor })));
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to write.');
    await mongoose.disconnect();
    return;
  }
  if (!plan.length) {
    console.log('\nNothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Backup of every associate's referral/sponsor fields before writing.
  const backupDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `referredBy-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(members, null, 2));
  console.log(`\nBackup written: ${backupFile}`);

  const result = await associates.bulkWrite(
    plan.map((p) => ({
      updateOne: {
        // Conditional: never overwrite a value set in the meantime.
        filter: { _id: p._id, $or: [{ referredBy: null }, { referredBy: { $exists: false } }] },
        update: { $set: { referredBy: p.referredBy, referredByCode: p.referredByCode || null } }
      }
    }))
  );
  console.log(`Updated: ${result.modifiedCount} of ${plan.length}`);
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('Backfill failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
