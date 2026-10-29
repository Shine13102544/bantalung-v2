// โหลด .env เฉพาะเมื่อรันในเครื่อง (Local)
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '../backend/.env') });
}

let app;
try {
  app = require('../backend/server.js');
} catch (err) {
  // ถ้าเซิร์ฟเวอร์เริ่มทำงานไม่ได้ (เช่น ตัวแปรสภาพแวดล้อมขาด) ให้ตอบ JSON บอกสาเหตุ แทนที่ Vercel จะตอบ "A server error has occurred"
  // (ชั่วคราวสำหรับหาสาเหตุ: เมื่อแก้ปัญหาแล้วควรลบ detail ออก)
  console.error('STARTUP ERROR:', err);
  app = (req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'เซิร์ฟเวอร์เริ่มทำงานไม่สำเร็จ', detail: String(err && err.message).slice(0, 400) }));
  };
}

module.exports = app;