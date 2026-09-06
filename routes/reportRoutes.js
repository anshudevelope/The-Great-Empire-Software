const express = require('express');
const router = express.Router();
const {
  getDownline,
  getDirects,
  getLevels,
  getLegs,
  getTierSplit,
  getGrowth,
  getReferralReport,
  getPending
} = require('../controllers/reportController');
const {
  requireAuth,
  requirePasswordChanged,
  scopeToDownline
} = require('../middlewares/authMiddleware');

router.use(requireAuth, requirePasswordChanged);

// Two shapes for every member report:
//   /report        → the caller's own scope (company-wide for an admin)
//   /report/:id    → a specific member, gated by scopeToDownline
//
// resolveScopeRoot() in reportService then applies the scope. No controller
// builds its own base filter — that is how a report route ends up leaking the
// whole genealogy.
const scoped = (handler) => [scopeToDownline('id'), handler];

router.get('/downline', getDownline);
router.get('/downline/:id', ...scoped(getDownline));

router.get('/directs', getDirects);
router.get('/directs/:id', ...scoped(getDirects));

router.get('/levels', getLevels);
router.get('/levels/:id', ...scoped(getLevels));

router.get('/legs', getLegs);
router.get('/legs/:id', ...scoped(getLegs));

router.get('/tiers', getTierSplit);
router.get('/tiers/:id', ...scoped(getTierSplit));

router.get('/growth', getGrowth);
router.get('/growth/:id', ...scoped(getGrowth));

router.get('/pending', getPending);
router.get('/pending/:id', ...scoped(getPending));

// Voucher / money-received report — scoped by role inside the controller
// (admin sees everyone, an associate only vouchers issued to them).
router.get('/referrals', getReferralReport);

module.exports = router;
