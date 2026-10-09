/**
 * Move a plot booking sold "upline only" into the associate's own leg.
 *
 *   node scripts/assignPlotBookingLeg.js BKG-000001 Left
 *   node scripts/assignPlotBookingLeg.js BKG-000003 Right
 *
 * Sets the booking's leg, then posts every instalment already paid on it into
 * the associate's own Left/Right leg — running their matching there. The upline
 * is not touched: it was credited when each payment came in, and a sale in the
 * associate's own leg flows up to the same people anyway. Future instalments go
 * to the own leg automatically.
 *
 * Only live bookings without a leg are accepted. Safe to re-run: each payment
 * is moved at most once (per-payment marker in the plot ledger).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { BUSINESSES } = require('../config/business');
const { POSITIONS } = require('../config/constants');
const { BOOKING_STATUSES, INSTALMENT_STATUSES } = require('../config/plotConfig');
const { runInBusiness } = require('../utils/businessContext');
const PlotBooking = require('../models/plots/Booking');
const PlotPayment = require('../models/plots/Payment');
const PlotNetwork = require('../models/plots/Network');
const { postOwnLegForPayment } = require('../services/plots/commissionService');

const [code, leg] = process.argv.slice(2);

const run = async () => {
  if (!code || ![POSITIONS.LEFT, POSITIONS.RIGHT].includes(leg)) {
    console.error('Usage: node scripts/assignPlotBookingLeg.js <BKG-code> <Left|Right>');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  await runInBusiness(BUSINESSES.T2, async () => {
    const booking = await PlotBooking.findOne({ code });
    if (!booking) throw new Error(`Booking ${code} not found.`);
    if (booking.status === BOOKING_STATUSES.CANCELLED) throw new Error(`${code} is cancelled — nothing to move.`);
    if (booking.leg && booking.leg !== leg) {
      throw new Error(`${code} is already in the ${booking.leg} leg.`);
    }

    if (!booking.leg) {
      booking.leg = leg;
      await booking.save();
    }
    console.log(`${code} → ${booking.associateCode}'s ${leg} leg`);

    const paid = await PlotPayment.find({ booking: booking._id, status: INSTALMENT_STATUSES.PAID }).sort({ seq: 1 }).lean();
    for (const p of paid) {
      const result = await postOwnLegForPayment(p._id);
      const matched = (result.matching || []).reduce((sum, r) => sum + r.amount, 0);
      console.log(
        `  ${p.receiptNo} ₹${p.paidAmount} (${p.ratingPct}%): ${result.skipped ? `skipped — ${result.skipped}` : `moved${matched ? `, matching ₹${matched}` : ''}`}`
      );
    }

    const net = await PlotNetwork.findOne({ associate: booking.associate }).lean();
    console.log(`  ${booking.associateCode} plot carry now L ₹${net?.carryLeft ?? 0} / R ₹${net?.carryRight ?? 0}`);
  });

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('Failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
