/**
 * Unit tests for the leg-side resolver — the one piece of the commission engine
 * that is pure logic, and the one most likely to be silently wrong.
 *
 *   npm test
 *
 * No database. No mongoose. Plain objects standing in for lean() documents,
 * which is exactly what the resolver is written to accept.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveLegSides, reindexChain, round2 } = require('../services/commissionService');
const { POSITIONS } = require('../config/constants');

const { LEFT, RIGHT } = POSITIONS;

// ---------------------------------------------------------------------------
// A hand-built tree. `position` is each node's side under its OWN parent.
//
//                         A0  (root)
//                     /              \
//               A1 (Left)          B1 (Right)
//              /        \          /        \
//        A2 (Left)  A3 (Right) B2 (Left) B3 (Right)
//         /      \
//   A4 (Left)  A5 (Right)
// ---------------------------------------------------------------------------
const node = (memberCode, position) => ({ _id: memberCode, memberCode, position });

const A0 = node('A0', null); // root has no position
const A1 = node('A1', LEFT);
const B1 = node('B1', RIGHT);
const A2 = node('A2', LEFT);
const A3 = node('A3', RIGHT);
const B2 = node('B2', LEFT);
const A4 = node('A4', LEFT);
const A5 = node('A5', RIGHT);

// ancestors are stored root-first, direct-parent-last.
const member = (n, ancestors) => ({ ...n, ancestors: ancestors.map((a) => a._id) });

const sides = (result) => result.map((r) => r.side);
const codes = (result) => result.map((r) => r.ancestor.memberCode);
const depths = (result) => result.map((r) => r.depthFromSource);

test('root member with no ancestors resolves to an empty chain', () => {
  assert.deepEqual(resolveLegSides(member(A0, []), []), []);
});

test('direct child: side is the member own position, depth 1', () => {
  const result = resolveLegSides(member(A1, [A0]), [A0]);

  assert.equal(result.length, 1);
  assert.deepEqual(sides(result), [LEFT]);
  assert.deepEqual(codes(result), ['A0']);
  assert.deepEqual(depths(result), [1]);
});

test('chain is returned nearest-ancestor-first, not root-first', () => {
  const result = resolveLegSides(member(A4, [A0, A1, A2]), [A0, A1, A2]);

  assert.deepEqual(codes(result), ['A2', 'A1', 'A0']);
  assert.deepEqual(depths(result), [1, 2, 3]);
});

test('all-left descendant contributes to the left leg of every ancestor', () => {
  const result = resolveLegSides(member(A4, [A0, A1, A2]), [A0, A1, A2]);

  assert.deepEqual(sides(result), [LEFT, LEFT, LEFT]);
});

// THE case naive implementations get wrong. A5 is the RIGHT child of its direct
// parent, but it hangs off A0's LEFT branch — so it must add volume to A0's
// LEFT leg. Code that reuses member.position for the whole chain pays A0's
// right leg instead, and the error is invisible until legs fail to match.
test('right-child of a left-branch parent still feeds the LEFT leg higher up', () => {
  const result = resolveLegSides(member(A5, [A0, A1, A2]), [A0, A1, A2]);

  assert.deepEqual(codes(result), ['A2', 'A1', 'A0']);
  assert.deepEqual(sides(result), [RIGHT, LEFT, LEFT]);
});

test('left-child of a right-branch parent feeds the RIGHT leg higher up', () => {
  const result = resolveLegSides(member(B2, [A0, B1]), [A0, B1]);

  assert.deepEqual(codes(result), ['B1', 'A0']);
  assert.deepEqual(sides(result), [LEFT, RIGHT]);
});

test('siblings split their direct parent but agree on every ancestor above it', () => {
  const left = resolveLegSides(member(A4, [A0, A1, A2]), [A0, A1, A2]);
  const right = resolveLegSides(member(A5, [A0, A1, A2]), [A0, A1, A2]);

  assert.notEqual(sides(left)[0], sides(right)[0]);          // differ at A2
  assert.deepEqual(sides(left).slice(1), sides(right).slice(1)); // agree at A1, A0
});

test('a hole in the ancestor chain throws rather than paying the wrong people', () => {
  assert.throws(
    () => resolveLegSides(member(A4, [A0, A1, A2]), [A0, undefined, A2]),
    /Broken ancestor chain for A4.*ancestors\[1\]/s
  );
});

test('an unresolvable position throws', () => {
  const orphanPosition = { _id: 'X', memberCode: 'X', position: null };

  assert.throws(
    () => resolveLegSides(member(A4, [A0, orphanPosition]), [A0, orphanPosition]),
    /Cannot resolve leg side for A4/
  );
});

// ---------------------------------------------------------------------------
// reindexChain — guards the $in ordering hazard
// ---------------------------------------------------------------------------

test('reindexChain restores ancestor order from shuffled query results', () => {
  const ancestorIds = [A0._id, A1._id, A2._id];
  const asReturnedByMongo = [A2, A0, A1]; // natural order, not argument order

  const ordered = reindexChain(ancestorIds, asReturnedByMongo);

  assert.deepEqual(ordered.map((a) => a.memberCode), ['A0', 'A1', 'A2']);
});

test('shuffled results still resolve correctly once reindexed', () => {
  const m = member(A5, [A0, A1, A2]);
  const ordered = reindexChain(m.ancestors, [A2, A0, A1]);

  assert.deepEqual(sides(resolveLegSides(m, ordered)), [RIGHT, LEFT, LEFT]);
});

test('reindexChain leaves a hole for a missing ancestor instead of shifting', () => {
  const ordered = reindexChain([A0._id, A1._id, A2._id], [A0, A2]);

  assert.equal(ordered.length, 3);
  assert.equal(ordered[1], undefined);
  assert.equal(ordered[2].memberCode, 'A2');
});

// ---------------------------------------------------------------------------
// round2
// ---------------------------------------------------------------------------

test('round2 keeps matching payouts off binary-float drift', () => {
  assert.equal(round2(0.05 * 50000), 2500);
  assert.equal(round2(0.1 * 50000), 5000);
  assert.equal(round2(0.05 * 49999.99), 2500);
  assert.equal(round2(0.1 * 33333.33), 3333.33);
});

test('round2 of a long float sums without drift over many rows', () => {
  const rows = Array.from({ length: 10000 }, () => round2(0.05 * 16666.67));
  const total = round2(rows.reduce((a, b) => a + b, 0));

  assert.equal(total, round2(833.33 * 10000));
});
