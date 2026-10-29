const jwt = require('jsonwebtoken');

// ตรวจสอบ JWT ที่ส่งมาใน header: Authorization: Bearer <token>
// role: 'admin' = ทำได้ทุกอย่าง, 'staff' = พนักงานหน้างาน (เช็กอิน/สแกน/walk-in/ย้ายโต๊ะ)
// token รุ่นเก่าที่ไม่มี role ถือเป็น admin (เพราะเดิมมีแต่บัญชีแอดมิน)
function readToken(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return { error: 'กรุณาเข้าสู่ระบบแอดมินก่อน' };
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        return { payload: { ...payload, role: payload.role || 'admin' } };
    } catch (err) {
        return { error: 'เซสชันหมดอายุหรือไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่' };
    }
}

// เฉพาะแอดมิน
function requireAdmin(req, res, next) {
    const r = readToken(req);
    if (r.error) return res.status(401).json({ error: r.error });
    if (r.payload.role !== 'admin') {
        return res.status(403).json({ error: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ (ต้องเป็นแอดมิน)' });
    }
    req.admin = r.payload;
    next();
}

// แอดมินหรือพนักงานหน้างาน
function requireStaff(req, res, next) {
    const r = readToken(req);
    if (r.error) return res.status(401).json({ error: r.error });
    if (r.payload.role !== 'admin' && r.payload.role !== 'staff') {
        return res.status(403).json({ error: 'ไม่มีสิทธิ์ใช้งาน' });
    }
    req.admin = r.payload;
    next();
}

module.exports = { requireAdmin, requireStaff };
