const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');
const Associate = require('../models/Associate');
const { ROLES, STATUSES } = require('../config/constants');

// ---------------------------------------------------------------------------
// requireAuth — verifies the token and loads the live user.
//
// The user is re-read from the database on every request rather than trusted
// from the token payload, because status and role can change mid-session (an
// admin suspends someone) and a stale token must not keep working.
// ---------------------------------------------------------------------------
const requireAuth = async (req, res, next) => {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            message: 'Access denied. Authorization token required.'
        });
    }

    let decoded;
    try {
        decoded = jwt.verify(authHeader.split(' ')[1], jwtConfig.secret);
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
    }

    if (!decoded.sub) {
        // Pre-RBAC tokens carried only an email. They can't identify a user, so
        // they're rejected outright and the client is forced to log in again.
        return res.status(401).json({ success: false, message: 'Stale token. Please log in again.' });
    }

    const user = await Associate.findById(decoded.sub).select(
        'memberCode fullName email role status tier ancestors depth parentId position leftChild rightChild sponsorId'
    );

    if (!user) {
        return res.status(401).json({ success: false, message: 'Account no longer exists.' });
    }

    if (user.status !== STATUSES.APPROVED) {
        return res.status(403).json({
            success: false,
            message: `Account is ${user.status}. Contact the administrator.`
        });
    }

    req.user = user;
    next();
};

// ---------------------------------------------------------------------------
// requireRole('admin') — plain role gate.
// ---------------------------------------------------------------------------
const requireRole = (...roles) => (req, res, next) => {
    if (!roles.includes(req.user.role)) {
        return res.status(403).json({
            success: false,
            message: 'Access forbidden. Insufficient privileges.'
        });
    }
    next();
};

// ---------------------------------------------------------------------------
// scopeToDownline — the ownership check that makes the member portal safe.
//
// Once associates can log in, "are you an admin?" stops being the security
// question. It becomes "is this record inside YOUR downline?" — otherwise any
// member could read the whole company genealogy by guessing an id.
//
// Admins pass through. An associate may act on themselves, or on anyone whose
// ancestors array contains them — a single indexed lookup, thanks to the
// materialised path.
// ---------------------------------------------------------------------------
const scopeToDownline = (param = 'id') => async (req, res, next) => {
    if (req.user.role === ROLES.ADMIN) return next();

    const targetId = req.params[param];
    if (!targetId) {
        return res.status(400).json({ success: false, message: 'Target associate id is required.' });
    }

    if (String(targetId) === String(req.user._id)) return next();

    const inDownline = await Associate.exists({ _id: targetId, ancestors: req.user._id });
    if (inDownline) return next();

    // Deliberately identical wording whether the target is missing or simply
    // outside the viewer's network — otherwise the response distinguishes
    // "exists" from "doesn't exist" and leaks the shape of the tree.
    return res.status(403).json({ success: false, message: 'Outside your network.' });
};

// ---------------------------------------------------------------------------
// requireSelfOrAdmin — for writes. Distinct from scopeToDownline on purpose:
// an associate may READ their whole downline but may only EDIT themselves.
// Using the downline scope here would let a sponsor rewrite their members'
// records.
// ---------------------------------------------------------------------------
const requireSelfOrAdmin = (param = 'id') => (req, res, next) => {
    if (req.user.role === ROLES.ADMIN) return next();
    if (String(req.params[param]) === String(req.user._id)) return next();
    return res.status(403).json({
        success: false,
        message: 'You can only modify your own profile.'
    });
};

module.exports = {
    requireAuth,
    requireRole,
    scopeToDownline,
    requireSelfOrAdmin,
    ROLES
};
