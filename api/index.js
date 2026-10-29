// โหลด .env เฉพาะเมื่อรันในเครื่อง (Local)
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '../backend/.env') });
}

const fs = require('fs');
const path = require('path');

let app = null;
let startupError = null;

function loadApp() {
  if (app || startupError) return;
  try {
    app = require('../backend/server.js');
  } catch (err) {
    startupError = err;
    console.error('STARTUP ERROR:', err);
  }
}

// ---------- หน้าตรวจสอบชั่วคราว: /api/_diag (ไม่แสดงรหัสจริง มีแค่ true/false และความยาว) ----------
// เมื่อแก้ปัญหาเสร็จแล้ว ให้ย้อน api/index.js กลับเป็นแบบเดิม (module.exports = require('../backend/server.js'))
async function diag(res) {
  const out = { node: process.version, vercel: !!process.env.VERCEL, nodeEnv: process.env.NODE_ENV || null };
  const env = process.env;
  out.env = {
    JWT_SECRET_length: (env.JWT_SECRET || '').length,
    JWT_SECRET_hasChangeThis: /CHANGE_THIS/i.test(env.JWT_SECRET || ''),
    TURSO_DATABASE_URL: (env.TURSO_DATABASE_URL || '').includes('://') ? ('ขึ้นต้นด้วย ' + env.TURSO_DATABASE_URL.split('://')[0] + '://') : ('ไม่มี :// (ความยาว ' + (env.TURSO_DATABASE_URL || '').length + ')'),
    TURSO_AUTH_TOKEN_length: (env.TURSO_AUTH_TOKEN || '').length,
    CLOUDINARY_CLOUD_NAME: !!env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: !!env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: !!env.CLOUDINARY_API_SECRET,
    FRONTEND_ORIGIN_set: !!env.FRONTEND_ORIGIN
  };

  // ไฟล์สำคัญอยู่ในแพ็กเกจที่ deploy จริงไหม (ตัวพิมพ์เล็ก/ใหญ่มีผลบน Linux)
  const base = path.resolve(__dirname, '../backend');
  const files = ['server.js', 'db/database.js', 'db/schema.sql', 'middleware/auth.js', 'utils/receipts.js', 'utils/settings.js',
    'utils/sanitize.js', 'utils/cloudinary.js', 'routes/booking.routes.js', 'routes/receipt.routes.js', 'routes/ticket.routes.js'];
  out.files = {};
  for (const f of files) out.files[f] = fs.existsSync(path.join(base, f));

  // โหลดเซิร์ฟเวอร์ได้ไหม
  loadApp();
  out.serverLoad = startupError ? ('ล้มเหลว: ' + String(startupError.message).slice(0, 300)) : 'สำเร็จ';

  // ต่อฐานข้อมูล Turso ได้ไหม (SELECT 1 รอไม่เกิน 6 วินาที)
  try {
    const { createClient } = require('@libsql/client');
    const c = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
    const r = await Promise.race([c.execute('SELECT 1 AS ok'), new Promise((_, rej) => setTimeout(() => rej(new Error('หมดเวลา 6 วินาที')), 6000))]);
    out.turso = 'เชื่อมต่อสำเร็จ (' + JSON.stringify(r.rows[0]) + ')';
  } catch (e) {
    out.turso = 'ล้มเหลว: ' + String((e && e.message) || e).replace(/eyJ[\w.-]+/g, '***').slice(0, 300);
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(out, null, 2));
}

module.exports = async (req, res) => {
  try {
    if ((req.url || '').startsWith('/api/_diag')) return await diag(res);
    loadApp();
    if (startupError) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'เซิร์ฟเวอร์เริ่มทำงานไม่สำเร็จ', detail: String(startupError.message).slice(0, 400) }));
    }
    return app(req, res);
  } catch (err) {
    console.error('HANDLER ERROR:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', detail: String(err && err.message).slice(0, 400) }));
  }
};