// โหลด .env จาก backend/.env เสมอ (npm start รันจากโฟลเดอร์ root จึงอ่านไฟล์ที่ cwd ไม่เจอ)
// แล้วลองโหลด .env ที่ cwd ซ้ำอีกครั้ง (ไม่ทับค่าที่ตั้งไว้แล้ว) เผื่อคุณวางไว้ที่ root
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDatabase } = require('./db/database');

const authRoutes = require('./routes/auth.routes');
const layoutRoutes = require('./routes/layout.routes');
const bookingRoutes = require('./routes/booking.routes');
const settingsRoutes = require('./routes/settings.routes');
const contentRoutes = require('./routes/content.routes');
const ticketRoutes = require('./routes/ticket.routes');
const receiptRoutes = require('./routes/receipt.routes');

// JWT_SECRET: ถ้าไม่ตั้ง/เป็นค่าตัวอย่าง/สั้นเกินไป ใครเดาได้ก็ปลอม token แอดมินได้
// - บนเครื่องจริง (Vercel/production): ไม่ตั้ง, เป็นค่าตัวอย่าง หรือสั้นกว่า 16 ตัวอักษร = หยุดทำงาน
// - สั้นกว่า 32 ตัวอักษร = เตือนใน log (แนะนำให้สุ่มใหม่ด้วยคำสั่งใน .env.example)
{
    const secret = process.env.JWT_SECRET || '';
    const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
    const unsafe = !secret || secret.length < 16 || /CHANGE_THIS/i.test(secret);
    if (unsafe && isProd) {
        throw new Error('JWT_SECRET ไม่ได้ตั้งค่า เป็นค่าตัวอย่าง หรือสั้นเกินไป (ต้องเป็นข้อความสุ่มยาวอย่างน้อย 32 ตัวอักษร)');
    }
    if (unsafe || secret.length < 32) {
        console.warn('⚠️ JWT_SECRET ควรเป็นข้อความสุ่มยาวอย่างน้อย 32 ตัวอักษร (ดูวิธีสร้างใน backend/.env.example)');
    }
}

const app = express();

// ต้องบอก Express ว่าอยู่หลัง proxy ของ Vercel 1 ชั้น ไม่งั้น req.ip จะเป็นไอพีของ proxy ทำให้ผู้ใช้ทุกคนนับเป็นคนเดียวกัน
app.set('trust proxy', 1);

app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// หน้าเว็บกับ API อยู่โดเมนเดียวกันบน Vercel จึงไม่ต้องเปิด CORS
// ตอนพัฒนาในเครื่องที่หน้าเว็บอยู่คนละพอร์ต ให้ตั้ง FRONTEND_ORIGIN ใน .env (ไม่มีค่าเริ่มต้นเป็น * อีกแล้ว)
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
}));

app.use(express.json({ limit: '1mb' }));

// Rate limit ทั่วไป (นับใน memory ของแต่ละ instance ใช้เป็นแค่ด่านหยาบ) — ตัวที่ป้องกันจริงของ endpoint สำคัญ
// (login, จอง, ค้นหาบัตร) อยู่ที่ utils/dbRateLimit.js ซึ่งนับใน DB
// ตั้งสูงพอที่จะรองรับหน้างานที่คนจำนวนมากใช้ Wi-Fi/IP เดียวกัน
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'มีการเรียกใช้งานถี่เกินไป กรุณารอสักครู่แล้วลองใหม่' }
}));

// รัน/ตรวจ migration ก่อนรับ request (ปกติเป็น SELECT เดียว ดู db/database.js)
let isDbReady = false;
let dbInitPromise = null;

app.use(async (req, res, next) => {
    if (!isDbReady) {
        try {
            if (!dbInitPromise) dbInitPromise = initDatabase();
            await dbInitPromise;
            isDbReady = true;
        } catch (err) {
            dbInitPromise = null; // ให้ request ถัดไปลองใหม่
            console.error('❌ DB Init Error:', err);
            return res.status(503).json({ error: 'ระบบฐานข้อมูลยังไม่พร้อมใช้งาน กรุณาลองใหม่อีกครั้งในอีกสักครู่' });
        }
    }
    next();
});

app.use('/api/auth', authRoutes);
app.use('/api/layout', layoutRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/receipts', receiptRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบ endpoint นี้' }));

// Centralized error handler: ไม่ส่งข้อความผิดพลาดภายในให้ client (อาจเผยโครงสร้างระบบ/ที่อยู่ฐานข้อมูล)
app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
        return res.status(400).json({ error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' });
    }
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินไป' });
    }
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง' });
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL && require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`✅ Backend running on http://localhost:${PORT}`));
}

module.exports = app;
