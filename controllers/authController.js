const jwt = require('jsonwebtoken');
const jwtConfig = require('../config/jwt');

const adminLogin = (req, res) => {
    const { email, password } = req.body;

    const staticEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
    const staticPassword = process.env.ADMIN_PASSWORD || 'AdminPassword123';

    // Validate static credentials
    if (email !== staticEmail || password !== staticPassword) {
        return res.status(401).json({
            success: false,
            message: 'Invalid admin credentials.'
        });
    }

    // Generate JWT Token
    const token = jwt.sign(
        { email: staticEmail, role: 'admin' },
        jwtConfig.secret,
        { expiresIn: jwtConfig.expiresIn }
    );

    return res.status(200).json({
        success: true,
        message: 'Admin login successful.',
        token: `Bearer ${token}`
    });
};

module.exports = { adminLogin };