/**
 * Unit tests for the payout calculation — the deduction maths and the rules
 * that decide whether a member is paid or held.
 *
 *   npm test
 *
 * No database. computeLine and summarise are pure, which is deliberate: this is
 * where the money is decided, so it is the part that must be testable without
 * standing anything up.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeLine, summarise, round2 } = require('../services/payoutService');

const RATES = {
  adminChargePct: 0.05,
  secondaryChargePct: 0.05,
  secondaryChargeLabel: 'TDS',
  minimumPayable: 0
};

// ---------------------------------------------------------------------------
// The deduction rule: both charges on the gross, neither compounding
// ---------------------------------------------------------------------------

test('TGE0001 as it stands today: 20,000 + 7,500 pays 24,750', () => {
  const line = computeLine({ direct: 20000, matching: 7500 }, RATES);

  assert.equal(line.total, 27500);
  assert.equal(line.adminCharge, 1375);
  assert.equal(line.secondaryCharge, 1375);
  assert.equal(line.netPayable, 24750);
  assert.equal(line.heldReason, null);
});

test('charges do NOT compound — TDS is 5% of gross, not of the post-admin remainder', () => {
  const line = computeLine({ direct: 20000, matching: 7500 }, RATES);

  // Sequential stacking would give 1,306.25 and a net of 24,818.75.
  assert.equal(line.secondaryCharge, 1375);
  assert.notEqual(line.netPayable, 24818.75);
  assert.equal(line.adminCharge, line.secondaryCharge);
});

test('net plus both charges reconstructs the total exactly', () => {
  for (const total of [27500, 17500, 5000, 7500, 3333.33, 0.05, 999999.99]) {
    const line = computeLine({ direct: total }, RATES);
    assert.equal(round2(line.netPayable + line.adminCharge + line.secondaryCharge), line.total);
  }
});

// ---------------------------------------------------------------------------
// Reversals and negatives
// ---------------------------------------------------------------------------

test('a reversal reduces the period total', () => {
  const line = computeLine({ direct: 10000, matching: 2500, reversals: -5000 }, RATES);

  assert.equal(line.total, 7500);
  assert.equal(line.netPayable, 6750); // 7500 - 375 - 375
});

test('a period that nets negative pays nothing and rolls the shortfall forward', () => {
  const line = computeLine({ direct: 1000, reversals: -5000 }, RATES);

  assert.equal(line.total, -4000);
  assert.equal(line.netPayable, 0);
  assert.equal(line.adminCharge, 0, 'no charge is levied on money that is not going out');
  assert.equal(line.secondaryCharge, 0);
  assert.equal(line.heldReason, 'negative');
  assert.equal(line.rollForward, -4000);
});

test('a rolled-forward negative is absorbed by the next period', () => {
  const line = computeLine({ direct: 10000, openingAdjustment: -4000 }, RATES);

  assert.equal(line.total, 6000);
  assert.equal(line.netPayable, 5400);
  assert.equal(line.heldReason, null);
});

// ---------------------------------------------------------------------------
// Zero and the minimum threshold
// ---------------------------------------------------------------------------

test('a member with no income produces a clean zero line, not a held one', () => {
  const line = computeLine({}, RATES);

  assert.equal(line.total, 0);
  assert.equal(line.netPayable, 0);
  assert.equal(line.heldReason, null);
  assert.equal(line.rollForward, 0);
});

test('below the minimum payable, the GROSS rolls forward untouched', () => {
  const line = computeLine({ direct: 400 }, { ...RATES, minimumPayable: 500 });

  assert.equal(line.total, 400);
  assert.equal(line.netPayable, 0);
  assert.equal(line.adminCharge, 0);
  assert.equal(line.heldReason, 'below-minimum');
  // The full 400 carries, not the 360 it would have netted — charges apply
  // when the money actually goes out, not when it is withheld.
  assert.equal(line.rollForward, 400);
});

test('a minimum of zero disables the threshold entirely', () => {
  const line = computeLine({ direct: 1 }, { ...RATES, minimumPayable: 0 });

  assert.equal(line.heldReason, null);
  assert.equal(line.netPayable, 0.9);
});

test('the threshold compares against NET payable, not gross', () => {
  // Gross 520 clears a 500 floor, but nets 468 — which does not.
  const line = computeLine({ direct: 520 }, { ...RATES, minimumPayable: 500 });

  assert.equal(line.total, 520);
  assert.equal(line.heldReason, 'below-minimum');
});

// ---------------------------------------------------------------------------
// Batch totals
// ---------------------------------------------------------------------------

test('batch totals equal the sum of their lines, to the paisa', () => {
  const raw = [
    { direct: 20000, matching: 7500 },
    { direct: 15000, matching: 2500 },
    { direct: 2500, matching: 2500 },
    { direct: 5000, matching: 2500 },
  ]
  const lines = raw.map((r) => computeLine(r, RATES))
  const totals = summarise(lines)

  assert.equal(totals.members, 4)
  assert.equal(totals.grossDirect, 42500)
  assert.equal(totals.grossMatching, 15000)
  assert.equal(totals.gross, 57500)
  assert.equal(totals.adminCharge, 2875)
  assert.equal(totals.secondaryCharge, 2875)
  assert.equal(totals.netPayable, 51750)
})

test('summing rounded lines never drifts from the batch total', () => {
  // Thirds are the classic case: each line rounds, and a total recomputed from
  // the unrounded inputs would disagree by paise.
  const lines = Array.from({ length: 777 }, () => computeLine({ direct: 3333.33 }, RATES));
  const totals = summarise(lines);

  assert.equal(totals.netPayable, round2(lines[0].netPayable * 777));
  assert.equal(
    round2(totals.netPayable + totals.adminCharge + totals.secondaryCharge),
    totals.gross
  );
});

test('zero-income lines do not inflate the member count', () => {
  const lines = [
    computeLine({ direct: 5000 }, RATES),
    computeLine({}, RATES),
    computeLine({}, RATES),
  ];

  assert.equal(summarise(lines).members, 1);
});

test('carryFlushed totals both legs across every line', () => {
  const lines = [
    { ...computeLine({ direct: 5000 }, RATES), carryBefore: { left: 125000, right: 0 } },
    { ...computeLine({}, RATES), carryBefore: { left: 0, right: 50000 } },
  ];

  assert.equal(summarise(lines).carryFlushed, 175000);
});
