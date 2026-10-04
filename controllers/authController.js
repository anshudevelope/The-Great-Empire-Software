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
const { BUSINESSES, BUSINESS_LIST, BUSINESS_LABELS } = require('../config/business');
const { currentBusiness, runInBusiness } = require('../utils/businessContext');

const MIN_PASSWORD_LENGTH = 8;

// `biz` is the business the account lives in. requireAuth loads the user from
// there and holds associates to it; admins (always T1) pick per request.
const signToken = (user, business = BUSINESSES.T1) =>
    jwt.sign(
        { sub: user._id, memberCode: user.memberCode || null, role: user.role, biz: business },
        jwtConfig.secret,
        { expiresIn: jwtConfig.expiresIn }
    );

// Short-lived and single-purpose: proves the password already matched every
// account listed in it, so the member can pick one without retyping it.
// requireAuth refuses it as a session token.
const PICK_PURPOSE = 'business-pick';
const signPickToken = (accounts) =>
    jwt.sign({ purpose: PICK_PURPOSE, accounts }, jwtConfig.secret, { expiresIn: '2m' });

const findLoginUser = (business, loginId) =>
    runInBusiness(business, () =>
        Associate.findOne({
            $or: [
                { email: loginId.toLowerCase() },
                { memberCode: loginId.toUpperCase() }
            ]
        }).select('+password')
    );

const sessionResponse = (res, user, business) =>
    res.status(200).json({
        success: true,
        message: 'Login successful.',
        token: `Bearer ${signToken(user, business)}`,
        data: { ...user.toJSON(), business } // transform drops the password hash
    });

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

        // Admins live in T1 only. Associates may hold an account in each
        // business — one person, one email, two separately issued passwords.
        const businesses = audience === ROLES.ADMIN ? [BUSINESSES.T1] : BUSINESS_LIST;

        // Only accounts this password actually opens count. A member whose
        // password fits one account never learns the other one exists.
        const matched = [];
        for (const business of businesses) {
            const user = await findLoginUser(business, loginId);
            // No hash: T2's copy of the admin, which can never log in.
            if (!user?.password) continue;
            if (!(await bcrypt.compare(password, user.password))) continue;
            // Deliberately the same reply as a wrong password. Saying "this is an
            // associate account" would confirm the account exists and leak its role
            // to anyone probing the admin door.
            if (user.role !== audience) continue;
            matched.push({ business, user });
        }

        // Generic error message to avoid account enumeration
        if (!matched.length) return res.status(401).json({ success: false, message: 'Invalid credentials.' });

        const usable = matched.filter((m) => m.user.status === STATUSES.APPROVED);
        if (!usable.length) {
            return res.status(403).json({
                success: false,
                message: `Account is ${matched[0].user.status}. Contact the administrator.`
            });
        }

        if (usable.length === 1) return sessionResponse(res, usable[0].user, usable[0].business);

        // The password opened accounts in more than one business: ask which.
        return res.status(200).json({
            success: true,
            chooseBusiness: true,
            message: 'Choose the business to sign in to.',
            pickToken: signPickToken(Object.fromEntries(usable.map((m) => [m.business, String(m.user._id)]))),
            options: usable.map((m) => ({
                business: m.business,
                label: BUSINESS_LABELS[m.business],
                memberCode: m.user.memberCode || null
            }))
        });
    } catch (error) {
        next(error);
    }
};

// ---------------------------------------------------------------------------
// POST /api/auth/login/choose — second step when one password opened accounts
// in more than one business. The pick token is the proof; no password here.
// ---------------------------------------------------------------------------
const chooseBusiness = async (req, res, next) => {
    try {
        const { pickToken, business } = req.body;

        let decoded;
        try {
            decoded = jwt.verify(String(pickToken || ''), jwtConfig.secret);
        } catch {
            return res.status(401).json({ success: false, message: 'Sign-in expired. Please log in again.' });
        }

        const userId = decoded.purpose === PICK_PURPOSE ? decoded.accounts?.[business] : null;
        if (!userId) return res.status(400).json({ success: false, message: 'Choose one of the offered businesses.' });

        // Re-read: status may have changed in the seconds since the password check.
        const user = await runInBusiness(business, () => Associate.findById(userId));
        if (!user || user.role !== ROLES.ASSOCIATE) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
        if (user.status !== STATUSES.APPROVED) {
            return res.status(403).json({
                success: false,
                message: `Account is ${user.status}. Contact the administrator.`
            });
        }

        return sessionResponse(res, user, business);
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
            token: `Bearer ${signToken(user, currentBusiness())}`
        });
    } catch (error) {
        next(error);
    }
};

// GET /api/auth/me — the logged-in user, for hydrating the client on reload.
const me = async (req, res) => {
    return res.status(200).json({ success: true, data: { ...req.user.toJSON(), business: req.userBusiness } });
};

module.exports = { login, chooseBusiness, changePassword, me };