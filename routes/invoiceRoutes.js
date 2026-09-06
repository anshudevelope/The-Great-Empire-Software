const express = require('express');
const router = express.Router();
const { listInvoices, getInvoice, getCompany } = require('../controllers/invoiceController');
const { requireAuth, requirePasswordChanged } = require('../middlewares/authMiddleware');

router.use(requireAuth, requirePasswordChanged);

// Static path before '/:id', or "company" would be read as an invoice id.
router.get('/company', getCompany);

// Both roles; the controller scopes an associate to invoices billed to them.
router.get('/', listInvoices);
router.get('/:id', getInvoice);

module.exports = router;
