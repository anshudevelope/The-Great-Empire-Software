const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const jwtConfig = require('../config/jwt');
const Associate = require('../models/Associate');
const { STATUSES } = require('../config/constants');

const MIN_PASSWORD_LENGTH = 8;

const signToken = (user) =>
    jwt.sign(
        { sub: user._id, memberCode: user.memberCode || null, role: user.role },
        jwtConfig.secret,
        { expiresIn: jwtConfig.expiresIn }
    );

// ---------------------------------------------------------------------------
// POST /api/auth/login — one endpoint for both admins and associates.
//
// Replaces the previous static env-var admin check, which issued a token with
// no user id. A member portal needs the token to say WHICH associate, so both
// roles now authenticate against real records in the database.
// ---------------------------------------------------------------------------
const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required.' });
        }

        // password is select:false on the schema, so ask for it explicitly.
        const user = await Associate.findOne({ email: String(email).toLowerCase().trim() })
            .select('+password');

        // Same generic message whether the email is unknown or the password is
        // wrong — a distinct "no such user" reply turns this into an account
        // enumeration oracle.
        const invalid = { success: false, message: 'Invalid email or password.' };
        if (!user) return res.status(401).json(invalid);

        const passwordMatches = await bcrypt.compare(password, user.password);
        if (!passwordMatches) return res.status(401).json(invalid);

        if (user.status !== STATUSES.APPROVED) {
            return res.status(403).json({
                success: false,
                message: `Account is ${user.status}. Contact the administrator.`
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Login successful.',
            token: `Bearer ${signToken(user)}`,
            mustChangePassword: user.mustChangePassword,
            data: user.toJSON() // transform drops the password hash
        });
    } catch (error) {
      next(error);
    }
};

// ---------------------------------------------------------------------------
// POST /api/auth/change-password
//
// Mounted behind requireAuth but NOT requirePasswordChanged — a user holding a
// temporary password has to be able to reach exactly this route.
// ---------------------------------------------------------------------------
const changePassword = async (req, res, next) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Current password and new password are required.'
            });
        }

        if (newPassword.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`
            });
        }

        if (currentPassword === newPassword) {
            return res.status(400).json({
                success: false,
                message: 'New password must be different from the current password.'
            });
        }

        const user = await Associate.findById(req.user._id).select('+password');
        if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });

        const matches = await bcrypt.compare(currentPassword, user.password);
        if (!matches) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
        }

        user.password = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
        user.mustChangePassword = false;
        await user.save();

        // Re-issue so the client immediately holds a token for the cleared state.
        return res.status(200).json({
            success: true,
            message: 'Password updated successfully.',
            token: `Bearer ${signToken(user)}`
        });
    } catch (error) {
      next(error);
    }
};

// GET /api/auth/me — the logged-in user, for hydrating the client on reload.
const me = async (req, res) => {
    return res.status(200).json({ success: true, data: req.user });
};

module.exports = { login, changePassword, me };
