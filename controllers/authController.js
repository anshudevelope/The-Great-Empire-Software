// const jwt = require('jsonwebtoken');
// const bcrypt = require('bcryptjs');
// const jwtConfig = require('../config/jwt');
// const Associate = require('../models/Associate');
// const { STATUSES } = require('../config/constants');
// const { encrypt } = require('../utils/secretBox');
// const { record, ACTIONS } = require('../services/auditService');

// const MIN_PASSWORD_LENGTH = 8;

// const signToken = (user) =>
//     jwt.sign(
//         { sub: user._id, memberCode: user.memberCode || null, role: user.role },
//         jwtConfig.secret,
//         { expiresIn: jwtConfig.expiresIn }
//     );

// // ---------------------------------------------------------------------------
// // POST /api/auth/login — one endpoint for both admins and associates.
// // ---------------------------------------------------------------------------
// const login = async (req, res, next) => {
//     try {
//         const { email, password } = req.body;

//         if (!email || !password) {
//             return res.status(400).json({ success: false, message: 'Email and password are required.' });
//         }

//         // password is select:false on the schema, so ask for it explicitly.
//         const user = await Associate.findOne({ email: String(email).toLowerCase().trim() })
//             .select('+password');

//         // Same generic message whether the email is unknown or the password is
//         // wrong — a distinct "no such user" reply turns this into an account
//         // enumeration oracle.
//         const invalid = { success: false, message: 'Invalid email or password.' };
//         if (!user) return res.status(401).json(invalid);

//         const passwordMatches = await bcrypt.compare(password, user.password);
//         if (!passwordMatches) return res.status(401).json(invalid);

//         if (user.status !== STATUSES.APPROVED) {
//             return res.status(403).json({
//                 success: false,
//                 message: `Account is ${user.status}. Contact the administrator.`
//             });
//         }

//         return res.status(200).json({
//             success: true,
//             message: 'Login successful.',
//             token: `Bearer ${signToken(user)}`,
//             data: user.toJSON() // transform drops the password hash
//         });
//     } catch (error) {
//       next(error);
//     }
// };

// // ---------------------------------------------------------------------------
// // POST /api/auth/change-password — voluntary, from the profile menu.
// // ---------------------------------------------------------------------------
// const changePassword = async (req, res, next) => {
//     try {
//         const { currentPassword, newPassword } = req.body;

//         if (!currentPassword || !newPassword) {
//             return res.status(400).json({
//                 success: false,
//                 message: 'Current password and new password are required.'
//             });
//         }

//         if (newPassword.length < MIN_PASSWORD_LENGTH) {
//             return res.status(400).json({
//                 success: false,
//                 message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`
//             });
//         }

//         if (currentPassword === newPassword) {
//             return res.status(400).json({
//                 success: false,
//                 message: 'New password must be different from the current password.'
//             });
//         }

//         const user = await Associate.findById(req.user._id).select('+password');
//         if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });

//         const matches = await bcrypt.compare(currentPassword, user.password);
//         if (!matches) {
//             return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
//         }

//         user.password = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
//         // Keep the admin-readable copy in step, or the panel would show a
//         // password that no longer works.
//         user.passwordEnc = encrypt(newPassword);
//         await user.save();

//         await record(req, {
//             action: ACTIONS.PASSWORD_CHANGED,
//             targetType: 'Associate',
//             target: user._id,
//             targetCode: user.memberCode || null
//         });

//         return res.status(200).json({
//             success: true,
//             message: 'Password updated successfully.',
//             token: `Bearer ${signToken(user)}`
//         });
//     } catch (error) {
//       next(error);
//     }
// };

// // GET /api/auth/me — the logged-in user, for hydrating the client on reload.
// const me = async (req, res) => {
//     return res.status(200).json({ success: true, data: req.user });
// };

// module.exports = { login, changePassword, me };


const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const jwtConfig = require('../config/jwt');
const Associate = require('../models/Associate');
const { ROLES, STATUSES } = require('../config/constants');
const { encrypt } = require('../utils/secretBox');
const { record, ACTIONS } = require('../services/auditService');

const MIN_PASSWORD_LENGTH = 8;

const signToken = (user) =>
    jwt.sign(
        { sub: user._id, memberCode: user.memberCode || null, role: user.role },
        jwtConfig.secret,
        { expiresIn: jwtConfig.expiresIn }
    );

// The two front doors. Each one only lets its own role through, so the admin
// console and the member portal are genuinely separate logins rather than one
// login that redirects you afterwards.
const AUDIENCES = [ROLES.ADMIN, ROLES.ASSOCIATE];

// ---------------------------------------------------------------------------
// POST /api/auth/login — Accepts either Email OR Member Code (Associate ID).
//
// `audience` names which door the request came through and is part of the
// credential check: correct password, wrong door, is a failed login.
// ---------------------------------------------------------------------------
const login = async (req, res, next) => {
    try {
        // Accept 'identifier' (or fallback to 'email' / 'memberCode' for flexible payload support)
        const { identifier, email, memberCode, password, audience } = req.body;
        const loginId = (identifier || email || memberCode || '').toString().trim();

        if (!loginId || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email or Associate ID, and password are required.'
            });
        }

        if (!AUDIENCES.includes(audience)) {
            return res.status(400).json({
                success: false,
                message: 'A valid audience is required.'
            });
        }

        // Search by email (lowercase) OR memberCode (uppercase)
        const user = await Associate.findOne({
            $or: [
                { email: loginId.toLowerCase() },
                { memberCode: loginId.toUpperCase() }
            ]
        }).select('+password');

        // Generic error message to avoid account enumeration
        const invalid = { success: false, message: 'Invalid credentials.' };
        if (!user) return res.status(401).json(invalid);

        const passwordMatches = await bcrypt.compare(password, user.password);
        if (!passwordMatches) return res.status(401).json(invalid);

        // Deliberately the same reply as a wrong password. Saying "this is an
        // associate account" would confirm the account exists and leak its role
        // to anyone probing the admin door.
        if (user.role !== audience) return res.status(401).json(invalid);

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
            data: user.toJSON() // transform drops the password hash
        });
    } catch (error) {
        next(error);
    }
};

// ---------------------------------------------------------------------------
// POST /api/auth/change-password — voluntary, from the profile menu.
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
        user.passwordEnc = encrypt(newPassword);
        await user.save();

        await record(req, {
            action: ACTIONS.PASSWORD_CHANGED,
            targetType: 'Associate',
            target: user._id,
            targetCode: user.memberCode || null
        });

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