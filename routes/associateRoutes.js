const express = require('express');
const router = express.Router();
const { upload } = require('../config/cloudinary');
const {
  registerAssociate,
  redeemReferral,
  getPlacementPreview,
  lookupByCode,
  searchAssociates,
  getAllAssociates,
  getAssociateById,
  updateAssociate,
  updateStatus,
  deleteAssociate
} = require('../controllers/associateController');
// Canonical home is /api/tree/binary/:id; this stays mounted here as an alias
// so the existing admin frontend keeps working.
const { getBinaryTree } = require('../controllers/treeController');
const {
  requireAuth,
  requirePasswordChanged,
  requireRole,
  scopeToDownline,
  requireSelfOrAdmin,
  ROLES
} = require('../middlewares/authMiddleware');
const { rateLimit } = require('../middlewares/rateLimit');

const cpUpload = upload.fields([
  { name: 'profileImage', maxCount: 1 },
  { name: 'documents', maxCount: 5 }
]);

// Every route below requires a valid session with a settled password.
router.use(requireAuth, requirePasswordChanged);

const adminOnly = requireRole(ROLES.ADMIN);

// ---------------------------------------------------------------------------
// Static paths MUST be declared before '/:id', or Express would match
// '/placement-preview' as an id and try to load an associate called that.
// ---------------------------------------------------------------------------

// Path B: an associate redeems a voucher to add a member. The voucher supplies
// the sponsor and tier; the only tree input is the leg.
router.post(
  '/redeem',
  rateLimit({ windowMs: 10 * 60_000, max: 20, message: 'Too many registration attempts. Please wait a few minutes.' }),
  cpUpload,
  redeemReferral
);

// "Will be placed under TRG0098 (3 levels below you)"
router.get('/placement-preview', getPlacementPreview);

// Searchable selects (issuedTo, receivedBy, sponsor pickers)
router.get(
  '/search',
  adminOnly,
  rateLimit({ windowMs: 60_000, max: 60 }),
  searchAssociates
);

// Sponsor-code validation on the admin form
router.get(
  '/lookup/:memberCode',
  adminOnly,
  rateLimit({ windowMs: 60_000, max: 60 }),
  lookupByCode
);

// Path A: admin creates directly (root, corrections, offline onboarding)
router.post('/register', adminOnly, cpUpload, registerAssociate);
router.get('/', adminOnly, getAllAssociates);
router.patch('/:id/status', adminOnly, updateStatus);
router.delete('/:id', adminOnly, deleteAssociate);

// Reads: admins see everyone, associates see themselves and their downline.
router.get('/tree/:id', scopeToDownline('id'), getBinaryTree);
router.get('/:id', scopeToDownline('id'), getAssociateById);

// Writes on a profile: admin anyone, associate only themselves. The controller
// then applies the role-appropriate field whitelist.
router.put('/:id', requireSelfOrAdmin('id'), cpUpload, updateAssociate);

module.exports = router;
