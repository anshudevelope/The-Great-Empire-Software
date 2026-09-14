/**
 * The client's Tier I worked example, rebuilt member by member.
 *
 * This is a SIMULATION, not an integration test. It drives the real
 * resolveLegSides() over a real 62-member tree, and mirrors payMatching's carry
 * arithmetic against an in-memory map standing in for the atomic $inc.
 *
 * What it proves:  the leg-side resolution and the carry/match maths produce
 *                  the numbers in the client's plan document.
 * What it does NOT prove: the concurrency behaviour of payMatching (the guarded
 *                  deduction, the E11000 idempotency path). Those touch real
 *                  Mongo semantics and need an integration test against a
 *                  replica set — see COMMISSION-ENGINE-PLAN.md §12 case 6.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveLegSides, round2, ratesFor } = require('../services/commissionService');
const { POSITIONS, TIERS } = require('../config/constants');

const { LEFT, RIGHT } = POSITIONS;
const UNIT = 50000; // one Tier I registration
const { direct: DIRECT_RATE, matching: MATCH_RATE } = ratesFor(TIERS.ONE);

/**
 * Builds a perfect binary tree `levels` deep below a root, returning members in
 * placement (breadth-first) order — the order a real downline actually fills.
 */
const buildTree = (levels) => {
  const root = { memberCode: 'U', _id: 'U', position: null, ancestors: [], sponsor: null };
  const all = [];
  let frontier = [root];

  for (let level = 1; level <= levels; level++) {
    const next = [];
    for (const parent of frontier) {
      for (const position of [LEFT, RIGHT]) {
        const member = {
          _id: `${parent._id}${position[0]}`,
          memberCode: `${parent._id}${position[0]}`,
          position,
          ancestors: [...parent.ancestors, parent._id],
          sponsor: parent._id, // everyone is sponsored by the person above them
          level
        };
        next.push(member);
        all.push(member);
      }
    }
    frontier = next;
  }

  return { root, all, index: new Map([[root._id, root], ...all.map((m) => [m._id, m])]) };
};

/**
 * Replays the engine over a tree. `carry` and `income` stand in for the atomic
 * $inc operations in payMatching / payDirect.
 */
const run = (tree) => {
  const carry = new Map();   // memberCode -> { left, right }
  const matching = new Map();
  const direct = new Map();
  const perLevel = new Map();

  const carryOf = (id) => {
    if (!carry.has(id)) carry.set(id, { left: 0, right: 0 });
    return carry.get(id);
  };
  const add = (map, id, amount) => map.set(id, round2((map.get(id) || 0) + amount));

  for (const member of tree.all) {
    // --- direct: 10% to the sponsor, one level ---------------------------
    if (member.sponsor) add(direct, member.sponsor, round2(DIRECT_RATE * UNIT));

    // --- matching: walk the ancestor chain -------------------------------
    const ordered = member.ancestors.map((id) => tree.index.get(id));
    for (const { ancestor, side } of resolveLegSides(member, ordered)) {
      const c = carryOf(ancestor._id);
      c[side === LEFT ? 'left' : 'right'] += UNIT;

      const matched = Math.min(c.left, c.right);
      if (matched <= 0) continue;

      c.left -= matched;
      c.right -= matched;

      const payout = round2(MATCH_RATE * matched);
      add(matching, ancestor._id, payout);
      if (ancestor._id === 'U') {
        perLevel.set(member.level, round2((perLevel.get(member.level) || 0) + payout));
      }
    }
  }

  return { carry, matching, direct, perLevel };
};

test('62-member tree: the root earns exactly the documented total', () => {
  const tree = buildTree(5);
  assert.equal(tree.all.length, 62);

  const { matching, direct } = run(tree);

  assert.equal(direct.get('U'), 10000);    // 2 directs x 10% of 50,000
  assert.equal(matching.get('U'), 77500);  // 5% of 15,50,000 matched
  assert.equal(round2(direct.get('U') + matching.get('U')), 87500);
});

test('matching income per level matches the plan document line for line', () => {
  const { perLevel } = run(buildTree(5));

  assert.deepEqual(
    [1, 2, 3, 4, 5].map((l) => perLevel.get(l)),
    [2500, 5000, 10000, 20000, 40000]
  );
});

test('a balanced tree leaves no carry stranded at the root', () => {
  const { carry } = run(buildTree(5));
  const root = carry.get('U');

  assert.equal(root.left, 0);
  assert.equal(root.right, 0);
});

test('every ancestor is paid on the volume beneath it, not just the root', () => {
  const tree = buildTree(5);
  const { matching } = run(tree);

  // U's left child sits above a perfect 4-level subtree: 2+4+8+16 = 30
  // members, 15 per leg, so 15 pairs match at 5% of 15 x 50,000.
  const left = tree.all.find((m) => m._id === 'UL');
  assert.equal(matching.get(left._id), round2(MATCH_RATE * 15 * UNIT));
  assert.equal(matching.get(left._id), 37500);
});

// ---------------------------------------------------------------------------
// Unbalanced legs — the carry-forward behaviour the client specified
// ---------------------------------------------------------------------------

test('volume with no counterpart pays nothing and waits in carry', () => {
  const root = { _id: 'U', memberCode: 'U', position: null, ancestors: [] };
  const index = new Map([['U', root]]);
  const carry = { left: 0, right: 0 };
  let paid = 0;

  const place = (position) => {
    const m = { _id: `m${position}`, memberCode: `m${position}`, position, ancestors: ['U'] };
    for (const { side } of resolveLegSides(m, [root])) {
      carry[side === LEFT ? 'left' : 'right'] += UNIT;
      const matched = Math.min(carry.left, carry.right);
      if (matched > 0) {
        carry.left -= matched;
        carry.right -= matched;
        paid = round2(paid + MATCH_RATE * matched);
      }
    }
  };

  for (let i = 0; i < 10; i++) place(LEFT);
  assert.equal(paid, 0);
  assert.equal(carry.left, 500000);
  assert.equal(carry.right, 0);

  place(RIGHT); // first counterpart arrives
  assert.equal(paid, 2500);
  assert.equal(carry.left, 450000);
  assert.equal(carry.right, 0);
});

test('liability per member is 5,000 + 1,250 x depth', () => {
  // Every member releases 1,250 to each ancestor (2,500 per pair of members),
  // plus a flat 5,000 direct. This is the figure the liability dashboard tracks.
  const tree = buildTree(5);
  const { matching, direct } = run(tree);

  const totalPaid = round2(
    [...matching.values()].reduce((a, b) => a + b, 0) +
      [...direct.values()].reduce((a, b) => a + b, 0)
  );

  const expected = tree.all.reduce(
    (sum, m) => round2(sum + 5000 + 1250 * m.ancestors.length),
    0
  );

  assert.equal(totalPaid, expected);

  // 62 x 5,000 direct = 3,10,000, plus 1,250 x 258 ancestor-hops = 3,22,500.
  assert.equal(totalPaid, 632500);

  // 6,32,500 paid out against 31,00,000 collected — 20.4%, at an average depth
  // of just 4.2. The ratio climbs with depth and has no ceiling, which is what
  // the liability dashboard (COMMISSION-ENGINE-PLAN.md §9.3) exists to watch.
  const collected = tree.all.length * UNIT;
  assert.equal(collected, 3100000);
  assert.equal(Math.round((totalPaid / collected) * 1000) / 10, 20.4);
});
