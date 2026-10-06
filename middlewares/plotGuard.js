const { requireAuth, requireRole, ROLES } = require('./authMiddleware');
const { BUSINESSES } = require('../config/business');
const { currentBusiness } = require('../utils/businessContext');

// The property / plot-sales module exists only in T2, and only the admin works
// in it. Mounted once on each plot router.
const requireT2 = (req, res, next) => {
  if (currentBusiness() !== BUSINESSES.T2) {
    return res.status(400).json({ success: false, message: 'Only available in T2 (Plots).' });
  }
  next();
};

const plotAdminOnly = [requireAuth, requireRole(ROLES.ADMIN), requireT2];

module.exports = { requireT2, plotAdminOnly };
