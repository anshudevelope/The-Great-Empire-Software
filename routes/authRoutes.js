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

// Canonical login for both roles — the token identifies which user.
router.post('/login', loginLimiter, login);

// Legacy alias kept so the existing admin frontend keeps working until it
// moves to /auth/login in the frontend phase.
router.post('/admin/login', loginLimiter, login);

router.post('/change-password', requireAuth, changePassword);
router.get('/me', requireAuth, me);

module.exports = router;
