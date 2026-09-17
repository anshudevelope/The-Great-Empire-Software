const express = require('express');
const router = express.Router();
const { getPayoutSettings, updatePayoutSettings } = require('../controllers/settingsController');
const { requireAuth, requireRole, ROLES } = require('../middlewares/authMiddleware');

router.use(requireAuth);

// Admin only, both ways. These values decide what every member is paid, and one
// of them decides whether their unmatched volume is destroyed.
router.get('/payout', requireRole(ROLES.ADMIN), getPayoutSettings);
router.patch('/payout', requireRole(ROLES.ADMIN), updatePayoutSettings);

module.exports = router;
