const express = require('express');
const router = express.Router();
const {
  createReferral,
  listReferrals,
  myReferrals,
  getSummary,
  getInvoice,
  markRead,
  cancelReferral
} = require('../controllers/referralController');
const { requireAuth, requireRole, ROLES } = require('../middlewares/authMiddleware');

router.use(requireAuth);

const adminOnly = requireRole(ROLES.ADMIN);

// Shared by both roles — the controller scopes results by role.
router.get('/summary', getSummary);

// Associate-facing
router.get('/mine', myReferrals);
router.post('/:id/read', markRead);

// Visible to the admin AND the sponsor it belongs to.
router.get('/:id/invoice', getInvoice);

// Admin-only. POST gives an already-registered, unsponsored member a sponsor
// (no PIN); new members get theirs from POST /api/associates/register.
router.post('/', adminOnly, createReferral);
router.get('/', adminOnly, listReferrals);
router.patch('/:id/cancel', adminOnly, cancelReferral);

module.exports = router;
