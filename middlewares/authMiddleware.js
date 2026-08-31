const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');

const verifyAdminToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            message: 'Access denied. Authorization token required.'
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, jwtConfig.secret);

        // Ensure the token belongs to the admin role
        if (decoded.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Access forbidden. Admin privileges required.'
            });
        }

        req.admin = decoded;
        next();
    } catch (error) {
        return res.status(403).json({
            success: false,
            message: 'Invalid or expired token.'
        });
    }
};

module.exports = { verifyAdminToken };