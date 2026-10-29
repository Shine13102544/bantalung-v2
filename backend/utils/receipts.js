const { clean } = require('./sanitize');

const PAYMENT_METHODS = new Set(['transfer', 'cash', 'promptpay']);

// ปีตามเวลาไทย (server อาจเป็น UTC)
function bangkokYear() {
    return new Date(Date.now() + 7 * 3600 * 1000).getUTCFullYear();
}

// ออกใบเสร็จของการจองภายใน transaction ที่เปิดอยู่แล้ว (tx = ตัวช่วยจาก dbTransaction)
// - ออกได้เฉพาะการจองที่อนุมัติแล้ว และมีใบเสร็จที่ใช้งานอยู่ได้ใบเดียวต่อการจอง
// - เลขที่รันต่อเนื่องรายปี (R2026-0001) ออกโดย server
// - ออกแล้วถือว่า "จ่ายแล้ว": ตั้ง payment_status = 'paid' และ payment_method ให้ตรงกับใบเสร็จ
// opts: { amount?, method?, note?, issuedBy }
async function issueReceiptTx(tx, bookingId, opts = {}) {
    const b = await tx.get(
        'SELECT id, booking_code, first_name, last_name, phone, status, total_amount, payment_method FROM bookings WHERE id = ?',
        [bookingId]
    );
    if (!b) throw Object.assign(new Error('ไม่พบรายการจองนี้'), { http: 404 });
    if (b.status !== 'approved') throw Object.assign(new Error('ออกใบเสร็จได้เฉพาะการจองที่อนุมัติแล้ว'), { http: 409 });

    const existing = await tx.get("SELECT receipt_no FROM receipts WHERE booking_id = ? AND status = 'issued'", [b.id]);
    if (existing) {
        throw Object.assign(new Error(`การจองนี้ออกใบเสร็จแล้ว (เลขที่ ${existing.receipt_no}) หากต้องการออกใหม่ให้ยกเลิก (void) ใบเดิมก่อน`), { http: 409, code: 'ALREADY_ISSUED' });
    }

    const tableRows = await tx.all(
        `SELECT li.table_code FROM booking_tables bt JOIN layout_items li ON li.id = bt.layout_item_id WHERE bt.booking_id = ? ORDER BY bt.id`,
        [b.id]
    );
    const year = bangkokYear();
    const counter = await tx.get(
        `INSERT INTO counters (name, value) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`,
        [`receipt-${year}`]
    );
    const receiptNo = `R${year}-${String(counter.value).padStart(4, '0')}`;

    const amount = opts.amount !== undefined && opts.amount !== null ? Number(opts.amount) : Number(b.total_amount);
    const method = PAYMENT_METHODS.has(opts.method) ? opts.method : b.payment_method;
    const note = opts.note ? clean(opts.note).slice(0, 300) : null;

    const ins = await tx.run(
        `INSERT INTO receipts (receipt_no, booking_id, booking_code, customer_name, phone, tables, amount, payment_method, note, issued_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [receiptNo, b.id, b.booking_code, `${b.first_name} ${b.last_name}`.trim(), b.phone,
            tableRows.map(t => t.table_code).join(', '), amount, method, note, opts.issuedBy || null]
    );
    await tx.run(
        "UPDATE bookings SET payment_status = 'paid', payment_method = ?, updated_at = datetime('now') WHERE id = ?",
        [method, b.id]
    );
    return tx.get('SELECT * FROM receipts WHERE id = ?', [ins.lastInsertRowid]);
}

module.exports = { PAYMENT_METHODS, issueReceiptTx };
