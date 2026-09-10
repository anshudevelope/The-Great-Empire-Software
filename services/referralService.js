const Associate = require('../models/Associate');
const Referral = require('../models/Referral');
const { PAYMENT_MODES, REFERRAL_STATUSES } = require('../config/constants');
const { httpError } = require('./placementService');

/**
 * Payment recorded against a referral. Shared by registration-with-sponsor and
 * the admin's Generate Referral page so both validate money the same way.
 * Everything is optional — a missing amount is recorded as 0, so the referral
 * and invoice still exist for the sponsor.
 */
const parsePayment = async (body) => {
  const amountGiven = body.amountPaid !== undefined && body.amountPaid !== null && body.amountPaid !== '';
  const amountPaid = amountGiven ? Number(body.amountPaid) : 0;
  if (!Number.isFinite(amountPaid) || amountPaid < 0) {
    throw httpError('Amount paid must be a non-negative number.', 400);
  }

  const paymentMode = body.paymentMode || null;
  if (paymentMode && !PAYMENT_MODES.includes(paymentMode)) {
    throw httpError(`paymentMode must be one of: ${PAYMENT_MODES.join(', ')}.`, 400);
  }

  let receivedOn = new Date();
  if (body.receivedOn) {
    receivedOn = new Date(body.receivedOn);
    if (Number.isNaN(receivedOn.getTime())) throw httpError('receivedOn is not a valid date.', 400);
  }
  // `receivedOn` is a DATE, not a timestamp. Flattened to midnight so same-day
  // entries tie and createdAt orders them in the invoice register.
  receivedOn.setUTCHours(0, 0, 0, 0);

  // Snapshot of who took the money, so the receipt keeps its wording even if
  // this person is later renamed or removed.
  let receiver = null;
  if (body.receivedBy) {
    receiver = await Associate.findById(body.receivedBy).select('memberCode fullName');
    if (!receiver) throw httpError('receivedBy: person not found.', 404);
  }

  return {
    amountPaid,
    paymentMode,
    paymentRef: body.paymentRef || '',
    receivedOn,
    receiver,
    notes: body.notes || ''
  };
};

// The payment/receiver fields of a Referral document, from parsePayment().
const paymentFields = (payment) => ({
  amountPaid: payment.amountPaid,
  paymentMode: payment.paymentMode,
  paymentRef: payment.paymentRef,
  receivedOn: payment.receivedOn,
  receivedBy: payment.receiver ? payment.receiver._id : null,
  receivedByName: payment.receiver ? payment.receiver.fullName : '',
  receivedByCode: payment.receiver ? payment.receiver.memberCode || '' : '',
  notes: payment.notes
});

// Closes the member's referral once they are in the tree. A missing or
// cancelled referral is fine — there is simply nothing to close.
const markReferralPlaced = (memberId, { by, position, parentCode }, session = null) =>
  Referral.findOneAndUpdate(
    { member: memberId, status: REFERRAL_STATUSES.UNUSED },
    {
      status: REFERRAL_STATUSES.USED,
      usedAt: new Date(),
      placedBy: by,
      placedPosition: position,
      placedUnderCode: parentCode
    },
    { session }
  );

module.exports = { parsePayment, paymentFields, markReferralPlaced };
