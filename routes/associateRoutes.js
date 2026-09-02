const express = require('express');
const router = express.Router();
const { upload } = require('../config/cloudinary');
const {
  registerAssociate,
  getAllAssociates,
  getAssociateById,
  getBinaryTree,
  updateAssociate,
  updateStatus,
  deleteAssociate
} = require('../controllers/associateController');
const { verifyAdminToken } = require('../middlewares/authMiddleware');

const cpUpload = upload.fields([
  { name: 'profileImage', maxCount: 1 },
  { name: 'documents', maxCount: 5 }
]);

// Routes
router.post('/register', verifyAdminToken, cpUpload, registerAssociate);
router.get('/', verifyAdminToken, getAllAssociates);
router.get('/tree/:id', verifyAdminToken, getBinaryTree); // Fetch visual binary tree JSON
router.get('/:id', verifyAdminToken, getAssociateById);
router.put('/:id', verifyAdminToken, cpUpload, updateAssociate);
router.patch('/:id/status', verifyAdminToken, updateStatus);
router.delete('/:id', verifyAdminToken, deleteAssociate);

module.exports = router;