const { BUSINESSES, BUSINESS_LIST } = require('../config/business');
const { runInBusiness } = require('../utils/businessContext');

// Reads X-Business and runs the rest of the request inside that business.
// A missing header is T1, so the member portal and any older client keep
// working unchanged. cors() reflects requested headers on preflight, so
// X-Business needs no CORS config.
const resolveBusiness = (req, res, next) => {
  const raw = req.get('X-Business');
  const business = raw ? String(raw).trim().toLowerCase() : BUSINESSES.T1;

  if (!BUSINESS_LIST.includes(business)) {
    return res.status(400).json({ success: false, message: `Unknown business "${raw}".` });
  }

  return runInBusiness(business, next);
};

// For routes whose data only lives in one business whatever the header says —
// auth: the admin account and T1 associates are in T1, and T2's admin copy has
// no password to check.
const forceBusiness = (business) => (req, res, next) => runInBusiness(business, next);

module.exports = { resolveBusiness, forceBusiness };
