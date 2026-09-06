const express = require('express');
const router = express.Router();
const {
  getBinaryTree,
  getSponsorTree,
  getDirects,
  getUpline
} = require('../controllers/treeController');
const {
  requireAuth,
  requirePasswordChanged,
  scopeToDownline
} = require('../middlewares/authMiddleware');

router.use(requireAuth, requirePasswordChanged);

// The bare paths mean "my own tree" — the common case for the member portal,
// and it keeps the client from having to know its own id.
const useSelf = (req, _res, next) => {
  req.params.id = String(req.user._id);
  next();
};

// Binary (placement) tree — where business volume flows.
router.get('/binary', useSelf, getBinaryTree);
router.get('/binary/:id', scopeToDownline('id'), getBinaryTree);

// Sponsor (referral) tree — who introduced whom.
router.get('/sponsor', useSelf, getSponsorTree);
router.get('/sponsor/:id', scopeToDownline('id'), getSponsorTree);

// Flat list of people this member personally referred.
router.get('/directs', useSelf, getDirects);
router.get('/directs/:id', scopeToDownline('id'), getDirects);

// Ancestor chain, truncated at the viewer for non-admins.
router.get('/upline', useSelf, getUpline);
router.get('/upline/:id', scopeToDownline('id'), getUpline);

module.exports = router;
