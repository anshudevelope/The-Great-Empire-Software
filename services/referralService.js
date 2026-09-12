const Referral = require('../models/Referral');
const { PAYMENT_MODES, REFERRAL_STATUSES } = require('../config/constants');
const { httpError } = require('./placementService');

/**
 * Payment recorded against a referral. Shared by registration-with-sponsor, the
 * admin's Edit page and the Generate Referral page so all three validate money
 * the same way. Everything is optional — a missing amount is recorded as 0, so
 * the referral and invoice still exist for the sponsor.
 *
 * Who received the money is NOT read from the request: it is always the admin
 * recording it — see receiverFields().
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

  return {
    amountPaid,
    paymentMode,
    paymentRef: body.paymentRef || '',
    receivedOn,
    notes: body.notes || ''
  };
};

// The payment fields of a Referral document, from parsePayment().
const paymentFields = (payment) => ({
  amountPaid: payment.amountPaid,
  paymentMode: payment.paymentMode,
  paymentRef: payment.paymentRef,
  receivedOn: payment.receivedOn,
  notes: payment.notes
});

// The receiver is always the signed-in admin recording the payment. Stored as a
// snapshot so the record keeps its wording even if that account is later
// renamed or removed.
const receiverFields = (user) => ({
  receivedBy: user._id,
  receivedByName: user.fullName || '',
  receivedByCode: user.memberCode || ''
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

module.exports = { parsePayment, paymentFields, receiverFields, markReferralPlaced };
