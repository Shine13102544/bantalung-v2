const crypto = require('crypto');
const { dbGet, dbRun } = require('../db/database');

// Rate limit ที่เก็บตัวนับใน DB: ใช้ได้จริงบน Vercel (serverless) ที่ memory ของแต่ละ instance ไม่ถูกแชร์
// express-rate-limit แบบ memory ใช้กับ endpoint สำคัญ (login, จอง, ค้นหาบัตร) ไม่ได้ เพราะแต่ละ instance นับแยกกัน

function hashKey(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

// นับ 1 ครั้งแล้วคืนจำนวนล่าสุด (คำสั่งเดียว atomic)
async function hit(key, windowMs) {
    const now = Date.now();
    const row = await dbGet(
        `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET
            count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
            reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END
         RETURNING count, reset_at`,
        [key, now + windowMs, now, now, now + windowMs]
    );
    // เก็บกวาดแถวที่หมดอายุแล้วเป็นครั้งคราว
    if (Math.random() < 0.02) {
        dbRun('DELETE FROM rate_limits WHERE reset_at < ?', [now]).catch(() => {});
    }
    return { count: Number(row.count), resetAt: Number(row.reset_at) };
}

// ดูจำนวนปัจจุบันโดยไม่นับเพิ่ม
async function peek(key) {
    const row = await dbGet('SELECT count, reset_at FROM rate_limits WHERE key = ?', [key]);
    if (!row || Number(row.reset_at) <= Date.now()) return { count: 0, resetAt: 0 };
    return { count: Number(row.count), resetAt: Number(row.reset_at) };
}

async function reset(key) {
    await dbRun('DELETE FROM rate_limits WHERE key = ?', [key]);
}

function sendLimited(res, resetAt, message) {
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: message, retryAfter });
}

// สร้าง middleware: name=ชื่อกลุ่ม, keyFn(req)=ค่าที่ใช้แยกผู้ใช้ (ค่าเริ่มต้น IP)
// ถ้า DB ใช้ไม่ได้จะปล่อยผ่าน (fail-open) เพื่อไม่ให้ระบบจองล่มไปด้วย
function dbRateLimit({ name, windowMs, max, keyFn, message }) {
    return async (req, res, next) => {
        try {
            const id = keyFn ? keyFn(req) : req.ip;
            const { count, resetAt } = await hit(`${name}:${hashKey(id)}`, windowMs);
            if (count > max) return sendLimited(res, resetAt, message || 'มีการเรียกใช้งานถี่เกินไป กรุณารอสักครู่แล้วลองใหม่');
        } catch (err) {
            console.error('rate-limit error (ปล่อยผ่าน):', err.message);
        }
        next();
    };
}

module.exports = { dbRateLimit, hit, peek, reset, hashKey, sendLimited };
