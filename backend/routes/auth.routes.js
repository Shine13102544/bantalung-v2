const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { dbGet } = require('../db/database');
const { requireAdmin, requireStaff } = require('../middleware/auth');
const { dbRateLimit } = require('../utils/dbRateLimit');

const router = express.Router();

const TOKEN_EXPIRES_IN = () => process.env.JWT_EXPIRES_IN || '12h';

// hash หลอกไว้เทียบเมื่อไม่พบชื่อผู้ใช้ เพื่อให้เวลาตอบสนองใกล้เคียงกันทั้งสองกรณี (กันเดาชื่อผู้ใช้จากความเร็ว)
const DUMMY_HASH = '$2b$12$paNOg.NZck2odPiS5ElQEe0V0NujUZ27o.FKZibZCFFabK254sftq';

// จำกัดต่อ IP และต่อชื่อผู้ใช้ — ตัวนับเก็บใน DB ใช้ได้จริงบน Vercel
const loginIpLimiter = dbRateLimit({
    name: 'login-ip', windowMs: 15 * 60 * 1000, max: 20,
    message: 'พยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่'
});
const loginUserLimiter = dbRateLimit({
    name: 'login-user', windowMs: 15 * 60 * 1000, max: 8,
    keyFn: (req) => String((req.body && req.body.username) || '').toLowerCase().trim(),
    message: 'พยายามเข้าสู่ระบบด้วยชื่อผู้ใช้นี้หลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่'
});

router.post(
    '/login',
    loginIpLimiter,
    loginUserLimiter,
    [
        body('username').trim().notEmpty().withMessage('กรุณากรอกชื่อผู้ใช้'),
        body('password').notEmpty().withMessage('กรุณากรอกรหัสผ่าน')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg });
        }

        const { username, password } = req.body;
        const user = await dbGet('SELECT * FROM admin_users WHERE username = ?', [username]);

        // เทียบรหัสผ่านเสมอ (แม้ไม่พบผู้ใช้) แบบ async ไม่บล็อก event loop
        const ok = await bcrypt.compare(String(password), user ? user.password_hash : DUMMY_HASH);
        if (!user || !ok) {
            return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        }

        const role = user.role || 'admin';
        const token = jwt.sign(
            { sub: user.id, username: user.username, role },
            process.env.JWT_SECRET,
            { expiresIn: TOKEN_EXPIRES_IN(), algorithm: 'HS256' }
        );

        res.json({ token, role, username: user.username, expiresIn: TOKEN_EXPIRES_IN() });
    }
);

// GET /api/auth/me - ให้หน้าเว็บเช็กว่า token ที่เก็บไว้ยังใช้ได้ไหม (ใช้ตอนรีเฟรชหน้าเพื่ออยู่หน้าแอดมินต่อ)
router.get('/me', requireStaff, (req, res) => {
    res.json({
        username: req.admin.username,
        role: req.admin.role,
        expiresAt: req.admin.exp ? req.admin.exp * 1000 : null
    });
});

const verifyLimiter = dbRateLimit({
    name: 'verify-password', windowMs: 15 * 60 * 1000, max: 8,
    keyFn: (req) => String(req.admin && req.admin.sub),
    message: 'พยายามยืนยันรหัสผ่านผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่'
});

// POST /api/auth/verify-password - แอดมินเท่านั้น: พิมพ์รหัสผ่านซ้ำเพื่อยืนยันก่อนทำรายการสำคัญ
router.post(
    '/verify-password',
    requireAdmin,
    verifyLimiter,
    [body('password').notEmpty().withMessage('กรุณากรอกรหัสผ่าน')],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg });
        }

        const admin = await dbGet('SELECT * FROM admin_users WHERE id = ?', [req.admin.sub]);
        if (!admin || !(await bcrypt.compare(String(req.body.password), admin.password_hash))) {
            // ใช้ 403 ไม่ใช่ 401 เพื่อไม่ให้หน้าเว็บเข้าใจผิดว่าเซสชันหมดอายุแล้วเด้งออกจากระบบ
            return res.status(403).json({ error: 'รหัสผ่านไม่ถูกต้อง', code: 'WRONG_PASSWORD' });
        }

        res.json({ verified: true });
    }
);

module.exports = router;
