const express = require('express');
const router = express.Router();
const {
  getBatches,
  getDraft,
  createDraft,
  finalize,
  cancel,
  discard,
  getBatch,
  getLines,
  getMyPayouts
} = require('../controllers/payoutController');
const { requireAuth, requireRole, ROLES } = require('../middlewares/authMiddleware');

router.use(requireAuth);

// ---------------------------------------------------------------------------
// Literal segments FIRST.
//
// '/me' and '/draft' have the same shape as '/:id' — one segment — so Express
// matches whichever is declared first. Registered after '/:id', a request for
// /api/payouts/me would be handled as a batch lookup for the id "me": a 400 for
// the member, and an admin-only route reached by a non-admin.
// ---------------------------------------------------------------------------

// The only route an associate may call. No id in the path: the member comes
// from the token, so there is nothing for a client to tamper with.
router.get('/me', getMyPayouts);

const admin = requireRole(ROLES.ADMIN);

router.get('/draft', admin, getDraft);
router.post('/preview', admin, createDraft);

router.get('/', admin, getBatches);
router.get('/:id', admin, getBatch);
router.get('/:id/lines', admin, getLines);
router.post('/:id/finalize', admin, finalize);
router.post('/:id/cancel', admin, cancel);
router.delete('/:id', admin, discard);

module.exports = router;
