const PlotBooking = require('../../models/plots/Booking');
const PlotPayment = require('../../models/plots/Payment');
const PlotReceipt = require('../../models/plots/Receipt');
const { BOOKING_STATUSES, INSTALMENT_STATUSES, OPEN_INSTALMENT_STATUSES, PREPAYMENT } = require('../../config/plotConfig');
const { planPayment } = require('./scheduleService');
const { round2, httpError, nextReceiptNo } = require('./helpers');

const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

const openRows = (bookingId, session = null) =>
  PlotPayment.find({ booking: bookingId, status: { $in: OPEN_INSTALMENT_STATUSES } }).sort({ seq: 1 }).session(session);

const loadActive = async (bookingId, session = null) => {
  const booking = await PlotBooking.findById(bookingId).session(session);
  if (!booking) throw httpError('Booking not found.', 404);
  if (booking.status === BOOKING_STATUSES.PENDING) throw httpError('This booking is pending — approve it once the cheque clears.', 409);
  if (booking.status !== BOOKING_STATUSES.ACTIVE) throw httpError('This booking is not active.', 409);
  return booking;
};

// Where the money went, as stored on the receipt.
const allocationsOf = (plan) => [
  ...plan.fills.map(({ row, amount }) => ({ instalment: row._id, seq: row.seq, kind: row.kind, amount })),
  ...(plan.prepayment > 0 ? [{ instalment: null, seq: null, kind: PREPAYMENT, amount: plan.prepayment }] : [])
];

/** What a payment would do, without writing anything — for the form's preview. */
const previewPayment = async ({ bookingId, amount, paidOn, adjustment = null }) => {
  const booking = await loadActive(bookingId);
  const plan = planPayment({ booking, rows: await openRows(booking._id).lean(), amount, paidOn, adjustment });
  return {
    balance: plan.balance,
    dueNow: plan.dueNow,
    extra: plan.extra,
    needsChoice: plan.needsChoice,
    completes: plan.completes,
    balanceAfter: plan.balanceAfter,
    adjustment: plan.adjustment,
    allocations: allocationsOf(plan),
    newSchedule: plan.newRows
  };
};

/**
 * Record one payment inside the caller's transaction: fill the instalments it
 * pays, reshape the schedule when the admin chose to, move the booking's
 * totals and issue the receipt. The receipt number is minted inside the
 * transaction, so a retried attempt never leaves a second receipt behind.
 *
 * Commission is NOT run here — the caller settles the receipt after commit.
 */
const recordPayment = async (
  { bookingId, amount, paidOn, mode = null, reference = '', notes = '', ratingPct = 100, adjustment = null, actor = null },
  session
) => {
  const booking = await loadActive(bookingId, session);
  const plan = planPayment({ booking, rows: await openRows(booking._id, session), amount, paidOn, adjustment });
  if (plan.needsChoice) {
    throw httpError(`Choose how to apply the extra ${inr(plan.extra)}: reduce EMI, reduce tenure or pay upcoming EMIs.`);
  }

  for (const { row, amount: part } of plan.fills) {
    row.paidAmount = round2(row.paidAmount + part);
    row.status = row.paidAmount >= row.dueAmount ? INSTALMENT_STATUSES.PAID : INSTALMENT_STATUSES.PARTIAL;
    row.lastPaidOn = paidOn;
    await row.save({ session });
  }

  if (plan.newRows.length) {
    await PlotPayment.updateMany(
      { _id: { $in: plan.supersede.map((r) => r._id) } },
      { $set: { status: INSTALMENT_STATUSES.SUPERSEDED } },
      { session }
    );
    booking.revision += 1;
    await PlotPayment.create(
      plan.newRows.map((r) => ({
        ...r,
        revision: booking.revision,
        booking: booking._id,
        plot: booking.plot,
        project: booking.project,
        client: booking.client,
        associate: booking.associate
      })),
      { session, ordered: true }
    );
    booking.emiAmount = plan.adjustment.after.emi;
    booking.tenureMonths = plan.newRows[plan.newRows.length - 1].seq;
  }

  booking.paidTotal = round2(booking.paidTotal + round2(amount));
  if (plan.completes) booking.status = BOOKING_STATUSES.COMPLETED;
  await booking.save({ session });

  const [receipt] = await PlotReceipt.create(
    [
      {
        booking: booking._id,
        plot: booking.plot,
        project: booking.project,
        client: booking.client,
        associate: booking.associate,
        amount: round2(amount),
        paidOn,
        mode: mode || null,
        reference,
        notes,
        ratingPct,
        receiptNo: await nextReceiptNo(session, paidOn),
        receivedBy: actor?._id ?? null,
        receivedByCode: actor?.memberCode ?? null,
        allocations: allocationsOf(plan),
        adjustment: plan.adjustment,
        balanceAfter: plan.balanceAfter
      }
    ],
    { session }
  );
  return receipt;
};

module.exports = { previewPayment, recordPayment };
