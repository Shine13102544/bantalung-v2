const { dbAll } = require('../db/database');

// แคช settings ในหน่วยความจำของ instance สั้นๆ เพื่อไม่ต้องยิง DB ทุก request (เช่น เช็กสถานะการขาย)
const TTL_MS = 10 * 1000;
let cache = null;
let cacheAt = 0;

async function getAllSettings(force = false) {
    if (!force && cache && Date.now() - cacheAt < TTL_MS) return cache;
    const rows = await dbAll('SELECT key, value FROM settings');
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    cache = obj;
    cacheAt = Date.now();
    return obj;
}

function invalidateSettings() {
    cache = null;
    cacheAt = 0;
}

// ค่าที่ส่งให้หน้าเว็บสาธารณะได้ (ไม่รวมลิงก์ Google Sheet ข้อมูลใบเสร็จ หรือค่าภายใน)
const PUBLIC_KEYS = [
    'concert_title', 'concert_date', 'price_vip', 'price_normal', 'price_general',
    'bank_name', 'bank_account_no', 'bank_account_name', 'promptpay_id',
    'poster_config', 'sales_status', 'sales_close_at', 'max_tables_per_booking', 'booking_rules'
];

// เวลาที่แอดมินกรอกเป็นเวลาไทย (ไม่มี timezone) ต้องแปลงเป็น +07:00 เพราะ server บน Vercel เป็น UTC
function parseBangkokTime(str) {
    if (!str) return NaN;
    const s = String(str).trim();
    const hasTz = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
    return Date.parse(hasTz ? s : s + '+07:00');
}

// สถานะการขายบัตร: เปิด / ปิดการขาย / ขายหมด (หรือเลยเวลาปิดขายอัตโนมัติ)
function computeSalesState(settings, nowMs = Date.now()) {
    const status = settings.sales_status || 'open';
    if (status === 'soldout') {
        return { open: false, code: 'SOLD_OUT', message: 'ขออภัย บัตรขายหมดแล้ว' };
    }
    if (status === 'closed') {
        return { open: false, code: 'SALES_CLOSED', message: 'ขณะนี้ปิดการขายบัตรแล้ว' };
    }
    if (settings.sales_close_at) {
        const t = parseBangkokTime(settings.sales_close_at);
        if (!Number.isNaN(t) && nowMs >= t) {
            return { open: false, code: 'SALES_CLOSED', message: 'หมดเวลาจองบัตรแล้ว' };
        }
    }
    return { open: true, code: 'OPEN', message: '' };
}

module.exports = { getAllSettings, invalidateSettings, PUBLIC_KEYS, computeSalesState, parseBangkokTime };
