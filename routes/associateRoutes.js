const express = require('express');
const router = express.Router();
const { upload } = require('../config/cloudinary');
const {
  registerAssociate,
  getAllAssociates,
  getAssociateById,
  updateAssociate,
  updateStatus,
  deleteAssociate
} = require('../controllers/associateController');

const cpUpload = upload.fields([
  { name: 'profileImage', maxCount: 1 },
  { name: 'documents', maxCount: 5 }
]);

// Routes
router.post('/register', cpUpload, registerAssociate);
router.get('/', getAllAssociates);
router.get('/:id', getAssociateById);
router.put('/:id', cpUpload, updateAssociate);
router.patch('/:id/status', updateStatus);
router.delete('/:id', deleteAssociate);

module.exports = router;