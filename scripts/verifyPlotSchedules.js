/**
 * Checks every T2 booking's schedule, receipts and commission agree.
 *
 *   npm run verify:plots
 *
 * Read-only. For each booking:
 *   - live schedule (not superseded) + prepayments = price
 *   - paidTotal = Σ receipts = Σ instalments paid + prepayments
 *   - each receipt's allocations add up to its amount
 *   - completed ⇔ nothing left open (live bookings)
 *   - commission: direct = 5% of Σ commissionBase (live bookings),
 *     every money row reversed (cancelled bookings)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { BUSINESSES } = require('../config/business');
const { runInBusiness } = require('../utils/businessContext');
const PlotBooking = require('../models/plots/Booking');
const PlotPayment = require('../models/plots/Payment');
const PlotReceipt = require('../models/plots/Receipt');
const PlotCommission = require('../models/plots/Commission');
const { BOOKING_STATUSES, INSTALMENT_STATUSES, OPEN_INSTALMENT_STATUSES, PLOT_COMMISSION, PREPAYMENT } = require('../config/plotConfig');
const { COMMISSION_TYPES } = require('../config/constants');
const { round2 } = require('../services/plots/helpers');

const sum = (xs, f) => round2(xs.reduce((s, x) => s + f(x), 0));
const near = (a, b, tolerance = 0.01) => Math.abs(a - b) <= tolerance + 1e-9;

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  let problems = 0;

  await runInBusiness(BUSINESSES.T2, async () => {
    const bookings = await PlotBooking.find().sort({ code: 1 }).lean();
    for (const b of bookings) {
      const issues = [];
      const [rows, receipts, money] = await Promise.all([
        PlotPayment.find({ booking: b._id, status: { $ne: INSTALMENT_STATUSES.SUPERSEDED } }).lean(),
        PlotReceipt.find({ booking: b._id }).lean(),
        PlotCommission.find({ booking: b._id, amount: { $ne: 0 } }).lean()
      ]);
      const prepaid = sum(receipts, (r) => sum(r.allocations.filter((a) => a.kind === PREPAYMENT), (a) => a.amount));
      const received = sum(receipts, (r) => r.amount);

      if (received !== round2(b.paidTotal)) issues.push(`paidTotal ${b.paidTotal} ≠ receipts ${received}`);
      for (const r of receipts) {
        const allocated = sum(r.allocations, (a) => a.amount);
        if (allocated !== round2(r.amount)) issues.push(`${r.receiptNo}: allocations ${allocated} ≠ amount ${r.amount}`);
      }

      if (b.status !== BOOKING_STATUSES.CANCELLED) {
        const scheduled = round2(sum(rows, (r) => r.dueAmount) + prepaid);
        if (scheduled !== round2(b.price)) issues.push(`schedule + prepayments ${scheduled} ≠ price ${b.price}`);
        const rowsPaid = round2(sum(rows, (r) => r.paidAmount) + prepaid);
        if (rowsPaid !== round2(b.paidTotal)) issues.push(`instalments paid + prepayments ${rowsPaid} ≠ paidTotal ${b.paidTotal}`);
        const open = rows.some((r) => OPEN_INSTALMENT_STATUSES.includes(r.status));
        if (open === (b.status === BOOKING_STATUSES.COMPLETED)) issues.push(`status ${b.status} but ${open ? 'rows still open' : 'nothing open'}`);

        const direct = sum(money.filter((m) => m.type === COMMISSION_TYPES.DIRECT), (m) => m.amount);
        const expected = round2(PLOT_COMMISSION.direct * sum(receipts, (r) => r.commissionBase));
        if (!near(direct, expected, 0.01 * receipts.length)) issues.push(`direct commission ${direct} ≠ ${expected}`);
      } else {
        const net = sum(money, (m) => m.amount);
        if (!near(net, 0)) issues.push(`cancelled but commission nets to ${net}`);
      }

      if (issues.length) {
        problems += issues.length;
        console.log(`${b.code}:`);
        issues.forEach((i) => console.log(`  - ${i}`));
      }
    }
    console.log(problems ? `\n${problems} problem(s).` : `All ${bookings.length} booking(s) consistent.`);
  });

  await mongoose.disconnect();
  if (problems) process.exitCode = 1;
};

run().catch(async (err) => {
  console.error('Verify failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
