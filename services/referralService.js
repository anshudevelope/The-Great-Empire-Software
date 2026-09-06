const bcrypt = require('bcryptjs');
const Referral = require('../models/Referral');
const { REFERRAL_STATUSES, REFERRAL } = require('../config/constants');
const { httpError } = require('./placementService');

/**
 * Validates referralNo + PIN for a given caller.
 *
 * Shared by the verify endpoint and the redeem endpoint so the two can never
 * drift apart — redeem re-runs the full check rather than trusting that a
 * verify happened earlier, because nothing stops a client from calling redeem
 * directly.
 *
 * Returns the referral document (with pinHash selected) on success.
 */
const assertRedeemable = async (referralNo, pin, userId) => {
  if (!referralNo || !pin) {
    throw httpError('Referral number and PIN are required.', 400);
  }

  // One generic reply for "no such voucher" and "not yours" — distinguishing
  // them would let anyone probe which referral numbers exist.
  const GENERIC = 'Invalid referral number or PIN.';

  const referral = await Referral.findOne({ referralNo: String(referralNo).toUpperCase().trim() })
    .select('+pinHash');

  if (!referral) throw httpError(GENERIC, 400);
  if (String(referral.issuedTo) !== String(userId)) throw httpError(GENERIC, 400);

  // From here the caller provably owns the voucher, so specific messages are
  // safe and genuinely useful.
  if (referral.lockedUntil && referral.lockedUntil > new Date()) {
    const minutes = Math.ceil((referral.lockedUntil - Date.now()) / 60000);
    throw httpError(`Too many incorrect attempts. Try again in ${minutes} minute(s).`, 429);
  }

  if (referral.status !== REFERRAL_STATUSES.UNUSED) {
    throw httpError(`This referral has already been ${referral.status}.`, 400);
  }

  const matches = await bcrypt.compare(String(pin), referral.pinHash);

  if (!matches) {
    referral.attempts += 1;
    let message = GENERIC;
    if (referral.attempts >= REFERRAL.MAX_ATTEMPTS) {
      referral.lockedUntil = new Date(Date.now() + REFERRAL.LOCK_MINUTES * 60000);
      referral.attempts = 0;
      message = `Too many incorrect attempts. This referral is locked for ${REFERRAL.LOCK_MINUTES} minutes.`;
    }
    await referral.save();
    throw httpError(message, 400);
  }

  // Correct PIN clears the failure count.
  if (referral.attempts !== 0 || referral.lockedUntil) {
    referral.attempts = 0;
    referral.lockedUntil = null;
    await referral.save();
  }

  return referral;
};

module.exports = { assertRedeemable };
