const crypto = require('crypto');
const Counter = require('../models/Counter');
const { MEMBER_CODE, REFERRAL, INVOICE } = require('../config/constants');

// TRG0001, TRG0042 … widens past TRG9999 on its own.
const formatMemberCode = (seq) =>
  `${MEMBER_CODE.PREFIX}${String(seq).padStart(MEMBER_CODE.PAD, '0')}`;

// Mints the next member code. The very first associate an admin registers
// becomes TRG0001 — the tree root. Codes are never reused, even after a delete.
const nextMemberCode = async (session = null) => {
  const seq = await Counter.next(MEMBER_CODE.SEQUENCE, session);
  return formatMemberCode(seq);
};

// REF-000123
const formatReferralNo = (seq) =>
  `${REFERRAL.PREFIX}${String(seq).padStart(REFERRAL.PAD, '0')}`;

const nextReferralNo = async (session = null) => {
  const seq = await Counter.next(REFERRAL.SEQUENCE, session);
  return formatReferralNo(seq);
};

// INV-2026-000123 — the sequence restarts each year, so the counter is keyed
// per year (invoiceNo:2026).
const nextInvoiceNo = async (session = null, date = new Date()) => {
  const year = date.getFullYear();
  const seq = await Counter.next(`${INVOICE.SEQUENCE}:${year}`, session);
  return `${INVOICE.PREFIX}${year}-${String(seq).padStart(INVOICE.PAD, '0')}`;
};

// Cryptographically secure numeric PIN. Math.random() is not acceptable here —
// this value is worth money and must not be predictable from other PINs.
const generatePin = (length = REFERRAL.PIN_LENGTH) => {
  let pin = '';
  for (let i = 0; i < length; i++) pin += crypto.randomInt(0, 10);
  return pin;
};

module.exports = {
  formatMemberCode,
  nextMemberCode,
  formatReferralNo,
  nextReferralNo,
  nextInvoiceNo,
  generatePin
};
