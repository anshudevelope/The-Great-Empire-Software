/**
 * Seeds five test associates covering every condition the commission engine
 * has to handle.
 *
 *   npm run seed:test           dry run — prints the plan and the expected result
 *   npm run seed:test -- --apply  write it
 *   npm run seed:test -- --undo   remove only what this script created
 *
 * Existing members are left completely alone: nothing is deleted, no carry is
 * reset, and the new members attach to the tree as it already stands.
 *
 * It goes through the real services — createAndPlace / placeExisting, then
 * settle() — rather than writing figures directly, so a run exercises the same
 * code path a registration does. Numbers that come out of it are the engine's,
 * not the script's.
 *
 * Every seeded member is tagged `notes: SEED_TAG` on their referral and given a
 * @seed.test email, which is what --undo keys off.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const Associate = require('../models/Associate');
const Referral = require('../models/Referral');
const CommissionLedger = require('../models/CommissionLedger');
const { createAndPlace, placeExisting } = require('../services/placementService');
const { settle } = require('../services/commissionService');
const { withTransaction } = require('../utils/transaction');
const { nextMemberCode, nextReferralNo, nextInvoiceNo } = require('../utils/codes');
const { encrypt } = require('../utils/secretBox');
const {
  STATUSES,
  TIERS,
  POSITIONS,
  TREE_STATUSES,
  REFERRAL_STATUSES
} = require('../config/constants');

const apply = process.argv.includes('--apply');
const undo = process.argv.includes('--undo');

const SEED_TAG = '[seed:test-associates]';
const SEED_DOMAIN = '@seed.test';
const PASSWORD = 'Test@1234';

/**
 * The five cases. Each names the condition it exists to cover, so a failure
 * points at a behaviour rather than at a row number.
 *
 * `under` is the member code the placement is REQUESTED under. Spillover may
 * land them deeper — which is the point of case 3.
 */
const PLAN = [
  {
    covers: 'Completes the root pair — first matching payout in the system',
    fullName: 'ANITA DESAI',
    gender: 'Female',
    title: 'Mrs.',
    sponsor: 'TGE0001',
    under: 'TGE0001',
    position: POSITIONS.RIGHT,
    amountPaid: 50000,
    status: STATUSES.APPROVED,
    place: true
  },
  {
    covers: 'Matching at a non-root node, and volume flowing up two levels',
    fullName: 'VIKRAM RATHORE',
    gender: 'Male',
    title: 'Mr.',
    sponsor: 'TGE0002',
    under: 'TGE0002',
    position: POSITIONS.RIGHT,
    amountPaid: 50000,
    status: STATUSES.APPROVED,
    place: true
  },
  {
    covers: 'Spillover — sponsor TGE0001 but the left leg is full, so they land deeper. sponsor !== parent',
    fullName: 'MEENA KUMARI',
    gender: 'Female',
    title: 'Ms.',
    sponsor: 'TGE0001',
    under: 'TGE0001',
    position: POSITIONS.LEFT,
    amountPaid: 50000,
    status: STATUSES.APPROVED,
    place: true
  },
  {
    covers: 'Partial payment — 25,000 pays a 2,500 direct and contributes 25,000 of volume, not 50,000',
    fullName: 'RAJESH IYER',
    gender: 'Male',
    title: 'Mr.',
    sponsor: 'TGE0003',
    under: 'TGE0003',
    position: POSITIONS.RIGHT,
    amountPaid: 25000,
    status: STATUSES.APPROVED,
    place: true
  },
  {
    covers: 'Pending and unplaced — referral raised but NO commission until approved and placed',
    fullName: 'SUNITA PATEL',
    gender: 'Female',
    title: 'Mrs.',
    sponsor: 'TGE0001',
    under: null,
    position: null,
    amountPaid: 50000,
    status: STATUSES.PENDING,
    place: false
  }
];

const slug = (name) => name.toLowerCase().replace(/[^a-z]+/g, '.');

const showTree = async (label) => {
  const all = await Associate.find({ memberCode: { $exists: true } })
    .select('memberCode fullName status treeStatus position depth sponsorMemberCode parentId carryLeft carryRight totalLeftVolume totalRightVolume directIncome matchingIncome')
    .sort({ memberCode: 1 })
    .lean();

  const byId = new Map(all.map((a) => [String(a._id), a]));

  console.log(`\n${label}`);
  console.log('code     depth parent   pos    status    carry L/R            volume L/R           direct  matching');
  console.log('-'.repeat(104));
  for (const a of all) {
    const parent = a.parentId ? byId.get(String(a.parentId))?.memberCode || '?' : '-';
    console.log(
      `${a.memberCode.padEnd(8)} ${String(a.depth).padEnd(5)} ${parent.padEnd(8)} ` +
        `${(a.position || '-').padEnd(6)} ${a.status.padEnd(9)} ` +
        `${String(a.carryLeft || 0).padStart(8)}/${String(a.carryRight || 0).padEnd(10)} ` +
        `${String(a.totalLeftVolume || 0).padStart(8)}/${String(a.totalRightVolume || 0).padEnd(10)} ` +
        `${String(a.directIncome || 0).padStart(7)} ${String(a.matchingIncome || 0).padStart(9)}`
    );
  }
};

const runUndo = async () => {
  const seeded = await Associate.find({ email: new RegExp(`${SEED_DOMAIN}$`) }).select('_id memberCode parentId position').lean();
  if (!seeded.length) {
    console.log('No seeded associates found — nothing to undo.');
    return;
  }

  const ids = seeded.map((s) => s._id);
  console.log(`Removing ${seeded.length} seeded associate(s): ${seeded.map((s) => s.memberCode).join(', ')}\n`);

  if (!apply) {
    console.log('Dry run. Re-run with --undo --apply to actually remove them.');
    return;
  }

  // Anything below a seeded member would be orphaned by removing it.
  const hasDescendants = await Associate.countDocuments({ ancestors: { $in: ids }, _id: { $nin: ids } });
  if (hasDescendants) {
    console.error(
      `REFUSED: ${hasDescendants} non-seeded member(s) sit beneath a seeded one. ` +
        'Removing them would orphan real records. Move those members first.'
    );
    process.exitCode = 1;
    return;
  }

  // Detach from parents so no live member keeps a pointer at a deleted node.
  for (const s of seeded) {
    if (!s.parentId) continue;
    const field = s.position === POSITIONS.LEFT ? 'leftChild' : 'rightChild';
    await Associate.updateOne({ _id: s.parentId, [field]: s._id }, { [field]: null });
  }

  // Reverse the carry and volume those members put into their uplines, so the
  // tree is left as it was rather than holding phantom balances.
  const ledgerRows = await CommissionLedger.find({ sourceMember: { $in: ids } }).lean();
  for (const row of ledgerRows) {
    const field = row.type === 'direct' ? 'directIncome' : 'matchingIncome';
    await Associate.updateOne({ _id: row.beneficiary }, { $inc: { [field]: -row.amount } });
  }

  const { deletedCount } = await Associate.deleteMany({ _id: { $in: ids } });
  const refs = await Referral.deleteMany({ member: { $in: ids } });
  const led = await CommissionLedger.deleteMany({ sourceMember: { $in: ids } });

  console.log(`Deleted ${deletedCount} associate(s), ${refs.deletedCount} referral(s), ${led.deletedCount} ledger row(s).`);
  console.log('\nCarry on surviving members is NOT recomputed — run:');
  console.log('  npm run verify:commissions -- --fix');
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to "${mongoose.connection.name}"${apply ? '  [--apply]' : '  [DRY RUN]'}\n`);

  if (undo) {
    await runUndo();
    await mongoose.disconnect();
    return;
  }

  const existing = await Associate.countDocuments({ email: new RegExp(`${SEED_DOMAIN}$`) });
  if (existing) {
    console.error(`${existing} seeded associate(s) already exist. Run with --undo --apply first.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  await showTree('BEFORE');

  console.log('\nPlan:');
  PLAN.forEach((p, i) => {
    const where = p.place ? `${p.position} of ${p.under}` : 'unplaced';
    console.log(`  ${i + 1}. ${p.fullName.padEnd(16)} ${String(p.amountPaid).padStart(6)}  ${where.padEnd(18)} ${p.status}`);
    console.log(`     ${p.covers}`);
  });

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  const hash = await bcrypt.hash(PASSWORD, await bcrypt.genSalt(10));
  const credentials = { password: hash, passwordEnc: encrypt(PASSWORD) };

  console.log('\nCreating…');

  // A 900000xxxx block no real Indian mobile uses, offset by run time so a
  // re-seed after --undo does not collide with a phone still held elsewhere.
  const phoneBase = 9000000000 + (Math.floor(Date.now() / 1000) % 100000) * 10;

  for (const [i, spec] of PLAN.entries()) {
    const sponsor = await Associate.findOne({ memberCode: spec.sponsor }).select('_id memberCode').lean();
    if (!sponsor) throw new Error(`Sponsor ${spec.sponsor} not found.`);

    const under = spec.under
      ? await Associate.findOne({ memberCode: spec.under }).select('_id memberCode').lean()
      : null;

    const memberCode = await nextMemberCode();
    const referralNo = await nextReferralNo();
    const invoiceNo = await nextInvoiceNo();

    const { member, parent } = await withTransaction(async (session) => {
      const created = await createAndPlace(
        {
          memberData: {
            ...credentials,
            memberCode,
            title: spec.title,
            fullName: spec.fullName,
            gender: spec.gender,
            phone: String(phoneBase + i),
            email: `${slug(spec.fullName)}${SEED_DOMAIN}`,
            country: 'India',
            state: 'Uttar Pradesh',
            tier: TIERS.ONE,
            status: spec.status,
            treeStatus: TREE_STATUSES.UNPLACED,
            referredBy: sponsor._id,
            referredByCode: sponsor.memberCode,
            sponsorId: sponsor._id,
            sponsorMemberCode: sponsor.memberCode
          },
          requestedParentId: spec.place ? under._id : null,
          position: spec.position
        },
        session
      );

      await Associate.findByIdAndUpdate(sponsor._id, { $inc: { directCount: 1 } }, { session });

      const placedUnder = created.parentId
        ? await Associate.findById(created.parentId).select('memberCode').session(session)
        : null;

      await Referral.create(
        [
          {
            referralNo,
            invoiceNo,
            amountPaid: spec.amountPaid,
            paymentMode: 'Cash',
            receivedOn: new Date(),
            tier: TIERS.ONE,
            member: created._id,
            memberCode,
            memberName: spec.fullName,
            issuedTo: sponsor._id,
            issuedToCode: sponsor.memberCode,
            issuedBy: sponsor._id,
            notes: SEED_TAG,
            ...(placedUnder && {
              status: REFERRAL_STATUSES.USED,
              usedAt: new Date(),
              placedBy: 'admin',
              placedPosition: spec.position,
              placedUnderCode: placedUnder.memberCode
            })
          }
        ],
        { session }
      );

      return { member: created, parent: placedUnder };
    });

    // The same call the controllers make, after the transaction commits.
    const result = spec.place ? await settle(member._id, 'seed') : null;

    const spill = parent && String(parent._id) !== String(under?._id);
    const rows = result ? (result.direct ? 1 : 0) + (result.matching?.length || 0) : 0;

    console.log(
      `  ${memberCode}  ${spec.fullName.padEnd(16)} ` +
        (spec.place ? `under ${parent.memberCode}${spill ? ' (SPILLOVER)' : ''} ${spec.position}` : 'unplaced') +
        `  ${rows} ledger row(s)`
    );
  }

  await showTree('AFTER');

  const totals = await CommissionLedger.aggregate([
    { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } }
  ]);
  console.log('\nLedger:');
  totals.forEach((t) => console.log(`  ${String(t._id).padEnd(9)} ${String(t.count).padStart(3)} row(s)  ${t.total}`));

  console.log('\nNext: npm run verify:commissions');
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('\nSeed failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
