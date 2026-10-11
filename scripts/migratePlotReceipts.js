/**
 * One-time: split paid plot instalments into PlotReceipt records.
 *
 *   npm run migrate:plot-receipts            dry run — counts only
 *   npm run migrate:plot-receipts -- --apply
 *
 * Each paid instalment becomes one receipt with the SAME _id, so every plot
 * commission row and idempotency key (plot:direct:<id>, plot:volume:<id>)
 * already points at its receipt. Then the receipt fields come off the
 * instalments and the indexes are rebuilt. Safe to run again.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { BUSINESSES } = require('../config/business');
const { runInBusiness } = require('../utils/businessContext');
const PlotPayment = require('../models/plots/Payment');
const PlotReceipt = require('../models/plots/Receipt');
const PlotBooking = require('../models/plots/Booking');
const { round2 } = require('../services/plots/helpers');

const apply = process.argv.includes('--apply');
const MOVED = ['paidOn', 'mode', 'reference', 'notes', 'ratingPct', 'commissionBase', 'receiptNo', 'receivedBy', 'receivedByCode'];

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  await runInBusiness(BUSINESSES.T2, async () => {
    console.log(`Connected to "${mongoose.connection.name}_t2"${apply ? '  [--apply]' : '  [DRY RUN]'}\n`);

    // Raw reads: the moved fields are no longer in the schema.
    const paid = await PlotPayment.collection
      .find({ receiptNo: { $type: 'string' } })
      .sort({ booking: 1, paidOn: 1, seq: 1 })
      .toArray();
    const existing = new Set((await PlotReceipt.find({ _id: { $in: paid.map((p) => p._id) } }).distinct('_id')).map(String));
    const prices = new Map(
      (await PlotBooking.find({ _id: { $in: [...new Set(paid.map((p) => String(p.booking)))] } }).select('price').lean()).map((b) => [
        String(b._id),
        b.price
      ])
    );
    console.log(`Paid instalments: ${paid.length}, already receipts: ${existing.size}, to migrate: ${paid.length - existing.size}`);

    if (!apply) {
      console.log('\nDry run — nothing written. Re-run with --apply.');
      return;
    }

    // Running total per booking in payment order, for balanceAfter.
    const paidSoFar = new Map();
    const docs = [];
    for (const p of paid) {
      const key = String(p.booking);
      const total = round2((paidSoFar.get(key) || 0) + p.paidAmount);
      paidSoFar.set(key, total);
      if (existing.has(String(p._id))) continue;
      docs.push({
        _id: p._id,
        booking: p.booking,
        plot: p.plot,
        project: p.project,
        client: p.client,
        associate: p.associate,
        amount: p.paidAmount,
        paidOn: p.paidOn,
        mode: p.mode ?? null,
        reference: p.reference || '',
        notes: p.notes || '',
        ratingPct: p.ratingPct ?? 100,
        commissionBase: p.commissionBase ?? round2(p.paidAmount * ((p.ratingPct ?? 100) / 100)),
        receiptNo: p.receiptNo,
        receivedBy: p.receivedBy ?? null,
        receivedByCode: p.receivedByCode ?? null,
        allocations: [{ instalment: p._id, seq: p.seq, kind: p.kind, amount: p.paidAmount }],
        adjustment: null,
        balanceAfter: round2(prices.get(key) - total),
        createdAt: p.updatedAt,
        updatedAt: p.updatedAt
      });
    }
    // Raw insert keeps the original timestamps.
    if (docs.length) await PlotReceipt.collection.insertMany(docs);

    await PlotPayment.collection.updateMany({ receiptNo: { $type: 'string' } }, [{ $set: { lastPaidOn: '$paidOn' } }]);
    await PlotPayment.collection.updateMany({}, { $unset: Object.fromEntries(MOVED.map((f) => [f, ''])) });
    await PlotPayment.collection.updateMany({ revision: { $exists: false } }, { $set: { revision: 0 } });
    await PlotPayment.collection.updateMany({ lastPaidOn: { $exists: false } }, { $set: { lastPaidOn: null } });
    await PlotBooking.collection.updateMany({ revision: { $exists: false } }, { $set: { revision: 0 } });

    // Drops booking_1_seq_1 and the old receiptNo index, builds the new ones.
    await PlotPayment.syncIndexes();
    await PlotReceipt.syncIndexes();

    console.log(`Created ${docs.length} receipt(s); instalments cleaned; indexes rebuilt.`);
  });

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('Migration failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
