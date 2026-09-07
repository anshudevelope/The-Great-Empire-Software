/**
 * Re-codes existing member codes to the CURRENT prefix in config/constants.js.
 *
 *   npm run recode
 *
 * Use after changing MEMBER_CODE.PREFIX (e.g. TRG → TGE). The numeric part is
 * kept, so TRG0005 becomes TGE0005 and every member keeps their identity.
 *
 * The rename is only half the job: member codes are denormalised onto other
 * documents for fast reads (sponsorMemberCode, referral issuedToCode, invoice
 * lines…). Renaming the source without those would leave dangling references
 * that no query would ever match again — so this rewrites them together.
 *
 * Safe to re-run: codes already on the current prefix are left alone.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Associate = require('../models/Associate');
const Referral = require('../models/Referral');
const { ROLES, MEMBER_CODE } = require('../config/constants');

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. Target prefix: ${MEMBER_CODE.PREFIX}\n`);

  const associates = await Associate.find({ role: ROLES.ASSOCIATE })
    .select('memberCode sponsorMemberCode')
    .sort({ createdAt: 1 })
    .lean();

  // old code -> new code, for every member whose prefix is out of date.
  const rename = new Map();
  for (const a of associates) {
    const match = /^([A-Za-z]+)(\d+)$/.exec(a.memberCode || '');
    if (!match) continue;
    const [, prefix, digits] = match;
    if (prefix.toUpperCase() === MEMBER_CODE.PREFIX.toUpperCase()) continue;
    rename.set(a.memberCode, `${MEMBER_CODE.PREFIX}${digits}`);
  }

  if (!rename.size) {
    console.log('Every member code already uses the current prefix — nothing to do.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Renaming ${rename.size} member codes:`);
  for (const [from, to] of rename) console.log(`  ${from} -> ${to}`);
  console.log('');

  const map = (code) => (code && rename.has(code) ? rename.get(code) : null);

  // --- 1. The codes themselves ---------------------------------------------
  const codeOps = associates
    .filter((a) => rename.has(a.memberCode))
    .map((a) => ({
      updateOne: { filter: { _id: a._id }, update: { $set: { memberCode: rename.get(a.memberCode) } } }
    }));
  if (codeOps.length) await Associate.bulkWrite(codeOps);
  console.log(`associates.memberCode        : ${codeOps.length} updated`);

  // --- 2. Denormalised sponsor references ----------------------------------
  const sponsorOps = associates
    .filter((a) => map(a.sponsorMemberCode))
    .map((a) => ({
      updateOne: { filter: { _id: a._id }, update: { $set: { sponsorMemberCode: map(a.sponsorMemberCode) } } }
    }));
  if (sponsorOps.length) await Associate.bulkWrite(sponsorOps);
  console.log(`associates.sponsorMemberCode : ${sponsorOps.length} updated`);

  // --- 3. Codes copied onto referrals / invoices ---------------------------
  const referrals = await Referral.find({})
    .select('memberCode issuedToCode receivedByCode placedUnderCode')
    .lean();

  const referralOps = [];
  for (const r of referrals) {
    const set = {};
    for (const field of ['memberCode', 'issuedToCode', 'receivedByCode', 'placedUnderCode']) {
      const next = map(r[field]);
      if (next) set[field] = next;
    }
    if (Object.keys(set).length) {
      referralOps.push({ updateOne: { filter: { _id: r._id }, update: { $set: set } } });
    }
  }
  if (referralOps.length) await Referral.bulkWrite(referralOps);
  console.log(`referrals (all code fields)  : ${referralOps.length} updated`);

  console.log('\nRe-code complete.');
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('Re-code failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
