const express = require('express');
const router = express.Router();
const { upload } = require('../config/cloudinary');
const {
  registerAssociate,
  getPendingPlacement,
  getPlacementParents,
  placeMember,
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

router.use(requireAuth);

const adminOnly = requireRole(ROLES.ADMIN);

// ---------------------------------------------------------------------------
// Static paths MUST be declared before '/:id', or Express would match
// '/placement-preview' as an id and try to load an associate called that.
// ---------------------------------------------------------------------------

// Sponsor side: who is waiting to be placed, and where they can go.
router.get('/pending-placement', getPendingPlacement);
router.get('/placement-parents', rateLimit({ windowMs: 60_000, max: 60 }), getPlacementParents);

// "Will be placed under TGE0098 (3 levels below)"
router.get('/placement-preview', getPlacementPreview);

// Searchable selects on the admin forms — can enumerate the membership.
router.get('/search', adminOnly, rateLimit({ windowMs: 60_000, max: 60 }), searchAssociates);

router.get('/lookup/:memberCode', rateLimit({ windowMs: 60_000, max: 60 }), lookupByCode);

// Only the admin registers associates. adminOnly runs before the upload so a
// rejected request never pushes files to Cloudinary.
router.post('/register', adminOnly, cpUpload, registerAssociate);

router.get('/', adminOnly, getAllAssociates);
router.patch('/:id/status', adminOnly, updateStatus);
router.delete('/:id', adminOnly, deleteAssociate);

// A sponsor places a member they referred; the controller checks ownership.
router.post(
  '/:id/place',
  rateLimit({ windowMs: 10 * 60_000, max: 30, message: 'Too many placement attempts. Please wait a few minutes.' }),
  placeMember
);

// Reads: admins see everyone, associates see themselves and their downline.
router.get('/tree/:id', scopeToDownline('id'), getBinaryTree);
router.get('/:id', scopeToDownline('id'), getAssociateById);

// Writes on a profile: admin anyone, associate only themselves. The controller
// then applies the role-appropriate field whitelist.
router.put('/:id', requireSelfOrAdmin('id'), cpUpload, updateAssociate);

module.exports = router;
