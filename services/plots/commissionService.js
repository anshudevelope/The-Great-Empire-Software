const Associate = require('../../models/Associate');
const PlotCommission = require('../../models/plots/Commission');
const PlotNetwork = require('../../models/plots/Network');
const PlotPayment = require('../../models/plots/Payment');
const PlotBooking = require('../../models/plots/Booking');
const { COMMISSION_TYPES, POSITIONS } = require('../../config/constants');
const { PLOT_COMMISSION, INSTALMENT_STATUSES, BOOKING_STATUSES } = require('../../config/plotConfig');
// Read-only helpers from the registration engine: walking the tree is the same
// for both. Nothing here writes to a registration model or ledger.
const { loadAncestorChain, resolveLegSides } = require('../commissionService');
const { round2 } = require('./helpers');

// ---------------------------------------------------------------------------
// Plot commission — its own ledger (PlotCommission) and its own carry pool
// (PlotNetwork), entirely separate from registration.
//
// Runs AFTER a payment's transaction commits, never inside it, for the same
// reasons as registration (see services/commissionService.js): a duplicate key
// is the "already paid" signal and must not abort a transaction. Every write
// is a single-document atomic operation, and every row has an idempotency key,
// so a run can be repeated safely (scripts/reconcilePlotCommissions.js).
// ---------------------------------------------------------------------------

const CARRY = { [POSITIONS.LEFT]: 'carryLeft', [POSITIONS.RIGHT]: 'carryRight' };
const VOLUME = { [POSITIONS.LEFT]: 'totalLeftVolume', [POSITIONS.RIGHT]: 'totalRightVolume' };
const RATED = { [POSITIONS.LEFT]: 'totalLeftRatedVolume', [POSITIONS.RIGHT]: 'totalRightRatedVolume' };

// Insert a ledger row; a duplicate key means it already exists → null.
const writeRow = async (row) => {
  try {
    const [created] = await PlotCommission.create([row]);
    return created;
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
};

const earn = (associateId, memberCode, field, amount) =>
  PlotNetwork.updateOne(
    { associate: associateId },
    { $inc: { [field]: amount }, $setOnInsert: { memberCode } },
    { upsert: true }
  );

// The credited associate as the tree sees them.
const loadSeller = (id) =>
  Associate.findById(id).select('_id memberCode position ancestors treeStatus status').lean();

/** 5% direct to the associate the sale is credited to. */
const payDirect = async (payment, booking, seller) => {
  const rate = PLOT_COMMISSION.direct;
  const base = payment.commissionBase;
  if (!rate || !(base > 0)) return null;

  const amount = round2(rate * base);
  const created = await writeRow({
    idempotencyKey: `plot:direct:${payment._id}`,
    beneficiary: seller._id,
    beneficiaryCode: seller.memberCode,
    type: COMMISSION_TYPES.DIRECT,
    amount,
    sourceAssociate: seller._id,
    sourceAssociateCode: seller.memberCode,
    booking: booking._id,
    bookingCode: booking.code,
    payment: payment._id,
    basis: { rate, base, rating: payment.ratingPct }
  });

  if (created) await earn(seller._id, seller.memberCode, 'directEarned', amount);
  return created;
};

/**
 * 5% of min(carryLeft, carryRight) in the PLOT pool, at every ancestor of the
 * seller. Same mechanics as registration matching — add the volume and read
 * the result in one atomic operation, claim the matched carry with a guarded
 * update before paying, give it back if the row turns out to exist already.
 */
const payMatching = async (payment, booking, seller) => {
  const commissionVolume = payment.commissionBase;
  const businessVolume = payment.paidAmount;
  if (!(commissionVolume > 0) && !(businessVolume > 0)) return [];

  const ordered = await loadAncestorChain(seller);
  if (!ordered.length) return [];

  const rate = PLOT_COMMISSION.matching;
  const written = [];

  for (const { ancestor, side, depthFromSource } of resolveLegSides(seller, ordered)) {
    const after = await PlotNetwork.findOneAndUpdate(
      { associate: ancestor._id },
      {
        $inc: { [CARRY[side]]: commissionVolume, [VOLUME[side]]: businessVolume, [RATED[side]]: commissionVolume },
        $setOnInsert: { memberCode: ancestor.memberCode }
      },
      { upsert: true, returnDocument: 'after', projection: 'carryLeft carryRight' }
    );

    if (!rate || !(commissionVolume > 0)) continue;
    const matched = round2(Math.min(after.carryLeft, after.carryRight));
    if (matched <= 0) continue;

    const deducted = await PlotNetwork.findOneAndUpdate(
      { associate: ancestor._id, carryLeft: { $gte: matched }, carryRight: { $gte: matched } },
      { $inc: { carryLeft: -matched, carryRight: -matched } },
      { returnDocument: 'after', projection: 'carryLeft carryRight' }
    );
    if (!deducted) continue;

    const amount = round2(rate * matched);
    const created = await writeRow({
      idempotencyKey: `plot:match:${ancestor._id}:${payment._id}`,
      beneficiary: ancestor._id,
      beneficiaryCode: ancestor.memberCode,
      type: COMMISSION_TYPES.MATCHING,
      amount,
      sourceAssociate: seller._id,
      sourceAssociateCode: seller.memberCode,
      booking: booking._id,
      bookingCode: booking.code,
      payment: payment._id,
      basis: {
        rate,
        base: matched,
        legSide: side,
        carryLeftBefore: after.carryLeft,
        carryRightBefore: after.carryRight,
        carryLeftAfter: deducted.carryLeft,
        carryRightAfter: deducted.carryRight,
        depthFromSource
      }
    });

    if (created) {
      await earn(ancestor._id, ancestor.memberCode, 'matchingEarned', amount);
      written.push(created);
    } else {
      // Already paid by an earlier run — the carry we just took belongs to it.
      await PlotNetwork.updateOne({ associate: ancestor._id }, { $inc: { carryLeft: matched, carryRight: matched } });
    }
  }

  return written;
};

/**
 * Entry point after a payment is received. Idempotent.
 *
 * The volume is posted to the upline only once per payment: a replay finds the
 * direct row already present and stops before touching carry again, which
 * would otherwise double the volume.
 */
const onPaymentReceived = async (paymentId) => {
  const payment = await PlotPayment.findById(paymentId).lean();
  if (!payment || payment.status !== INSTALMENT_STATUSES.PAID) return { skipped: 'not paid' };

  const booking = await PlotBooking.findById(payment.booking).select('_id code associate status').lean();
  if (!booking) return { skipped: 'booking not found' };
  // A replay after cancellation must not pay on a sale that no longer exists.
  if (booking.status === BOOKING_STATUSES.CANCELLED) return { skipped: 'booking cancelled' };

  const seller = await loadSeller(booking.associate);
  if (!seller) return { skipped: 'associate not found' };

  const alreadyRun = await PlotCommission.exists({ idempotencyKey: `plot:volume:${payment._id}` });
  if (alreadyRun) return { skipped: 'already settled' };

  const direct = await payDirect(payment, booking, seller);
  const matching = await payMatching(payment, booking, seller);

  // Marker that this payment's volume has been posted — written LAST so a
  // crash part-way leaves it absent and reconcile can finish the job (direct
  // and matching rows are individually idempotent).
  await writeRow({
    idempotencyKey: `plot:volume:${payment._id}`,
    beneficiary: seller._id,
    beneficiaryCode: seller.memberCode,
    type: COMMISSION_TYPES.DIRECT,
    amount: 0,
    sourceAssociate: seller._id,
    sourceAssociateCode: seller.memberCode,
    booking: booking._id,
    bookingCode: booking.code,
    payment: payment._id,
    basis: { rate: 0, base: payment.commissionBase },
    note: 'volume posted'
  });

  return { direct, matching };
};

/** onPaymentReceived that never throws — the payment has already committed. */
const settlePayment = async (paymentId) => {
  try {
    return await onPaymentReceived(paymentId);
  } catch (err) {
    console.error(`[plot-commission] payment ${paymentId} failed; reconcile:plots will retry.`, err.message);
    return { error: err.message };
  }
};

/**
 * Undo everything a cancelled booking earned.
 *
 *  1. Every non-reversed money row (direct and matching) gets a REVERSAL row,
 *     and the earned totals come down by the same amount.
 *  2. Each reversed matching row gave up `base` from BOTH carries of its
 *     beneficiary; that pair is no longer paid, so it goes back to both.
 *  3. The booking's own volume is then taken out of every ancestor's leg — the
 *     sale never happened. Carry is floored at 0: if a later booking already
 *     matched against this one's leftover carry, that small amount is not
 *     clawed back from the other booking (reconcile reports it).
 */
const reverseBooking = async (bookingId, reason = 'Booking cancelled') => {
  const booking = await PlotBooking.findById(bookingId).select('_id code associate').lean();
  if (!booking) return { reversed: 0 };

  const rows = await PlotCommission.find({
    booking: booking._id,
    type: { $in: [COMMISSION_TYPES.DIRECT, COMMISSION_TYPES.MATCHING] },
    amount: { $ne: 0 }
  }).lean();

  let reversed = 0;
  for (const original of rows) {
    const created = await writeRow({
      idempotencyKey: `plot:reversal:${original._id}`,
      beneficiary: original.beneficiary,
      beneficiaryCode: original.beneficiaryCode,
      type: COMMISSION_TYPES.REVERSAL,
      amount: -original.amount,
      sourceAssociate: original.sourceAssociate,
      sourceAssociateCode: original.sourceAssociateCode,
      booking: original.booking,
      bookingCode: original.bookingCode,
      payment: original.payment,
      basis: { rate: original.basis.rate, base: original.basis.base },
      reversalOf: original._id,
      note: reason
    });
    if (!created) continue; // already reversed by an earlier attempt
    reversed++;

    const field = original.type === COMMISSION_TYPES.DIRECT ? 'directEarned' : 'matchingEarned';
    await PlotNetwork.updateOne({ associate: original.beneficiary }, { $inc: { [field]: -original.amount } });

    if (original.type === COMMISSION_TYPES.MATCHING) {
      await PlotNetwork.updateOne(
        { associate: original.beneficiary },
        { $inc: { carryLeft: original.basis.base, carryRight: original.basis.base } }
      );
    }
  }

  // Take the booking's volume back out of the upline — once, guarded by a marker.
  const marker = await writeRow({
    idempotencyKey: `plot:volume-reversed:${booking._id}`,
    beneficiary: booking.associate,
    beneficiaryCode: (await Associate.findById(booking.associate).select('memberCode').lean())?.memberCode || '—',
    type: COMMISSION_TYPES.REVERSAL,
    amount: 0,
    sourceAssociate: booking.associate,
    sourceAssociateCode: '—',
    booking: booking._id,
    bookingCode: booking.code,
    basis: { rate: 0, base: 0 },
    note: 'volume reversed'
  });

  if (marker) {
    const posted = await PlotCommission.find({ booking: booking._id, idempotencyKey: /^plot:volume:/ })
      .select('payment')
      .lean();
    const payments = await PlotPayment.find({ _id: { $in: posted.map((p) => p.payment) } })
      .select('paidAmount commissionBase')
      .lean();
    const rated = round2(payments.reduce((s, p) => s + (p.commissionBase || 0), 0));
    const whole = round2(payments.reduce((s, p) => s + (p.paidAmount || 0), 0));

    try {
      const seller = await loadSeller(booking.associate);
      if (seller && (rated > 0 || whole > 0)) {
        const ordered = await loadAncestorChain(seller);
        for (const { ancestor, side } of resolveLegSides(seller, ordered)) {
          await PlotNetwork.updateOne(
            { associate: ancestor._id },
            [
              {
                $set: {
                  [CARRY[side]]: { $max: [0, { $subtract: [`$${CARRY[side]}`, rated] }] },
                  [VOLUME[side]]: { $max: [0, { $subtract: [`$${VOLUME[side]}`, whole] }] },
                  [RATED[side]]: { $max: [0, { $subtract: [`$${RATED[side]}`, rated] }] }
                }
              }
            ],
            { updatePipeline: true }
          );
        }
      }
    } catch (err) {
      // Release the claim so a retry can take the volume out; otherwise the
      // marker would say "done" for work that never happened.
      await PlotCommission.deleteOne({ _id: marker._id });
      throw err;
    }
  }

  return { reversed };
};

module.exports = { onPaymentReceived, settlePayment, reverseBooking };
