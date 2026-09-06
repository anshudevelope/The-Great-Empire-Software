/**
 * Backfills the Phase 1 fields on existing records.
 *
 *   npm run migrate
 *
 * Assigns memberCode (TRG####) in join order, then walks the tree from the
 * root to compute the materialised path (ancestors + depth) that every
 * downline report and RBAC ownership check depends on.
 *
 * Safe to re-run: it only fills in what is missing or inconsistent.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Associate = require('../models/Associate');
const Counter = require('../models/Counter');
const { formatMemberCode } = require('../utils/codes');
const { ROLES, TIERS, MEMBER_CODE } = require('../config/constants');

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB\n');

  const associates = await Associate.find({ role: ROLES.ASSOCIATE })
    .select('memberCode parentId position sponsorId sponsorCode ancestors depth tier createdAt')
    .sort({ createdAt: 1 })
    .lean();

  if (!associates.length) {
    console.log('No associates found — nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${associates.length} associates.\n`);

  // -------------------------------------------------------------------------
  // 1. Member codes, oldest first, so the earliest joiner becomes TRG0001.
  // -------------------------------------------------------------------------
  const used = new Set(associates.map((a) => a.memberCode).filter(Boolean));
  const codeOps = [];
  let seq = 0;

  const nextFreeCode = () => {
    let code;
    do {
      seq += 1;
      code = formatMemberCode(seq);
    } while (used.has(code));
    used.add(code);
    return code;
  };

  const codeById = new Map();
  for (const a of associates) {
    if (a.memberCode) {
      codeById.set(String(a._id), a.memberCode);
      const match = /^TRG(\d+)$/.exec(a.memberCode);
      if (match) seq = Math.max(seq, parseInt(match[1], 10));
      continue;
    }
    const code = nextFreeCode();
    codeById.set(String(a._id), code);
    codeOps.push({ updateOne: { filter: { _id: a._id }, update: { $set: { memberCode: code } } } });
  }

  if (codeOps.length) await Associate.bulkWrite(codeOps);
  console.log(`memberCode: assigned ${codeOps.length}, already present ${associates.length - codeOps.length}`);

  // Make sure newly minted codes can never collide with backfilled ones.
  const highest = Math.max(
    ...[...used].map((c) => {
      const m = /^TRG(\d+)$/.exec(c);
      return m ? parseInt(m[1], 10) : 0;
    })
  );
  await Counter.raiseTo(MEMBER_CODE.SEQUENCE, highest);
  console.log(`counter:    raised to ${highest} (next is ${formatMemberCode(highest + 1)})`);

  // -------------------------------------------------------------------------
  // 2. Materialised path — breadth-first from each root.
  // -------------------------------------------------------------------------
  const byId = new Map(associates.map((a) => [String(a._id), a]));
  const childrenOf = new Map();
  for (const a of associates) {
    if (!a.parentId) continue;
    const key = String(a.parentId);
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(a);
  }

  const roots = associates.filter((a) => !a.parentId);
  if (roots.length === 0) console.warn('WARNING: no root found (every associate has a parent).');
  if (roots.length > 1) {
    console.warn(`WARNING: ${roots.length} roots found — expected exactly one (TRG0001).`);
    console.warn('         Detached trees make downline reports under-count. Roots:');
    roots.forEach((r) => console.warn(`           ${codeById.get(String(r._id))}`));
  }

  const pathOps = [];
  const reached = new Set();

  for (const root of roots) {
    const queue = [{ node: root, ancestors: [], depth: 0 }];
    while (queue.length) {
      const { node, ancestors, depth } = queue.shift();
      const key = String(node._id);

      if (reached.has(key)) {
        console.warn(`WARNING: cycle detected at ${codeById.get(key)} — skipping.`);
        continue;
      }
      reached.add(key);

      const currentAncestors = (node.ancestors || []).map(String);
      const pathChanged =
        currentAncestors.length !== ancestors.length ||
        currentAncestors.some((a, i) => a !== String(ancestors[i])) ||
        node.depth !== depth;

      if (pathChanged) {
        pathOps.push({
          updateOne: { filter: { _id: node._id }, update: { $set: { ancestors, depth } } }
        });
      }

      for (const child of childrenOf.get(key) || []) {
        queue.push({ node: child, ancestors: [...ancestors, node._id], depth: depth + 1 });
      }
    }
  }

  if (pathOps.length) await Associate.bulkWrite(pathOps);
  console.log(`ancestors:  updated ${pathOps.length}`);

  const unreachable = associates.filter((a) => !reached.has(String(a._id)));
  if (unreachable.length) {
    console.warn(`WARNING: ${unreachable.length} associates are not reachable from any root:`);
    unreachable.forEach((a) => console.warn(`           ${codeById.get(String(a._id))} (parent ${a.parentId})`));
  }

  // -------------------------------------------------------------------------
  // 3. Sponsor denormalisation, tier backfill, password flag.
  // -------------------------------------------------------------------------
  const directCounts = new Map();
  for (const a of associates) {
    if (!a.sponsorId) continue;
    const key = String(a.sponsorId);
    directCounts.set(key, (directCounts.get(key) || 0) + 1);
  }

  const finalOps = [];
  for (const a of associates) {
    const set = {};

    const expectedSponsorCode = a.sponsorId ? codeById.get(String(a.sponsorId)) || null : null;
    if ((a.sponsorCode || null) !== expectedSponsorCode) set.sponsorCode = expectedSponsorCode;

    const expectedDirects = directCounts.get(String(a._id)) || 0;
    set.directCount = expectedDirects;

    if (!a.tier) set.tier = TIERS.ONE;

    // Existing accounts keep working — they aren't forced to reset a password
    // they already chose. Only members created from here on get the flag.
    set.mustChangePassword = false;

    finalOps.push({ updateOne: { filter: { _id: a._id }, update: { $set: set } } });
  }

  if (finalOps.length) await Associate.bulkWrite(finalOps);
  console.log(`sponsor:    denormalised codes + direct counts on ${finalOps.length}`);

  console.log('\nMigration complete.');
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('Migration failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
