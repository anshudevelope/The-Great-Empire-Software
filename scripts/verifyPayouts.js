/**
 * Payout integrity checker.
 *
 *   npm run verify:payouts
 *
 * The third of the verifiers, alongside verify:tree and verify:commissions.
 * Those two cover structure and earnings; this one covers what was actually
 * paid, which is the part a member will dispute.
 *
 * Read-only. Exits 1 if any problem is found, so it can gate CI or a cron alert.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const PayoutBatch = require('../models/PayoutBatch');
const PayoutLine = require('../models/PayoutLine');
const CommissionLedger = require('../models/CommissionLedger');
const { PAYOUT_STATUSES } = require('../config/constants');

const problems = [];
const report = (check, detail) => problems.push({ check, detail });
const round2 = (n) => Math.round(n * 100) / 100;

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB  [read-only]\n');

  const batches = await PayoutBatch.find().sort({ createdAt: 1 }).lean();
  if (!batches.length) {
    console.log('No payouts yet — nothing to verify.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Checking ${batches.length} payout batch(es)…\n`);

  // --- 1. At most one open draft -------------------------------------------
  // The partial unique index enforces this, but the index only exists once
  // sync:indexes has run — so check the data, not the declaration.
  const drafts = batches.filter((b) => b.status === PAYOUT_STATUSES.DRAFT);
  if (drafts.length > 1) {
    report(
      'draft',
      `${drafts.length} open drafts (${drafts.map((d) => d.batchNo).join(', ')}). ` +
        'Whichever is finalized second would pay the same commission twice. Run npm run sync:indexes.'
    );
  }

  for (const batch of batches) {
    const lines = await PayoutLine.find({ batch: batch._id }).lean();

    // --- 2. Batch totals equal the sum of their lines ----------------------
    // Rounding is per line; a total recomputed any other way disagrees by paise.
    const sum = (key) => round2(lines.reduce((s, l) => s + (l[key] || 0), 0));
    const checks = [
      ['gross', sum('total')],
      ['adminCharge', sum('adminCharge')],
      ['secondaryCharge', sum('secondaryCharge')],
      ['netPayable', sum('netPayable')]
    ];
    for (const [key, expected] of checks) {
      if (round2(batch.totals[key] || 0) !== expected) {
        report(
          'totals',
          `${batch.batchNo}: totals.${key} is ${batch.totals[key]} but its lines sum to ${expected}.`
        );
      }
    }

    if ((batch.totals.members || 0) !== lines.filter((l) => l.total !== 0).length) {
      report(
        'totals',
        `${batch.batchNo}: totals.members is ${batch.totals.members} but ${lines.filter((l) => l.total !== 0).length} line(s) carry a non-zero total.`
      );
    }

    // --- 3. Each line's arithmetic still holds -----------------------------
    for (const l of lines) {
      const expectedTotal = round2(l.direct + l.matching + l.reversals + l.openingAdjustment);
      if (round2(l.total) !== expectedTotal) {
        report('line', `${batch.batchNo}/${l.memberCode}: total ${l.total} but its parts sum to ${expectedTotal}.`);
      }

      if (l.heldReason) {
        if (l.netPayable !== 0 || l.adminCharge !== 0 || l.secondaryCharge !== 0) {
          report(
            'line',
            `${batch.batchNo}/${l.memberCode}: held as "${l.heldReason}" but was charged or paid. Held lines roll the gross forward untouched.`
          );
        }
      } else if (round2(l.netPayable + l.adminCharge + l.secondaryCharge) !== round2(l.total)) {
        report(
          'line',
          `${batch.batchNo}/${l.memberCode}: net ${l.netPayable} + charges does not reconstruct total ${l.total}.`
        );
      }

      // The flush is clamped, so it can take less than was snapshotted — but
      // never more, or cancel would hand back carry the member never had.
      for (const side of ['left', 'right']) {
        if ((l.carryFlushed?.[side] || 0) > (l.carryBefore?.[side] || 0)) {
          report(
            'carry',
            `${batch.batchNo}/${l.memberCode}: flushed ${l.carryFlushed[side]} on the ${side} leg but only ${l.carryBefore[side]} was snapshotted.`
          );
        }
      }
    }

    // --- 4. Ledger stamps agree with the batch's status --------------------
    const stamped = await CommissionLedger.countDocuments({ payoutBatch: batch._id });

    if (batch.status === PAYOUT_STATUSES.DRAFT && stamped > 0) {
      report('stamp', `${batch.batchNo} is a DRAFT but ${stamped} ledger row(s) are stamped with it. A draft must pay nothing.`);
    }
    if (batch.status === PAYOUT_STATUSES.CANCELLED && stamped > 0) {
      report('stamp', `${batch.batchNo} is CANCELLED but ${stamped} ledger row(s) are still stamped with it — that income is invisible to the next payout.`);
    }
    if (batch.status === PAYOUT_STATUSES.FINALIZED && stamped === 0 && lines.some((l) => l.total !== 0)) {
      report('stamp', `${batch.batchNo} is FINALIZED with money on its lines but no ledger row is stamped with it — the same commission will be paid again.`);
    }

    // --- 5. Nothing was paid from outside the period ----------------------
    const outside = await CommissionLedger.countDocuments({
      payoutBatch: batch._id,
      createdAt: { $gt: batch.periodEnd }
    });
    if (outside) {
      report('period', `${batch.batchNo}: ${outside} stamped row(s) were created after its close date.`);
    }
  }

  // --- 6. No unpaid row predates the last closing --------------------------
  const lastFinal = batches
    .filter((b) => b.status === PAYOUT_STATUSES.FINALIZED)
    .sort((a, b) => b.periodEnd - a.periodEnd)[0];

  if (lastFinal) {
    const missed = await CommissionLedger.countDocuments({
      payoutBatch: null,
      createdAt: { $lte: lastFinal.periodEnd }
    });
    if (missed) {
      report(
        'missed',
        `${missed} unpaid ledger row(s) predate ${lastFinal.batchNo}'s close date. They were earned before the last closing but never paid.`
      );
    }
  }

  // --- 7. A ledger row belongs to at most one batch ------------------------
  const orphaned = await CommissionLedger.aggregate([
    { $match: { payoutBatch: { $ne: null } } },
    { $group: { _id: '$payoutBatch', count: { $sum: 1 } } }
  ]);
  const known = new Set(batches.map((b) => String(b._id)));
  for (const row of orphaned) {
    if (!known.has(String(row._id))) {
      report('stamp', `${row.count} ledger row(s) are stamped with batch ${row._id}, which no longer exists.`);
    }
  }

  // --- Result ---------------------------------------------------------------
  if (!problems.length) {
    const paid = batches.filter((b) => b.status === PAYOUT_STATUSES.FINALIZED);
    const total = round2(paid.reduce((s, b) => s + (b.totals.netPayable || 0), 0));
    console.log('All checks passed — payouts and the ledger agree.');
    console.log(`  batches: ${batches.length}  |  finalized: ${paid.length}  |  net paid: ${total}`);
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
