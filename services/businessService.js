const Associate = require('../models/Associate');
const Counter = require('../models/Counter');
const { MEMBER_CODE } = require('../config/constants');
const { BUSINESSES, MEMBER_CODE_START } = require('../config/business');
const { runInBusiness, connectionFor, registeredModelNames } = require('../utils/businessContext');

// One setup per business per process. The promise is cached, not a flag, so
// two simultaneous first requests share one run instead of racing.
const setups = new Map();
const mirrored = new Set();

/**
 * First use of a business in this process: raise the member-code counter so
 * codes start at MEMBER_CODE_START (TGE20001 for T2), and build every index
 * before the first write relies on it (unique email, ledger idempotency key).
 * Idempotent: raiseTo never lowers, init() is a no-op once indexes exist.
 */
const setUpBusiness = (business) => {
  if (!setups.has(business)) {
    const run = runInBusiness(business, async () => {
      await Counter.raiseTo(MEMBER_CODE.SEQUENCE, MEMBER_CODE_START[business]);
      const conn = connectionFor(business);
      await Promise.all(registeredModelNames().map((name) => conn.models[name].init()));
    });
    // A failed setup must be retried by the next request, not cached forever.
    setups.set(business, run.catch((err) => { setups.delete(business); throw err; }));
  }
  return setups.get(business);
};

/**
 * T2 records point at the admin (issuedBy, updatedBy, audit actor, admin as a
 * sponsor option), and populate() looks those up in T2's own collection. So
 * T2 holds a copy of the admin under the same _id — without the password
 * fields, since login only ever reads T1.
 */
const mirrorAdmin = async (business, admin) => {
  const key = `${business}:${admin._id}`;
  if (mirrored.has(key)) return;

  const source = await runInBusiness(BUSINESSES.T1, () => Associate.findById(admin._id).lean());
  if (!source) return;
  const { password, passwordEnc, ...copy } = source;

  // Raw collection write: the copy is not a registration and must not run
  // validation or hooks meant for one.
  await runInBusiness(business, () =>
    Associate.collection.updateOne({ _id: copy._id }, { $set: copy }, { upsert: true })
  );
  mirrored.add(key);
};

const ensureBusinessReady = async (business, admin) => {
  if (business === BUSINESSES.T1) return;
  await setUpBusiness(business);
  await mirrorAdmin(business, admin);
};

module.exports = { ensureBusinessReady };
