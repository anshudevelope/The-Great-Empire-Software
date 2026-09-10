/**
 * Tree integrity checker.
 *
 *   npm run verify:tree
 *
 * Read-only. Run it after a migration, after any bulk edit, and on a schedule.
 * Structural corruption here is silent — the tree keeps rendering from
 * leftChild/rightChild while every report that relies on `ancestors` quietly
 * returns wrong numbers. This is what catches that.
 *
 * Exits 1 if any problem is found, so it can gate CI or a cron alert.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Associate = require('../models/Associate');
const { ROLES } = require('../config/constants');

const problems = [];
const report = (check, detail) => problems.push({ check, detail });

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB\n');

  const all = await Associate.find({ role: ROLES.ASSOCIATE })
    .select('memberCode sponsorMemberCode treeStatus fullName parentId position leftChild rightChild ancestors depth sponsorId directCount')
    .lean();

  if (!all.length) {
    console.log('No associates — nothing to verify.');
    await mongoose.disconnect();
    return;
  }

  const byId = new Map(all.map((a) => [String(a._id), a]));
  const code = (id) => byId.get(String(id))?.memberCode || `<missing ${id}>`;

  console.log(`Checking ${all.length} associates…\n`);

  // Members created but not yet placed. They legitimately have no parent, so
  // every structural check below has to skip them — otherwise each one looks
  // like a second root and an unreachable orphan.
  const unplaced = all.filter((a) => a.treeStatus === 'unplaced');
  const inTree = all.filter((a) => a.treeStatus !== 'unplaced');

  // --- 1. Exactly one root --------------------------------------------------
  const roots = inTree.filter((a) => a.treeStatus === 'root');
  if (roots.length === 0) report('root', 'No root found — no associate is marked treeStatus "root".');
  if (roots.length > 1) {
    report('root', `${roots.length} roots found (expected 1): ${roots.map((r) => r.memberCode).join(', ')}. Detached trees make downline reports under-count.`);
  }

  // --- 1b. Placement flags agree with the pointers -------------------------
  for (const a of all) {
    if (a.treeStatus === 'unplaced' && (a.parentId || a.leftChild || a.rightChild || (a.ancestors || []).length)) {
      report('treeStatus', `${a.memberCode} is marked unplaced but has tree links.`);
    }
    if (a.treeStatus === 'placed' && !a.parentId) {
      report('treeStatus', `${a.memberCode} is marked placed but has no parent.`);
    }
    if (a.treeStatus === 'root' && a.parentId) {
      report('treeStatus', `${a.memberCode} is marked root but has a parent.`);
    }
  }

  // --- 2. Member codes ------------------------------------------------------
  const seenCodes = new Map();
  for (const a of all) {
    if (!a.memberCode) report('memberCode', `${a.fullName} (${a._id}) has no member code.`);
    else if (seenCodes.has(a.memberCode)) report('memberCode', `Duplicate code ${a.memberCode}.`);
    else seenCodes.set(a.memberCode, a._id);
  }

  // --- 3. Child pointers are reciprocal ------------------------------------
  // A parent claiming a child that doesn't point back means one of the two
  // views of the tree is lying.
  const claimedBy = new Map();
  for (const a of all) {
    for (const side of ['leftChild', 'rightChild']) {
      const childId = a[side];
      if (!childId) continue;
      const child = byId.get(String(childId));
      const expectedPosition = side === 'leftChild' ? 'Left' : 'Right';

      if (!child) {
        report('pointer', `${a.memberCode}.${side} points at a non-existent associate.`);
        continue;
      }
      if (String(child.parentId) !== String(a._id)) {
        report('pointer', `${a.memberCode}.${side} = ${child.memberCode}, but that member's parentId is ${code(child.parentId)}.`);
      }
      if (child.position !== expectedPosition) {
        report('pointer', `${a.memberCode}.${side} = ${child.memberCode}, but their position says "${child.position}".`);
      }
      if (claimedBy.has(String(childId))) {
        report('pointer', `${child.memberCode} is claimed as a child by both ${code(claimedBy.get(String(childId)))} and ${a.memberCode}.`);
      }
      claimedBy.set(String(childId), a._id);
    }
  }

  // Every non-root must be claimed by its parent.
  for (const a of all) {
    if (!a.parentId) continue;
    const parent = byId.get(String(a.parentId));
    if (!parent) {
      report('orphan', `${a.memberCode} has parentId ${a.parentId}, which does not exist.`);
      continue;
    }
    const field = a.position === 'Left' ? 'leftChild' : 'rightChild';
    if (String(parent[field]) !== String(a._id)) {
      report('orphan', `${a.memberCode} claims parent ${parent.memberCode} (${a.position}), but that slot holds ${code(parent[field]) || 'nothing'}.`);
    }
  }

  // --- 4. No cycles + everything reachable from the root -------------------
  const reachable = new Set();
  for (const root of roots) {
    const queue = [String(root._id)];
    while (queue.length) {
      const id = queue.shift();
      if (reachable.has(id)) {
        report('cycle', `Cycle detected in the binary tree at ${code(id)}.`);
        continue;
      }
      reachable.add(id);
      const node = byId.get(id);
      if (!node) continue;
      for (const side of ['leftChild', 'rightChild']) {
        if (node[side]) queue.push(String(node[side]));
      }
    }
  }
  for (const a of inTree) {
    if (!reachable.has(String(a._id))) {
      report('unreachable', `${a.memberCode} is not reachable from the root.`);
    }
  }

  // --- 5. ancestors / depth agree with the parentId chain ------------------
  for (const a of all) {
    const expected = [];
    let cursor = a.parentId;
    let hops = 0;
    while (cursor && hops++ < 10000) {
      expected.unshift(String(cursor));
      const parent = byId.get(String(cursor));
      if (!parent) break;
      cursor = parent.parentId;
    }

    const actual = (a.ancestors || []).map(String);
    if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) {
      report('ancestors', `${a.memberCode}: ancestors is [${actual.map(code).join(' > ')}] but the parent chain is [${expected.map(code).join(' > ')}]. Downline reports for anyone above will be wrong.`);
    }
    if (a.depth !== expected.length) {
      report('depth', `${a.memberCode}: depth is ${a.depth} but should be ${expected.length}.`);
    }
  }

  // --- 6. Sponsor graph -----------------------------------------------------
  for (const a of all) {
    if (!a.sponsorId) continue;
    const sponsor = byId.get(String(a.sponsorId));
    if (!sponsor) {
      report('sponsor', `${a.memberCode} has sponsorId ${a.sponsorId}, which does not exist.`);
      continue;
    }
    if ((a.sponsorMemberCode || null) !== (sponsor.memberCode || null)) {
      report('sponsor', `${a.memberCode}: sponsorMemberCode is "${a.sponsorMemberCode}" but the sponsor is ${sponsor.memberCode}.`);
    }
    if (String(a.sponsorId) === String(a._id)) {
      report('sponsor', `${a.memberCode} sponsors themselves.`);
    }
  }

  // Sponsor cycles
  for (const a of all) {
    const seen = new Set([String(a._id)]);
    let cursor = a.sponsorId;
    let hops = 0;
    while (cursor && hops++ < 10000) {
      const key = String(cursor);
      if (seen.has(key)) {
        report('sponsor', `Sponsor cycle involving ${a.memberCode}.`);
        break;
      }
      seen.add(key);
      cursor = byId.get(key)?.sponsorId;
    }
  }

  // --- 7. directCount matches reality --------------------------------------
  const actualDirects = new Map();
  for (const a of all) {
    if (!a.sponsorId) continue;
    const key = String(a.sponsorId);
    actualDirects.set(key, (actualDirects.get(key) || 0) + 1);
  }
  for (const a of all) {
    const expected = actualDirects.get(String(a._id)) || 0;
    if ((a.directCount || 0) !== expected) {
      report('directCount', `${a.memberCode}: directCount is ${a.directCount} but ${expected} members name them as sponsor.`);
    }
  }

  // --- Result ---------------------------------------------------------------
  if (!problems.length) {
    console.log('All checks passed — tree is consistent.');
    console.log(
      `  root: ${roots[0]?.memberCode}  |  in tree: ${inTree.length}  |  unplaced: ${unplaced.length}` +
        `  |  max depth: ${Math.max(0, ...inTree.map((a) => a.depth))}`
    );
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

  await mongoose.disconnect();
  process.exit(1);
};

run().catch(async (err) => {
  console.error('Verification failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
