const express = require('express');
const router = express.Router();
const {
  createReferral,
  listReferrals,
  myReferrals,
  getSummary,
  getInvoice,
  markRead,
  verifyReferral,
  cancelReferral
} = require('../controllers/referralController');
const {
  requireAuth,
  requirePasswordChanged,
  requireRole,
  ROLES
} = require('../middlewares/authMiddleware');
const { rateLimit } = require('../middlewares/rateLimit');

router.use(requireAuth, requirePasswordChanged);

const adminOnly = requireRole(ROLES.ADMIN);

// Shared by both roles — the controller scopes results by role.
router.get('/summary', getSummary);

// Associate-facing
router.get('/mine', myReferrals);
router.post(
  '/verify',
  // Blunts high-volume probing; the per-voucher attempt lockout in the
  // controller is the actual brute-force defence.
  rateLimit({ windowMs: 5 * 60_000, max: 15, message: 'Too many verification attempts. Please wait a few minutes.' }),
  verifyReferral
);
router.post('/:id/read', markRead);

// Visible to the admin AND the associate it was issued to.
router.get('/:id/invoice', getInvoice);

// Admin-only
router.post('/', adminOnly, createReferral);
router.get('/', adminOnly, listReferrals);
router.patch('/:id/cancel', adminOnly, cancelReferral);

module.exports = router;
