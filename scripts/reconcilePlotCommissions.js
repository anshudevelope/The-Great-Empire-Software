/**
 * Re-runs plot commission for every paid instalment, and the reversal for
 * every cancelled booking, in T2.
 *
 *   npm run reconcile:plots
 *
 * Commission runs after a payment's transaction commits, so a crash between
 * the two can leave a payment without its commission (or a cancelled booking
 * without its reversal). Both runs are idempotent — rows carry idempotency
 * keys and volume is posted once per payment behind a marker — so this is safe
 * to run any number of times. It only ever fills in what is missing.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { BUSINESSES } = require('../config/business');
const { runInBusiness } = require('../utils/businessContext');
const PlotPayment = require('../models/plots/Payment');
const PlotBooking = require('../models/plots/Booking');
const PlotCommission = require('../models/plots/Commission');
const { INSTALMENT_STATUSES, BOOKING_STATUSES } = require('../config/plotConfig');
const { onPaymentReceived, reverseBooking } = require('../services/plots/commissionService');

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB — reconciling T2 plot commission\n');

  await runInBusiness(BUSINESSES.T2, async () => {
    // Paid instalments whose volume was never posted.
    const posted = new Set(
      (await PlotCommission.find({ idempotencyKey: /^plot:volume:/ }).select('payment').lean()).map((r) => String(r.payment))
    );
    const paid = await PlotPayment.find({ status: INSTALMENT_STATUSES.PAID }).select('_id receiptNo').sort({ paidOn: 1 }).lean();
    const missing = paid.filter((p) => !posted.has(String(p._id)));
    console.log(`Paid instalments: ${paid.length}, without commission: ${missing.length}`);
    for (const p of missing) {
      const result = await onPaymentReceived(p._id);
      console.log(`  ${p.receiptNo}: ${result.skipped ? `skipped (${result.skipped})` : 'settled'}`);
    }

    // Cancelled bookings whose reversal never completed.
    const cancelled = await PlotBooking.find({ status: BOOKING_STATUSES.CANCELLED }).select('_id code').lean();
    let fixed = 0;
    for (const b of cancelled) {
      const done = await PlotCommission.exists({ idempotencyKey: `plot:volume-reversed:${b._id}` });
      const unreversed = await PlotCommission.countDocuments({
        booking: b._id,
        type: { $in: ['direct', 'matching'] },
        amount: { $ne: 0 },
        _id: { $nin: await PlotCommission.find({ booking: b._id, reversalOf: { $ne: null } }).distinct('reversalOf') }
      });
      if (done && !unreversed) continue;
      const { reversed } = await reverseBooking(b._id, `Booking ${b.code} cancelled (reconciled)`);
      fixed++;
      console.log(`  ${b.code}: reversed ${reversed} row(s)`);
    }
    console.log(`Cancelled bookings: ${cancelled.length}, repaired: ${fixed}`);
  });

  await mongoose.disconnect();
  console.log('\nReconcile complete.');
};

run().catch(async (err) => {
  console.error('Reconcile failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
