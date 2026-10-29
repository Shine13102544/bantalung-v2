const express = require('express');
const { body, validationResult } = require('express-validator');
const { dbGet, dbAll } = require('../db/database');
const { clean } = require('../utils/sanitize');
const { normalizePhone, isValidPhone } = require('../utils/phone');
const { getAllSettings } = require('../utils/settings');
const { dbRateLimit, hit, peek, reset, hashKey, sendLimited } = require('../utils/dbRateLimit');

const router = express.Router();

const NOT_FOUND_MSG = 'ไม่พบข้อมูลการจอง กรุณาตรวจสอบชื่อ นามสกุล และเบอร์โทรให้ตรงกับที่กรอกตอนจอง';

const lookupIpLimiter = dbRateLimit({
    name: 'ticket-ip', windowMs: 15 * 60 * 1000, max: 40,
    message: 'ค้นหาบัตรถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'
});

// ทำชื่อให้เทียบกันได้: NFC + ตัวพิมพ์เล็ก + ไม่สนวรรณยุกต์ไทย + ตัดช่องว่างทุกชนิด (รวม NBSP) และอักขระล่องหน (zero-width) ที่มักติดมากับการก๊อปจาก LINE/Facebook
function nameKey(s) {
    return String(clean(String(s || '')) || '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/[\u0E48-\u0E4B]/g, '')   // ตัดวรรณยุกต์ไทย (่ ้ ๊ ๋) ให้ "หนึ่ง" กับ "หนึง" ถือเป็นชื่อเดียวกัน
        .replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, '');
}

// ระยะแก้ไข (Levenshtein) นับเป็นตัวอักษร: ใช้ยอมให้ชื่อพิมพ์ผิดได้เล็กน้อย โดย "เบอร์ต้องตรงเป๊ะ" เสมอ
function editDistance(a, b) {
    const x = Array.from(a), y = Array.from(b);
    let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i++) {
        const cur = [i];
        for (let j = 1; j <= y.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[y.length];
}

// ชื่อสั้น (≤3 ตัว) ต้องตรงเป๊ะ, 4-6 ตัวผิดได้ 1 ตัว, ยาวกว่านั้นผิดได้ 2 ตัว (นับหลังตัดวรรณยุกต์/ช่องว่างแล้ว)
function nameClose(stored, typed) {
    const len = Math.min(Array.from(stored).length, Array.from(typed).length);
    const allowed = len <= 3 ? 0 : len <= 6 ? 1 : 2;
    return editDistance(stored, typed) <= allowed;
}

async function tablesOf(bookingId) {
    const rows = await dbAll(
        `SELECT li.table_code FROM booking_tables bt JOIN layout_items li ON li.id = bt.layout_item_id WHERE bt.booking_id = ? ORDER BY bt.id`,
        [bookingId]
    );
    return rows.map(r => r.table_code);
}

// ข้อมูลที่ลูกค้าเห็นได้ในหน้า "ดูบัตรของฉัน" — เฉพาะรายการที่อนุมัติแล้วเท่านั้นที่ได้รหัสบัตร (ticketToken) สำหรับ QR
async function publicTicket(b) {
    // ใบเสร็จ (บิล) แสดงเมื่ออนุมัติแล้ว + จ่ายแล้ว + มีใบเสร็จที่ใช้งานอยู่ (ถ้า void แล้วจะกลับเป็น QR + ยังไม่จ่าย)
    const paid = b.status === 'approved' && b.payment_status === 'paid';
    let receipt = null;
    if (paid) {
        const r = await dbGet(
            `SELECT receipt_no, amount, payment_method, issued_at FROM receipts WHERE booking_id = ? AND status = 'issued' ORDER BY id DESC LIMIT 1`,
            [b.id]
        );
        const s = await getAllSettings();
        receipt = {
            receiptNo: r ? r.receipt_no : null,
            amount: r ? Number(r.amount) : Number(b.total_amount),
            paymentMethod: r ? r.payment_method : (b.payment_method || 'transfer'),
            issuedAt: r ? r.issued_at : null,
            shopName: s.receipt_shop_name || 'ร้านบ้านตะลุง',
            shopAddress: s.receipt_shop_address || '',
            taxId: s.receipt_tax_id || '',
            footer: s.receipt_footer || 'ขอบคุณที่ใช้บริการ'
        };
    }
    return {
        paymentStatus: b.status === 'approved' ? (paid ? 'paid' : 'unpaid') : null,
        receipt,
        bookingCode: b.booking_code,
        name: `${b.first_name} ${b.last_name}`.trim(),
        status: b.status,
        tables: await tablesOf(b.id),
        totalAmount: Number(b.total_amount),
        checkedIn: !!b.checked_in,
        checkedInAt: b.checked_in_at || null,
        createdAt: b.created_at,
        ticketToken: b.status === 'approved' ? b.ticket_token : null
    };
}

// POST /api/tickets/lookup - ลูกค้ากรอกชื่อ + นามสกุล + เบอร์โทร เพื่อดูบัตรของตัวเอง
// กันการไล่เดา: จำกัดต่อ IP + ล็อกเบอร์นั้นชั่วคราวเมื่อกรอกผิดครบ 5 ครั้ง และตอบข้อความเดียวกันทุกกรณีที่ไม่พบ
router.post(
    '/lookup',
    lookupIpLimiter,
    [
        body('firstName').trim().notEmpty().withMessage('กรุณากรอกชื่อ'),
        body('lastName').trim().notEmpty().withMessage('กรุณากรอกนามสกุล'),
        body('phone').trim().notEmpty().withMessage('กรุณากรอกเบอร์โทร')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

        const phone = normalizePhone(req.body.phone);
        if (!isValidPhone(phone)) return res.status(400).json({ error: 'รูปแบบเบอร์โทรไม่ถูกต้อง' });

        const failKey = `ticket-fail:${hashKey(phone)}`;
        const failed = await peek(failKey);
        if (failed.count >= 5) {
            return sendLimited(res, failed.resetAt, 'กรอกข้อมูลไม่ตรงหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่ หรือติดต่อทางร้าน');
        }

        // ดึงรายการด้วยเบอร์ก่อน (ตัด - ช่องว่าง + ออกจากเบอร์ที่เก็บไว้) แล้วเทียบชื่อในโค้ด
        // เหตุผล: SQL REPLACE ตัดได้แค่ช่องว่างธรรมดา ไม่ตัด NBSP/zero-width ที่ติดมากับชื่อที่เก็บไว้ ทำให้ชื่อตรงแต่หาไม่เจอ
        const tail = phone.slice(-8);
        const candidates = await dbAll(
            `SELECT id, booking_code, first_name, last_name, phone, status, checked_in, checked_in_at, ticket_token, total_amount, payment_status, payment_method, created_at
             FROM bookings
             WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '+', ''), '(', ''), ')', '') LIKE ?
             ORDER BY created_at DESC`,
            ['%' + tail]
        );
        const fn = nameKey(req.body.firstName);
        const ln = nameKey(req.body.lastName);
        // เบอร์ต้องตรงเป๊ะ ส่วนชื่อ-นามสกุลยอมให้พิมพ์ผิดเล็กน้อยได้
        // ถ้ามีรายการที่ชื่อตรงเป๊ะ ให้แสดงเฉพาะรายการนั้น (กันไปโชว์บัตรของคนอื่นที่ใช้เบอร์เดียวกันแต่ชื่อใกล้เคียง)
        const samePhone = candidates.filter(b => normalizePhone(b.phone) === phone);
        const exact = samePhone.filter(b => nameKey(b.first_name) === fn && nameKey(b.last_name) === ln);
        const matches = exact.length
            ? exact
            : samePhone.filter(b => nameClose(nameKey(b.first_name), fn) && nameClose(nameKey(b.last_name), ln));

        if (matches.length === 0) {
            await hit(failKey, 15 * 60 * 1000);
            return res.status(404).json({ error: NOT_FOUND_MSG });
        }

        await reset(failKey);
        res.json({ bookings: await Promise.all(matches.map(publicTicket)) });
    }
);

const tokenIpLimiter = dbRateLimit({
    name: 'ticket-token-ip', windowMs: 15 * 60 * 1000, max: 60,
    message: 'เรียกดูบัตรถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'
});

// GET /api/tickets/:token - เปิดบัตรจากลิงก์ที่แอดมินส่งให้ (token ยาว 128 บิต เดาไม่ได้)
router.get('/:token', tokenIpLimiter, async (req, res) => {
    const token = String(req.params.token || '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(token)) return res.status(404).json({ error: NOT_FOUND_MSG });
    const b = await dbGet(
        `SELECT id, booking_code, first_name, last_name, status, checked_in, checked_in_at, ticket_token, total_amount, payment_status, payment_method, created_at
         FROM bookings WHERE ticket_token = ?`,
        [token]
    );
    if (!b) return res.status(404).json({ error: NOT_FOUND_MSG });
    res.json({ bookings: [await publicTicket(b)] });
});

module.exports = router;