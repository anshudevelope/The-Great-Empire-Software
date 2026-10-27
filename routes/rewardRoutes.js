const express = require('express');
const router = express.Router();
const { getMine, claimMine, getChart, listClaims, approveClaim, rejectClaim } = require('../controllers/rewardController');
const { requireAuth, requireRole, ROLES } = require('../middlewares/authMiddleware');

router.use(requireAuth);

// The caller's own chart and claims — no id in the path, it comes from the token.
router.get('/me', requireRole(ROLES.ASSOCIATE), getMine);
router.post('/me/claims', requireRole(ROLES.ASSOCIATE), claimMine);

// Admin: the chart and the claims of the business the console has open.
router.get('/chart', requireRole(ROLES.ADMIN), getChart);
router.get('/claims', requireRole(ROLES.ADMIN), listClaims);
router.post('/claims/:id/approve', requireRole(ROLES.ADMIN), approveClaim);
router.post('/claims/:id/reject', requireRole(ROLES.ADMIN), rejectClaim);

module.exports = router;
