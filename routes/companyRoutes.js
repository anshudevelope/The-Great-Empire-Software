const express = require('express');
const router = express.Router();
const { company } = require('../config/company');
const { requireAuth } = require('../middlewares/authMiddleware');

/**
 * GET /api/company — public branding only.
 *
 * Deliberately a subset: the login screen needs a name and tagline before
 * anyone is authenticated, but bank details, GSTIN and PAN must not be
 * readable by the open internet.
 */
router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      name: company.name,
      legalName: company.legalName,
      tagline: company.tagline,
      website: company.website
    }
  });
});

/** The full record — letterhead, tax identifiers and bank block. */
router.get('/full', requireAuth, (req, res) => {
  res.status(200).json({ success: true, data: company });
});

module.exports = router;
