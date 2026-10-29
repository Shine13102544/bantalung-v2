const crypto = require('crypto');
const { dbRun } = require('../db/database');
const { getAllSettings } = require('./settings');

// รหัสการจองปกติ: BK-1234-AB12
function genBookingCode() {
    return 'BK-' + crypto.randomInt(1000, 10000) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

// รหัส walk-in: WALK-A1B2C3 (16 ล้านแบบ แทนเดิมที่มีแค่ 9,000 แบบจนชนกันได้ง่าย)
function genWalkinCode() {
    return 'WALK-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// รหัสลับในบัตร/QR 128 บิต
function genTicketToken() {
    return crypto.randomBytes(16).toString('hex');
}

// ถ้าตั้ง pending_expire_hours > 0 ไว้ ให้ปล่อยโต๊ะของการจองที่ค้าง "รอตรวจสอบ" เกินเวลาที่กำหนด
// (เปลี่ยนสถานะเป็น rejected) ค่าเริ่มต้นเป็น 0 = ปิดฟีเจอร์นี้ เพราะต้องแน่ใจว่าแอดมินตรวจสลิปทันเวลา
// run = ฟังก์ชัน (sql, params) => Promise เช่น dbRun หรือ tx.run
async function expireStalePending(run = dbRun) {
    const s = await getAllSettings();
    const hours = Number(s.pending_expire_hours || 0);
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    const r = await run(
        `UPDATE bookings SET status = 'rejected', updated_at = datetime('now')
         WHERE status = 'pending' AND created_at <= datetime('now', ?)`,
        [`-${Math.floor(hours * 60)} minutes`]
    );
    return r.changes;
}

// โหลดการจองทั้งหมดพร้อมรายการโต๊ะ ด้วย query แค่ 2 ครั้ง (เดิมวน query ทีละการจอง ช้ามากเมื่อฐานข้อมูลอยู่บนคลาวด์)
// all = ฟังก์ชัน (sql, params) => Promise<rows> เช่น dbAll หรือ tx.all
async function loadBookingsWithTables(all, { where = '', params = [] } = {}) {
    const bookings = await all(
        `SELECT id, booking_code, first_name, last_name, phone, slip_filename, status, checked_in, checked_in_at,
                ticket_token, total_amount, payment_method, payment_status, created_at, updated_at
         FROM bookings ${where} ORDER BY created_at DESC, id DESC`,
        params
    );
    const tableRows = await all(`
        SELECT bt.booking_id, bt.price, li.table_code, li.zone_type
        FROM booking_tables bt
        JOIN layout_items li ON li.id = bt.layout_item_id
        ORDER BY bt.id
    `);
    const byBooking = new Map();
    for (const t of tableRows) {
        const key = Number(t.booking_id);
        if (!byBooking.has(key)) byBooking.set(key, []);
        byBooking.get(key).push({ code: t.table_code, price: Number(t.price), zone: t.zone_type });
    }
    return bookings.map(b => {
        const tables = byBooking.get(Number(b.id)) || [];
        return { ...b, id: Number(b.id), tableDetails: tables, tableList: tables.map(t => t.code) };
    });
}

module.exports = { genBookingCode, genWalkinCode, genTicketToken, expireStalePending, loadBookingsWithTables };
