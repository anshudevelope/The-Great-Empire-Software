const express = require('express');
const router = express.Router();
const { login, changePassword, me } = require('../controllers/authController');
const { requireAuth } = require('../middlewares/authMiddleware');
const { rateLimit } = require('../middlewares/rateLimit');

// Throttle credential stuffing. Keyed by IP here, since there is no
// authenticated user yet at login time.
const loginLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 20,
  message: 'Too many login attempts. Please try again later.'
});

// Canonical login. The body's `audience` says which door the request came
// through, and a role that doesn't match it fails like a wrong password.
router.post('/login', loginLimiter, login);

// Legacy alias for old admin bookmarks. The audience is pinned here rather
// than read from the body — this path is the admin door by definition.
router.post('/admin/login', loginLimiter, (req, res, next) => {
  req.body = { ...req.body, audience: 'admin' };
  return login(req, res, next);
});

router.post('/change-password', requireAuth, changePassword);
router.get('/me', requireAuth, me);

module.exports = router;
