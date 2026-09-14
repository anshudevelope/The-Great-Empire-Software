const express = require('express');
const router = express.Router();
const {
  getMyLedger,
  getMySummary,
  getMemberLedger,
  getMemberSummary,
  getAdminLedger,
  getLiability,
  reverseCommission
} = require('../controllers/commissionController');
const { requireAuth, requireRole, scopeToDownline, ROLES } = require('../middlewares/authMiddleware');

router.use(requireAuth);

// ---------------------------------------------------------------------------
// Admin-only. Every one of these reads company-wide data, so the role gate is
// on the route rather than inside the handler — a handler that forgets the
// check is a silent leak, a missing middleware is a visible 403.
// ---------------------------------------------------------------------------
router.get('/admin', requireRole(ROLES.ADMIN), getAdminLedger);
router.get('/admin/liability', requireRole(ROLES.ADMIN), getLiability);
router.post('/admin/reverse/:ledgerId', requireRole(ROLES.ADMIN), reverseCommission);

// The caller's own ledger. No id in the path at all — the beneficiary comes
// from the token, so there is nothing for a client to tamper with.
router.get('/me', getMyLedger);
router.get('/me/summary', getMySummary);

// Reading a downline member's ledger. scopeToDownline is doing the real work:
// an associate may read anyone beneath them and nobody else, and the 403 is
// worded identically whether the member is missing or simply outside their
// network, so the response never reveals the shape of the tree.
router.get('/member/:id', scopeToDownline('id'), getMemberLedger);
router.get('/member/:id/summary', scopeToDownline('id'), getMemberSummary);

module.exports = router;
