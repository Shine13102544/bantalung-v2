// รัน migration/สร้างตารางด้วยมือ: npm run db:init
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { initDatabase, SCHEMA_VERSION } = require('./database');

initDatabase()
    .then(() => { console.log(`✅ ฐานข้อมูลพร้อมใช้งาน (schema v${SCHEMA_VERSION})`); process.exit(0); })
    .catch((err) => { console.error('❌ ตั้งค่าฐานข้อมูลไม่สำเร็จ:', err.message); process.exit(1); });
