/**
 * Seeds five associates so an empty database has enough in it to review the UI.
 *
 *   npm run seed:demo             dry run — prints the plan, writes nothing
 *   npm run seed:demo -- --apply  write it
 *   npm run seed:demo -- --undo --apply   remove only what this script created
 *
 * This differs from seed:test in one way that matters: seed:test assumes a tree
 * already exists and hangs five members off TGE0001-0003. This one BUILDS the
 * tree, root included, so it works against a database with nothing in it.
 *
 * Like seed:test it goes through createAndPlace() and settle() rather than
 * writing figures directly, so the carry, volume and ledger rows the UI renders
 * are the engine's own output and not numbers invented here.
 *
 * Everything it creates is tagged with a @demo.seed email and `notes: SEED_TAG`
 * on the referral, which is what --undo keys off. It refuses to touch anything
 * else.
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
const {
  STATUSES,
  TIERS,
  POSITIONS,
  TREE_STATUSES,
  REFERRAL_STATUSES
} = require('../config/constants');

const apply = process.argv.includes('--apply');
const undo = process.argv.includes('--undo');

const SEED_TAG = '[seed:demo]';
const SEED_DOMAIN = '@demo.seed';
const PASSWORD = 'Demo@1234';

/**
 * Five members shaped to light up every screen rather than to exercise the
 * engine's edge cases — that is seed:test's job.
 *
 *        TGE0001  (root, Tier I)
 *        /      \
 *   TGE0002    TGE0003
 *      /
 * TGE0004
 *
 * TGE0005 is left pending and unplaced, so the dashboard has a non-zero
 * "Pending Approval" count and Place Members has something waiting in it.
 *
 * `sponsorIndex` refers to an earlier entry in this list; the root has none.
 */
const PLAN = [
  {
    fullName: 'ARJUN MEHTA',
    gender: 'Male',
    title: 'Mr.',
    state: 'Uttar Pradesh',
    sponsorIndex: null,
    underIndex: null,
    position: null,
    amountPaid: 50000,
    tier: TIERS.ONE,
    status: STATUSES.APPROVED,
    place: true,
    note: 'Tree root'
  },
  {
    fullName: 'PRIYA SHARMA',
    gender: 'Female',
    title: 'Mrs.',
    state: 'Delhi',
    sponsorIndex: 0,
    underIndex: 0,
    position: POSITIONS.LEFT,
    amountPaid: 50000,
    tier: TIERS.ONE,
    status: STATUSES.APPROVED,
    place: true,
    note: 'Left leg of the root — pays the root a direct commission'
  },
  {
    fullName: 'RAHUL VERMA',
    gender: 'Male',
    title: 'Mr.',
    state: 'Maharashtra',
    sponsorIndex: 0,
    underIndex: 0,
    position: POSITIONS.RIGHT,
    amountPaid: 50000,
    tier: TIERS.ONE,
    status: STATUSES.APPROVED,
    place: true,
    note: 'Completes the root pair — first matching payout appears here'
  },
  {
    fullName: 'KAVYA NAIR',
    gender: 'Female',
    title: 'Ms.',
    state: 'Kerala',
    sponsorIndex: 1,
    underIndex: 1,
    position: POSITIONS.LEFT,
    amountPaid: 25000,
    tier: TIERS.ONE,
    status: STATUSES.APPROVED,
    place: true,
    note: 'Depth 2, part payment — gives the tree view a third level'
  },
  {
    fullName: 'SANJAY GUPTA',
    gender: 'Male',
    title: 'Mr.',
    state: 'Rajasthan',
    sponsorIndex: 0,
    underIndex: null,
    position: null,
    amountPaid: 50000,
    tier: TIERS.ONE,
    status: STATUSES.PENDING,
    place: false,
    note: 'Pending and unplaced — fills the Pending / Place Members states'
  }
];

const slug = (name) => name.toLowerCase().replace(/[^a-z]+/g, '.');

const showTree = async (label) => {
  const all = await Associate.find({ memberCode: { $exists: true } })
    .select('memberCode fullName status treeStatus position depth parentId carryLeft carryRight totalLeftVolume totalRightVolume directIncome matchingIncome')
    .sort({ memberCode: 1 })
    .lean();

  if (!all.length) {
    console.log(`\n${label}\n  (no members)`);
    return;
  }

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
  const seeded = await Associate.find({ email: new RegExp(`${SEED_DOMAIN}$`) })
    .select('_id memberCode parentId position')
    .lean();

  if (!seeded.length) {
    console.log('No demo associates found — nothing to undo.');
    return;
  }

  const ids = seeded.map((s) => s._id);
  console.log(`Removing ${seeded.length} demo associate(s): ${seeded.map((s) => s.memberCode).join(', ')}\n`);

  if (!apply) {
    console.log('Dry run. Re-run with --undo --apply to actually remove them.');
    return;
  }

  // Anything below a demo member that this script did not create would be
  // orphaned by the delete, so refuse rather than damage real records.
  const hasDescendants = await Associate.countDocuments({ ancestors: { $in: ids }, _id: { $nin: ids } });
  if (hasDescendants) {
    console.error(
      `REFUSED: ${hasDescendants} non-demo member(s) sit beneath a demo one. ` +
        'Removing them would orphan real records. Move those members first.'
    );
    process.exitCode = 1;
    return;
  }

  for (const s of seeded) {
    if (!s.parentId) continue;
    const field = s.position === POSITIONS.LEFT ? 'leftChild' : 'rightChild';
    await Associate.updateOne({ _id: s.parentId, [field]: s._id }, { [field]: null });
  }

  // Reverse the income these members paid into their uplines, so no surviving
  // member is left holding a phantom balance.
  const ledgerRows = await CommissionLedger.find({ sourceMember: { $in: ids } }).lean();
  for (const row of ledgerRows) {
    const field = row.type === 'direct' ? 'directIncome' : 'matchingIncome';
    await Associate.updateOne({ _id: row.beneficiary }, { $inc: { [field]: -row.amount } });
  }

  const { deletedCount } = await Associate.deleteMany({ _id: { $in: ids } });
  const refs = await Referral.deleteMany({ member: { $in: ids } });
  const led = await CommissionLedger.deleteMany({ sourceMember: { $in: ids } });

  console.log(`Deleted ${deletedCount} associate(s), ${refs.deletedCount} referral(s), ${led.deletedCount} ledger row(s).`);
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
    console.error(`${existing} demo associate(s) already exist. Run with --undo --apply first.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // Only the root may be created without a parent. If the tree already has one,
  // this script's plan does not apply — seed:test is the right tool then.
  const rootExists = await Associate.countDocuments({ memberCode: { $exists: true }, depth: 0 });
  if (rootExists) {
    console.error(
      `This database already has a tree root. seedDemoData builds a tree from empty; ` +
        'use `npm run seed:test` to add members to an existing tree.'
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  await showTree('BEFORE');

  console.log('\nPlan:');
  PLAN.forEach((p, i) => {
    const where = p.place
      ? p.underIndex === null
        ? 'root'
        : `${p.position} of #${p.underIndex + 1}`
      : 'unplaced';
    console.log(`  ${i + 1}. ${p.fullName.padEnd(16)} ${String(p.amountPaid).padStart(6)}  ${where.padEnd(16)} ${p.status}`);
    console.log(`     ${p.note}`);
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

  // Filled as we go, so later entries can point at earlier ones by index.
  const created = [];

  for (const [i, spec] of PLAN.entries()) {
    const sponsor = spec.sponsorIndex === null ? null : created[spec.sponsorIndex];
    const under = spec.underIndex === null ? null : created[spec.underIndex];

    const memberCode = await nextMemberCode();
    const referralNo = await nextReferralNo();
    const invoiceNo = await nextInvoiceNo();

    const { member, parent } = await withTransaction(async (session) => {
      const madeMember = await createAndPlace(
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
            state: spec.state,
            tier: spec.tier,
            status: spec.status,
            // The root has no parent but is still in the tree; everyone else
            // starts unplaced and is placed by createAndPlace.
            treeStatus: spec.place && !under ? TREE_STATUSES.PLACED : TREE_STATUSES.UNPLACED,
            ...(sponsor && {
              referredBy: sponsor._id,
              referredByCode: sponsor.memberCode,
              sponsorId: sponsor._id,
              sponsorMemberCode: sponsor.memberCode
            })
          },
          requestedParentId: under ? under._id : null,
          position: spec.position
        },
        session
      );

      if (sponsor) {
        await Associate.findByIdAndUpdate(sponsor._id, { $inc: { directCount: 1 } }, { session });
      }

      const placedUnder = madeMember.parentId
        ? await Associate.findById(madeMember.parentId).select('memberCode').session(session)
        : null;

      // The root was not referred by anyone, so it has no referral or invoice.
      if (sponsor) {
        await Referral.create(
          [
            {
              referralNo,
              invoiceNo,
              amountPaid: spec.amountPaid,
              paymentMode: 'Cash',
              receivedOn: new Date(),
              tier: spec.tier,
              member: madeMember._id,
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
      }

      return { member: madeMember, parent: placedUnder };
    });

    created.push({ _id: member._id, memberCode });

    // The same call the controllers make, once the transaction has committed.
    const result = spec.place && sponsor ? await settle(member._id, 'seed:demo') : null;
    const rows = result ? (result.direct ? 1 : 0) + (result.matching?.length || 0) : 0;

    console.log(
      `  ${memberCode}  ${spec.fullName.padEnd(16)} ` +
        (parent ? `under ${parent.memberCode} ${spec.position}` : spec.place ? 'root' : 'unplaced') +
        `  ${rows} ledger row(s)`
    );
  }

  await showTree('AFTER');

  const totals = await CommissionLedger.aggregate([
    { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } }
  ]);
  if (totals.length) {
    console.log('\nLedger:');
    totals.forEach((t) => console.log(`  ${String(t._id).padEnd(9)} ${String(t.count).padStart(3)} row(s)  ${t.total}`));
  }

  console.log(`\nAssociate portal login for any seeded member: <their email> / ${PASSWORD}`);
  console.log('Undo with: npm run seed:demo -- --undo --apply\n');

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('\nSeed failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
