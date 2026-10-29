const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { body, param, validationResult } = require('express-validator');
const { dbGet, dbAll, dbRun, dbTransaction } = require('../db/database');
const { requireAdmin, requireStaff } = require('../middleware/auth');
const { PAYMENT_METHODS: RECEIPT_METHODS, issueReceiptTx } = require('../utils/receipts');
const { clean } = require('../utils/sanitize');
const { normalizePhone, isValidPhone, maskPhone } = require('../utils/phone');
const { parsePrice } = require('../utils/money');
const { getAllSettings } = require('../utils/settings');
const { computeSalesState } = require('../utils/settings');
const { dbRateLimit, hit, hashKey, sendLimited } = require('../utils/dbRateLimit');
const { uploadBuffer, destroyAsset, publicIdFromUrl, slipUrlFor, detectImageType } = require('../utils/cloudinary');
const {
    genBookingCode, genWalkinCode, genTicketToken, expireStalePending, loadBookingsWithTables
} = require('../utils/bookings');

const router = express.Router();

// ---- อัปโหลดสลิป: รับเข้า memory ก่อน แล้วค่อยส่งขึ้น Cloudinary หลังตรวจข้อมูลผ่านทั้งหมดเท่านั้น ----
// (เดิมอัปโหลดขึ้น Cloudinary ก่อนตรวจ ทำให้สลิปค้างเมื่อจองไม่สำเร็จ)
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_MIME.has(file.mimetype)) {
            return cb(new Error('รองรับเฉพาะไฟล์รูปภาพ (JPEG, PNG, WEBP) เท่านั้น'));
        }
        cb(null, true);
    }
});

const PAYMENT_METHODS = new Set(['transfer', 'cash', 'promptpay']);

const bookingIpLimiter = dbRateLimit({
    name: 'booking-ip', windowMs: 15 * 60 * 1000, max: 20,
    message: 'ส่งข้อมูลการจองถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'
});

function badRequest(res, message, extra = {}) {
    return res.status(400).json({ error: message, ...extra });
}

// ============================================================
// POST /api/bookings - ลูกค้าส่งการจองพร้อมสลิป (สาธารณะ)
// ============================================================
router.post(
    '/',
    bookingIpLimiter,
    (req, res, next) => {
        upload.single('slip')(req, res, (err) => {
            if (err) return badRequest(res, err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์สลิปต้องมีขนาดไม่เกิน 5MB' : err.message);
            next();
        });
    },
    [
        body('firstName').trim().notEmpty().withMessage('กรุณากรอกชื่อ').isLength({ max: 100 }).withMessage('ชื่อยาวเกินไป'),
        body('lastName').trim().notEmpty().withMessage('กรุณากรอกนามสกุล').isLength({ max: 100 }).withMessage('นามสกุลยาวเกินไป'),
        body('phone').trim().notEmpty().withMessage('กรุณากรอกเบอร์โทร'),
        body('tableIds').notEmpty().withMessage('กรุณาเลือกโต๊ะอย่างน้อย 1 โต๊ะ')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return badRequest(res, errors.array()[0].msg);
        if (!req.file) return badRequest(res, 'กรุณาแนบสลิปการโอนเงิน');
        if (!detectImageType(req.file.buffer)) {
            return badRequest(res, 'ไฟล์ที่แนบไม่ใช่รูปภาพที่รองรับ (JPEG, PNG, WEBP)');
        }

        // 1) เช็กสถานะการขาย (บังคับที่ server ไม่ใช่แค่ซ่อนปุ่มบนหน้าเว็บ)
        const settings = await getAllSettings();
        const sales = computeSalesState(settings);
        if (!sales.open) {
            return res.status(403).json({ error: sales.message, code: sales.code });
        }

        // 2) เบอร์โทร
        const phone = normalizePhone(req.body.phone);
        if (!isValidPhone(phone)) return badRequest(res, 'รูปแบบเบอร์โทรไม่ถูกต้อง');

        // 3) รายการโต๊ะ: ต้องเป็น array ของรหัสโต๊ะ ไม่ซ้ำ และไม่เกินจำนวนสูงสุดต่อการจอง
        let tableIds;
        try {
            tableIds = JSON.parse(req.body.tableIds);
            if (!Array.isArray(tableIds) || tableIds.length === 0) throw new Error();
            tableIds = tableIds.map(t => String(t).trim());
        } catch {
            return badRequest(res, 'รูปแบบรายการโต๊ะไม่ถูกต้อง');
        }
        if (tableIds.some(t => !t || t.length > 30)) return badRequest(res, 'รหัสโต๊ะไม่ถูกต้อง');
        if (new Set(tableIds).size !== tableIds.length) return badRequest(res, 'มีโต๊ะซ้ำกันในรายการ');
        const maxTables = Math.max(1, Math.min(50, Number(settings.max_tables_per_booking) || 8));
        if (tableIds.length > maxTables) {
            return badRequest(res, `จองได้สูงสุด ${maxTables} โต๊ะต่อหนึ่งรายการ`);
        }

        // 4) จำกัดการจองต่อเบอร์: กันคนล็อกโต๊ะทั้งผังด้วยการส่งซ้ำๆ
        const phoneHit = await hit(`booking-phone:${hashKey(phone)}`, 60 * 60 * 1000);
        if (phoneHit.count > 8) {
            return sendLimited(res, phoneHit.resetAt, 'เบอร์นี้ส่งการจองถี่เกินไป กรุณารอสักครู่แล้วลองใหม่');
        }
        await expireStalePending();
        const pendingRow = await dbGet("SELECT COUNT(*) AS c FROM bookings WHERE status = 'pending' AND phone = ?", [phone]);
        if (Number(pendingRow.c) >= 2) {
            return res.status(429).json({
                error: 'เบอร์นี้มีรายการจองที่รอตรวจสอบสลิปอยู่แล้ว กรุณารอทางร้านตรวจสอบก่อนจองเพิ่ม',
                code: 'TOO_MANY_PENDING'
            });
        }

        const firstName = clean(req.body.firstName);
        const lastName = clean(req.body.lastName);

        const placeholders = tableIds.map(() => '?').join(',');
        const found = await dbAll(
            `SELECT id, table_code, price FROM layout_items WHERE kind = 'table' AND table_code IN (${placeholders})`,
            tableIds
        );
        if (found.length !== tableIds.length) {
            return badRequest(res, 'มีโต๊ะบางรายการไม่ถูกต้องหรือถูกลบไปแล้ว');
        }
        // เรียงตามลำดับที่ลูกค้าเลือก (ผลลัพธ์จาก DB ไม่รับประกันลำดับ)
        const byCode = new Map(found.map(t => [t.table_code, t]));
        const tables = tableIds.map(c => byCode.get(c));

        const layoutIds = tables.map(t => Number(t.id));
        const idPlaceholders = layoutIds.map(() => '?').join(',');
        const clashSql = `
            SELECT bt.layout_item_id
            FROM booking_tables bt
            JOIN bookings b ON b.id = bt.booking_id
            WHERE b.status IN ('pending','approved') AND bt.layout_item_id IN (${idPlaceholders})
        `;

        // 5) เช็กโต๊ะว่างเบื้องต้นก่อน เพื่อไม่ต้องอัปโหลดสลิปโดยเปล่าประโยชน์
        if ((await dbAll(clashSql, layoutIds)).length > 0) {
            return res.status(409).json({ error: 'ขออภัย มีโต๊ะบางรายการเพิ่งถูกจองไปก่อนหน้านี้ กรุณาเลือกโต๊ะใหม่', code: 'TABLE_TAKEN' });
        }

        // 6) อัปโหลดสลิปแบบ private (ต้องใช้ signed URL ถึงจะเปิดดูได้ มีแต่แอดมินเห็น)
        let uploaded;
        try {
            uploaded = await uploadBuffer(req.file.buffer, { folder: 'slips', private: true });
        } catch (err) {
            console.error('อัปโหลดสลิปไม่สำเร็จ:', err.message);
            return res.status(502).json({ error: 'อัปโหลดสลิปไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' });
        }

        const bookingCode = genBookingCode();
        const ticketToken = genTicketToken();
        const priceByLayoutId = new Map(tables.map(t => [Number(t.id), parsePrice(t.price)]));
        const totalAmount = layoutIds.reduce((sum, id) => sum + priceByLayoutId.get(id), 0);

        try {
            await dbTransaction(async (tx) => {
                await expireStalePending(tx.run);
                // เช็กซ้ำภายใน write transaction (กันจองซ้ำตอนมีคนกดพร้อมกัน)
                if ((await tx.all(clashSql, layoutIds)).length > 0) throw new Error('TABLE_TAKEN');

                const result = await tx.run(`
                    INSERT INTO bookings (booking_code, first_name, last_name, phone, slip_filename, status, ticket_token, total_amount, payment_method)
                    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 'transfer')
                `, [bookingCode, firstName, lastName, phone, uploaded.publicId, ticketToken, totalAmount]);

                for (const id of layoutIds) {
                    await tx.run(
                        'INSERT INTO booking_tables (booking_id, layout_item_id, price) VALUES (?, ?, ?)',
                        [result.lastInsertRowid, id, priceByLayoutId.get(id)]
                    );
                }
            });
        } catch (err) {
            await destroyAsset(uploaded.publicId, { private: true }); // ไม่ทิ้งสลิปค้างเมื่อจองไม่สำเร็จ
            if (err.message === 'TABLE_TAKEN') {
                return res.status(409).json({ error: 'ขออภัย มีโต๊ะบางรายการเพิ่งถูกจองไปก่อนหน้านี้ กรุณาเลือกโต๊ะใหม่', code: 'TABLE_TAKEN' });
            }
            console.error(err);
            return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' });
        }

        res.status(201).json({
            message: 'ส่งข้อมูลการจองเรียบร้อยแล้ว ทางร้านจะรีบดำเนินการตรวจสอบสลิปของท่าน',
            bookingCode,
            totalAmount
        });
    }
);

// ============================================================
// GET /api/bookings/admin - แอดมิน/พนักงาน: รายการจองทั้งหมด
// พนักงานหน้างานจะเห็นเบอร์โทรแบบปิดบัง และไม่เห็นสลิป/รหัสบัตร
// ============================================================
router.get('/admin', requireStaff, async (req, res) => {
    const isAdmin = req.admin.role === 'admin';
    await expireStalePending();
    const bookings = await loadBookingsWithTables(dbAll);

    res.json(bookings.map(b => ({
        id: b.id,
        booking_code: b.booking_code,
        first_name: b.first_name,
        last_name: b.last_name,
        phone: isAdmin ? b.phone : maskPhone(b.phone),
        status: b.status,
        checked_in: b.checked_in,
        checked_in_at: b.checked_in_at,
        created_at: b.created_at,
        updated_at: b.updated_at,
        total_amount: b.total_amount,
        payment_method: b.payment_method,
        payment_status: b.payment_status,
        tables: b.tableList.join(', '),   // คงไว้เพื่อให้หน้าเว็บเดิมใช้ได้
        tableList: b.tableList,           // แนะนำให้ใช้อันนี้ (array) แทนสตริงคั่นด้วยจุลภาค
        tableDetails: b.tableDetails,
        isWalkin: String(b.booking_code).startsWith('WALK-'),
        slipUrl: isAdmin ? slipUrlFor(b.slip_filename) : null,
        ticket_token: isAdmin ? b.ticket_token : undefined
    })));
});

// ============================================================
// PATCH /api/bookings/admin/:id/status - แอดมินเท่านั้น: อนุมัติ/ปฏิเสธ
// body.checkIn = true (เฉพาะตอน approved) = อนุมัติและเช็กอินในครั้งเดียว
// body.paymentStatus (บังคับเมื่อ approved): 'paid' = อนุมัติ + ออกใบเสร็จทันที (วิธีชำระ = โอน)
//                                            'unpaid' = อนุมัติโดยยังไม่ออกบิล (ไปจ่ายหน้างาน/จ่ายทีหลัง)
// ============================================================
router.patch(
    '/admin/:id/status',
    requireAdmin,
    [
        param('id').isInt(),
        body('status').isIn(['approved', 'rejected']),
        body('checkIn').optional().isBoolean(),
        body('paymentStatus').if(body('status').equals('approved')).isIn(['paid', 'unpaid']).withMessage('กรุณาเลือกสถานะการชำระเงิน (จ่ายแล้ว / ยังไม่จ่าย)')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return badRequest(res, errors.array()[0].msg);

        const status = req.body.status;
        const checkIn = status === 'approved' && (req.body.checkIn === true || req.body.checkIn === 'true');
        const paid = status === 'approved' && req.body.paymentStatus === 'paid';

        try {
            const out = await dbTransaction(async (tx) => {
                const result = await tx.run(`
                    UPDATE bookings
                    SET status = ?,
                        checked_in = CASE WHEN ? = 'rejected' THEN 0 WHEN ? = 1 THEN 1 ELSE checked_in END,
                        checked_in_at = CASE WHEN ? = 'rejected' THEN NULL WHEN ? = 1 AND checked_in = 0 THEN datetime('now') ELSE checked_in_at END,
                        updated_at = datetime('now')
                    WHERE id = ?
                `, [status, status, checkIn ? 1 : 0, status, checkIn ? 1 : 0, req.params.id]);
                if (result.changes === 0) throw Object.assign(new Error('ไม่พบรายการจองนี้'), { http: 404 });

                let receipt = null;
                if (paid) {
                    const existing = await tx.get("SELECT * FROM receipts WHERE booking_id = ? AND status = 'issued'", [req.params.id]);
                    if (existing) {
                        receipt = existing;
                        await tx.run("UPDATE bookings SET payment_status = 'paid' WHERE id = ?", [req.params.id]);
                    } else {
                        receipt = await issueReceiptTx(tx, Number(req.params.id), { method: 'transfer', issuedBy: req.admin.username });
                    }
                } else if (status === 'approved') {
                    // อนุมัติแบบยังไม่จ่าย: ถ้าเคยมีใบเสร็จที่ใช้งานอยู่ให้ถือว่าจ่ายแล้วต่อไป ไม่ย้อนสถานะ
                    await tx.run(
                        `UPDATE bookings SET payment_status = CASE WHEN EXISTS (SELECT 1 FROM receipts WHERE booking_id = ? AND status = 'issued') THEN 'paid' ELSE 'unpaid' END WHERE id = ?`,
                        [req.params.id, req.params.id]
                    );
                }
                return { receipt };
            });
            res.json({
                message: `อัปเดตสถานะเป็น ${status} เรียบร้อยแล้ว`, status, checked_in: checkIn,
                payment_status: status === 'approved' ? (paid || out.receipt ? 'paid' : 'unpaid') : undefined,
                receipt: out.receipt || null
            });
        } catch (err) {
            if (err.http) return res.status(err.http).json({ error: err.message, code: err.code });
            console.error(err);
            res.status(500).json({ error: 'อัปเดตสถานะไม่สำเร็จ' });
        }
    }
);

// ============================================================
// PATCH /api/bookings/admin/:id/payment - แอดมิน/พนักงาน: เปลี่ยนสถานะ "ยังไม่จ่าย" → "จ่ายแล้ว" แล้วออกใบเสร็จทันที
// body.paymentMethod: transfer | cash | promptpay (ต้องระบุ)
// ถ้ามีใบเสร็จที่ใช้งานอยู่แล้วจะไม่ออกซ้ำ (คืนใบเดิม)
// ============================================================
router.patch(
    '/admin/:id/payment',
    requireStaff,
    [
        param('id').isInt(),
        body('paymentMethod').isIn([...RECEIPT_METHODS]).withMessage('กรุณาเลือกวิธีชำระเงิน')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return badRequest(res, errors.array()[0].msg);

        try {
            const receipt = await dbTransaction(async (tx) => {
                const b = await tx.get('SELECT id, status FROM bookings WHERE id = ?', [req.params.id]);
                if (!b) throw Object.assign(new Error('ไม่พบรายการจองนี้'), { http: 404 });
                if (b.status !== 'approved') {
                    throw Object.assign(new Error('รับชำระได้เฉพาะการจองที่อนุมัติแล้ว'), { http: 409, code: 'NOT_APPROVED' });
                }
                const existing = await tx.get("SELECT * FROM receipts WHERE booking_id = ? AND status = 'issued'", [b.id]);
                if (existing) {
                    await tx.run("UPDATE bookings SET payment_status = 'paid', updated_at = datetime('now') WHERE id = ?", [b.id]);
                    return existing;
                }
                return issueReceiptTx(tx, b.id, { method: req.body.paymentMethod, issuedBy: req.admin.username });
            });
            res.json({ message: 'บันทึกการชำระเงินและออกใบเสร็จเรียบร้อยแล้ว', payment_status: 'paid', receipt });
        } catch (err) {
            if (err.http) return res.status(err.http).json({ error: err.message, code: err.code });
            console.error(err);
            res.status(500).json({ error: 'บันทึกการชำระเงินไม่สำเร็จ' });
        }
    }
);

// ============================================================
// PATCH /api/bookings/admin/:id/checkin - แอดมิน/พนักงาน: ยืนยัน/ยกเลิกการเช็กอิน
// ============================================================
router.patch(
    '/admin/:id/checkin',
    requireStaff,
    [param('id').isInt(), body('checked_in').isBoolean()],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return badRequest(res, errors.array()[0].msg);

        const checkedIn = req.body.checked_in === true || req.body.checked_in === 'true' ? 1 : 0;
        const result = await dbRun(`
            UPDATE bookings
            SET checked_in = ?, checked_in_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, updated_at = datetime('now')
            WHERE id = ? AND status = 'approved'
        `, [checkedIn, checkedIn, req.params.id]);

        if (result.changes === 0) {
            const b = await dbGet('SELECT status FROM bookings WHERE id = ?', [req.params.id]);
            if (b && b.status === 'pending') {
                return res.status(409).json({ error: 'การจองนี้ยังรอตรวจสอบสลิป ต้องให้แอดมินอนุมัติก่อนจึงจะเช็กอินได้', code: 'NOT_APPROVED' });
            }
            return res.status(404).json({ error: 'ไม่พบรายการจองนี้ หรือรายการถูกปฏิเสธแล้ว' });
        }

        res.json({ message: checkedIn ? 'เช็กอินเข้างานเรียบร้อยแล้ว' : 'ยกเลิกการเช็กอินเรียบร้อยแล้ว', checked_in: !!checkedIn });
    }
);

// ============================================================
// POST /api/bookings/staff/scan - แอดมิน/พนักงาน: สแกน QR บัตรแล้วเช็กอินทันที
// เช็กอินด้วยคำสั่ง UPDATE เดียวที่มีเงื่อนไข checked_in = 0 จึงสแกนซ้ำพร้อมกันจากสองประตูไม่ได้ (คนแรกชนะ)
// ============================================================
router.post('/staff/scan', requireStaff, [body('token').isString().notEmpty()], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return badRequest(res, 'ไม่พบรหัสบัตร');

    const token = String(req.body.token).trim().replace(/^BT1:/i, '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(token)) return res.json({ result: 'NOT_FOUND' });

    const b = await dbGet(
        `SELECT id, booking_code, first_name, last_name, status, checked_in, checked_in_at, total_amount, payment_status
         FROM bookings WHERE ticket_token = ?`,
        [token]
    );
    if (!b) return res.json({ result: 'NOT_FOUND' });

    const tables = (await dbAll(
        `SELECT li.table_code FROM booking_tables bt JOIN layout_items li ON li.id = bt.layout_item_id WHERE bt.booking_id = ? ORDER BY bt.id`,
        [b.id]
    )).map(t => t.table_code);

    const info = {
        bookingId: Number(b.id), bookingCode: b.booking_code,
        name: `${b.first_name} ${b.last_name}`.trim(), tables,
        paymentStatus: b.payment_status, totalAmount: Number(b.total_amount)
    };

    if (b.status === 'pending') return res.json({ result: 'NOT_APPROVED', ...info });
    if (b.status === 'rejected') return res.json({ result: 'REJECTED', ...info });

    const upd = await dbRun(
        `UPDATE bookings SET checked_in = 1, checked_in_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND status = 'approved' AND checked_in = 0`,
        [b.id]
    );
    if (upd.changes === 1) {
        const fresh = await dbGet('SELECT checked_in_at FROM bookings WHERE id = ?', [b.id]);
        return res.json({ result: 'OK', checkedInAt: fresh.checked_in_at, ...info });
    }
    const cur = await dbGet('SELECT checked_in_at FROM bookings WHERE id = ?', [b.id]);
    return res.json({ result: 'ALREADY', checkedInAt: cur ? cur.checked_in_at : b.checked_in_at, ...info });
});

// ============================================================
// POST /api/bookings/admin/walkin - แอดมิน/พนักงาน: บันทึกลูกค้าหน้างาน (ซื้อแล้วเข้างานทันที)
// ============================================================
router.post('/admin/walkin', requireStaff, async (req, res) => {
    const { firstName, lastName, phone, tableCode, paymentMethod } = req.body;
    if (!tableCode) return badRequest(res, 'กรุณาระบุรหัสโต๊ะ');
    const method = PAYMENT_METHODS.has(paymentMethod) ? paymentMethod : 'cash';

    const table = await dbGet("SELECT id, table_code, price FROM layout_items WHERE kind = 'table' AND table_code = ?", [String(tableCode)]);
    if (!table) return badRequest(res, 'ไม่พบโต๊ะนี้ในระบบ');

    let pPhone = 'จองผ่านพนักงาน';
    if (phone && String(phone).trim()) {
        const digits = normalizePhone(phone);
        if (!isValidPhone(digits)) return badRequest(res, 'รูปแบบเบอร์โทรไม่ถูกต้อง');
        pPhone = digits;
    }
    const fName = clean(String(firstName || '').trim() || 'ลูกค้าหน้างาน');
    const lName = clean(String(lastName || '').trim() || '(Walk-in)');
    const price = parsePrice(table.price);

    for (let attempt = 0; attempt < 5; attempt++) {
        const bookingCode = genWalkinCode();
        try {
            const bookingId = await dbTransaction(async (tx) => {
                await expireStalePending(tx.run);
                const active = await tx.get(`
                    SELECT bt.id FROM booking_tables bt
                    JOIN bookings b ON b.id = bt.booking_id
                    WHERE b.status IN ('pending','approved') AND bt.layout_item_id = ?
                `, [table.id]);
                if (active) throw new Error('TABLE_TAKEN');

                const result = await tx.run(`
                    INSERT INTO bookings (booking_code, first_name, last_name, phone, slip_filename, status, checked_in, checked_in_at, ticket_token, total_amount, payment_method, payment_status)
                    VALUES (?, ?, ?, ?, 'staff_approved', 'approved', 1, datetime('now'), ?, ?, ?, 'paid')
                `, [bookingCode, fName, lName, pPhone, genTicketToken(), price, method]);
                await tx.run('INSERT INTO booking_tables (booking_id, layout_item_id, price) VALUES (?, ?, ?)', [result.lastInsertRowid, table.id, price]);
                return result.lastInsertRowid;
            });
            return res.status(201).json({
                message: 'บันทึก Walk-in และเช็กอินเรียบร้อย',
                bookingCode, bookingId, tableCode: table.table_code, totalAmount: price, paymentMethod: method
            });
        } catch (err) {
            if (err.message === 'TABLE_TAKEN') {
                return res.status(409).json({ error: 'โต๊ะนี้ถูกจองไปแล้ว', code: 'TABLE_TAKEN' });
            }
            if (/UNIQUE/i.test(String(err.message)) && /booking_code/i.test(String(err.message))) continue; // รหัสชน สุ่มใหม่
            console.error(err);
            return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล' });
        }
    }
    res.status(500).json({ error: 'สร้างรหัสการจองไม่สำเร็จ กรุณาลองใหม่' });
});

// ============================================================
// POST /api/bookings/admin/:id/move - แอดมิน/พนักงาน: ย้ายการจองไปโต๊ะว่างอื่น
// รหัสโต๊ะแต่ละตัวไม่เปลี่ยน แต่ข้อมูลผู้จอง/สถานะ/QR ย้ายตามไปอยู่โต๊ะใหม่ โต๊ะเดิมกลับเป็นว่าง
// body: { fromCode, toCode, adjustPrice }  adjustPrice=true = ปรับยอดตามราคาโต๊ะใหม่
// ============================================================
router.post(
    '/admin/:id/move',
    requireStaff,
    [
        param('id').isInt(),
        body('fromCode').isString().trim().notEmpty(),
        body('toCode').isString().trim().notEmpty(),
        body('adjustPrice').optional().isBoolean()
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return badRequest(res, 'ข้อมูลการย้ายโต๊ะไม่ครบถ้วน');

        const bookingId = Number(req.params.id);
        const fromCode = String(req.body.fromCode).trim();
        const toCode = String(req.body.toCode).trim();
        const adjustPrice = req.body.adjustPrice === true || req.body.adjustPrice === 'true';
        if (fromCode === toCode) return badRequest(res, 'โต๊ะต้นทางและปลายทางเป็นโต๊ะเดียวกัน');

        try {
            const out = await dbTransaction(async (tx) => {
                await expireStalePending(tx.run);

                const booking = await tx.get('SELECT id, status, total_amount FROM bookings WHERE id = ?', [bookingId]);
                if (!booking) throw Object.assign(new Error('ไม่พบรายการจองนี้'), { http: 404 });
                if (booking.status === 'rejected') {
                    throw Object.assign(new Error('การจองนี้ถูกปฏิเสธ/หมดอายุแล้ว ย้ายโต๊ะไม่ได้'), { http: 409 });
                }

                const from = await tx.get(`
                    SELECT bt.id AS bt_id, bt.price AS old_price, li.id AS layout_id
                    FROM booking_tables bt JOIN layout_items li ON li.id = bt.layout_item_id
                    WHERE bt.booking_id = ? AND li.table_code = ?
                `, [bookingId, fromCode]);
                if (!from) throw Object.assign(new Error('โต๊ะต้นทางไม่ได้เป็นของการจองนี้'), { http: 400 });

                const to = await tx.get("SELECT id, table_code, price FROM layout_items WHERE kind = 'table' AND table_code = ?", [toCode]);
                if (!to) throw Object.assign(new Error('ไม่พบโต๊ะปลายทางในระบบ'), { http: 400 });

                const clash = await tx.get(`
                    SELECT bt.id FROM booking_tables bt
                    JOIN bookings b ON b.id = bt.booking_id
                    WHERE b.status IN ('pending','approved') AND bt.layout_item_id = ?
                `, [to.id]);
                if (clash) throw Object.assign(new Error('โต๊ะปลายทางไม่ว่างแล้ว (มีคนจองไปก่อน) กรุณาเลือกโต๊ะอื่น'), { http: 409, code: 'TABLE_TAKEN' });

                const oldPrice = Number(from.old_price);
                const newPrice = parsePrice(to.price);
                const oldTotal = Number(booking.total_amount);
                let newTotal = oldTotal;

                if (adjustPrice) {
                    newTotal = oldTotal - oldPrice + newPrice;
                    await tx.run('UPDATE booking_tables SET layout_item_id = ?, price = ? WHERE id = ?', [to.id, newPrice, from.bt_id]);
                    await tx.run("UPDATE bookings SET total_amount = ?, updated_at = datetime('now') WHERE id = ?", [newTotal, bookingId]);
                } else {
                    await tx.run('UPDATE booking_tables SET layout_item_id = ? WHERE id = ?', [to.id, from.bt_id]);
                    await tx.run("UPDATE bookings SET updated_at = datetime('now') WHERE id = ?", [bookingId]);
                }

                await tx.run(
                    `INSERT INTO booking_moves (booking_id, from_code, to_code, old_total, new_total, price_adjusted, moved_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [bookingId, fromCode, toCode, oldTotal, newTotal, adjustPrice ? 1 : 0, req.admin.username]
                );
                const rc = await tx.get("SELECT COUNT(*) AS c FROM receipts WHERE booking_id = ? AND status = 'issued'", [bookingId]);

                return {
                    fromCode, toCode, oldPrice, newPrice,
                    priceDiff: newPrice - oldPrice, adjusted: adjustPrice,
                    totalAmount: newTotal, hasReceipt: Number(rc.c) > 0
                };
            });
            res.json({ message: `ย้ายโต๊ะ ${fromCode} → ${toCode} เรียบร้อยแล้ว`, ...out });
        } catch (err) {
            if (err.http) return res.status(err.http).json({ error: err.message, code: err.code });
            console.error(err);
            res.status(500).json({ error: 'เกิดข้อผิดพลาดในการย้ายโต๊ะ' });
        }
    }
);

// ============================================================
// POST /api/bookings/admin/:id/cancel-walkin - แอดมิน/พนักงาน: ยกเลิก Walk-in ที่บันทึกผิด (ปล่อยโต๊ะกลับเป็นว่าง)
// ยกเลิกได้เฉพาะรายการ WALK-xxxx พนักงานหน้างานยกเลิกได้ภายใน 30 นาทีหลังบันทึก (แอดมินไม่จำกัด)
// ============================================================
router.post('/admin/:id/cancel-walkin', requireStaff, [param('id').isInt()], async (req, res) => {
    const b = await dbGet(
        `SELECT id, booking_code, status, (created_at >= datetime('now', '-30 minutes')) AS is_recent FROM bookings WHERE id = ?`,
        [req.params.id]
    );
    if (!b) return res.status(404).json({ error: 'ไม่พบรายการจองนี้' });
    if (!String(b.booking_code).startsWith('WALK-')) {
        return badRequest(res, 'ยกเลิกด้วยวิธีนี้ได้เฉพาะรายการ Walk-in เท่านั้น');
    }
    if (b.status === 'rejected') return res.status(409).json({ error: 'รายการนี้ถูกยกเลิกไปแล้ว' });
    if (req.admin.role !== 'admin' && !Number(b.is_recent)) {
        return res.status(403).json({ error: 'พนักงานยกเลิก Walk-in ได้ภายใน 30 นาทีหลังบันทึกเท่านั้น กรุณาแจ้งแอดมิน', code: 'TOO_OLD' });
    }
    await dbRun(
        `UPDATE bookings SET status = 'rejected', checked_in = 0, checked_in_at = NULL, updated_at = datetime('now') WHERE id = ?`,
        [b.id]
    );
    res.json({ message: 'ยกเลิกรายการ Walk-in เรียบร้อยแล้ว โต๊ะกลับเป็นว่าง' });
});

// ---------- CSV ----------
function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^\d+$/.test(s)) s = "'" + s; // กัน CSV/Excel formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function bookingsToCsv(rows) {
    const header = ['รหัสการจอง', 'ชื่อ', 'นามสกุล', 'เบอร์โทร', 'โต๊ะ', 'สถานะ', 'เช็กอิน', 'เวลาเช็กอิน', 'ยอดรวม(บาท)', 'วิธีชำระ', 'สถานะชำระเงิน', 'เวลาที่จอง'];
    const lines = [header.map(csvCell).join(',')];
    for (const b of rows) {
        lines.push([
            b.booking_code, b.first_name, b.last_name, b.phone, (b.tableList || []).join(' '),
            b.status, b.checked_in ? 'เข้างานแล้ว' : '', b.checked_in_at || '', b.total_amount, b.payment_method, b.payment_status === 'paid' ? 'จ่ายแล้ว' : 'ยังไม่จ่าย', b.created_at
        ].map(csvCell).join(','));
    }
    return '\uFEFF' + lines.join('\r\n'); // BOM ให้ Excel อ่านภาษาไทยถูก
}

// GET /api/bookings/admin/export.csv - แอดมินเท่านั้น: ดาวน์โหลดรายการจองปัจจุบันเป็น CSV
router.get('/admin/export.csv', requireAdmin, async (req, res) => {
    const rows = await loadBookingsWithTables(dbAll);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="bookings.csv"' });
    res.send(bookingsToCsv(rows));
});

// GET /api/bookings/admin/archives - แอดมินเท่านั้น: รายการงานที่เคยสิ้นสุดและถูกสำรองไว้
router.get('/admin/archives', requireAdmin, async (req, res) => {
    const rows = await dbAll('SELECT id, ended_at, ended_by, concert_title, booking_count FROM archives ORDER BY id DESC LIMIT 100');
    res.json(rows);
});

router.get('/admin/archives/:id/csv', requireAdmin, [param('id').isInt()], async (req, res) => {
    const a = await dbGet('SELECT id, data FROM archives WHERE id = ?', [req.params.id]);
    if (!a) return res.status(404).json({ error: 'ไม่พบข้อมูลสำรอง' });
    const data = JSON.parse(a.data);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bookings-archive-${a.id}.csv"` });
    res.send(bookingsToCsv(data.bookings || []));
});

// ============================================================
// POST /api/bookings/end-concert - สิ้นสุดคอนเสิร์ต (แอดมินเท่านั้น)
//  - ต้องส่งรหัสผ่านมายืนยันที่ server (เดิมเช็กแค่ฝั่งหน้าเว็บ)
//  - สำรองรายการจองทั้งหมดลงตาราง archives ในธุรกรรมเดียวกับการลบ ถ้าสำรองไม่สำเร็จจะไม่ลบอะไรเลย
//  - ผังโต๊ะและใบเสร็จไม่ถูกลบ
// ============================================================
const endConcertLimiter = dbRateLimit({
    name: 'end-concert', windowMs: 15 * 60 * 1000, max: 5,
    keyFn: (req) => String(req.admin && req.admin.sub),
    message: 'ยืนยันรหัสผ่านผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่'
});

router.post('/end-concert', requireAdmin, endConcertLimiter, [body('password').isString().notEmpty()], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return badRequest(res, 'กรุณากรอกรหัสผ่านเพื่อยืนยัน');

    const admin = await dbGet('SELECT * FROM admin_users WHERE id = ?', [req.admin.sub]);
    if (!admin || !(await bcrypt.compare(String(req.body.password), admin.password_hash))) {
        // 403 ไม่ใช่ 401 เพื่อไม่ให้หน้าเว็บเข้าใจผิดว่าเซสชันหมดอายุ
        return res.status(403).json({ error: 'รหัสผ่านไม่ถูกต้อง', code: 'WRONG_PASSWORD' });
    }

    try {
        const settings = await getAllSettings(true);
        const result = await dbTransaction(async (tx) => {
            const bookings = await loadBookingsWithTables(tx.all);
            const moves = await tx.all('SELECT * FROM booking_moves ORDER BY id');
            let archiveId = null;
            if (bookings.length > 0) {
                const r = await tx.run(
                    'INSERT INTO archives (ended_by, concert_title, booking_count, data) VALUES (?, ?, ?, ?)',
                    [req.admin.username, settings.concert_title || '', bookings.length, JSON.stringify({ bookings, moves })]
                );
                archiveId = r.lastInsertRowid;
            }
            await tx.run('DELETE FROM booking_tables');
            await tx.run('DELETE FROM booking_moves');
            await tx.run('DELETE FROM bookings');
            return { archiveId, count: bookings.length };
        });

        res.json({
            message: 'สิ้นสุดคอนเสิร์ต เคลียร์สถานะโต๊ะและรายการจองเรียบร้อยแล้ว (คงผังเดิมไว้ และสำรองข้อมูลไว้แล้ว)',
            archiveId: result.archiveId,
            archivedBookings: result.count
        });
    } catch (err) {
        console.error('End concert error:', err);
        res.status(500).json({ error: 'สิ้นสุดคอนเสิร์ตไม่สำเร็จ ยังไม่มีข้อมูลถูกลบ กรุณาลองใหม่' });
    }
});

// POST /api/bookings/admin/archives/:id/purge-slips - แอดมินเท่านั้น: ลบรูปสลิปของงานที่สำรองไว้ออกจาก Cloudinary
// ทำทีละไม่เกิน 25 รูปต่อครั้ง (กัน serverless timeout) เรียกซ้ำจนกว่า remaining = 0
router.post('/admin/archives/:id/purge-slips', requireAdmin, [param('id').isInt()], async (req, res) => {
    const a = await dbGet('SELECT id, data FROM archives WHERE id = ?', [req.params.id]);
    if (!a) return res.status(404).json({ error: 'ไม่พบข้อมูลสำรอง' });

    const data = JSON.parse(a.data);
    const pending = (data.bookings || []).filter(b => b.slip_filename && b.slip_filename !== 'staff_approved' && !b.slip_purged);
    const batch = pending.slice(0, 25);

    for (let i = 0; i < batch.length; i += 5) {
        await Promise.all(batch.slice(i, i + 5).map(async (b) => {
            const stored = b.slip_filename;
            const isUrl = /^https?:\/\//i.test(stored);
            const publicId = isUrl ? publicIdFromUrl(stored) : stored;
            if (!publicId) { b.slip_purged = true; return; }
            const ok = await destroyAsset(publicId, { private: !isUrl });
            if (ok) b.slip_purged = true;
        }));
    }

    await dbRun('UPDATE archives SET data = ? WHERE id = ?', [JSON.stringify(data), a.id]);
    const remaining = (data.bookings || []).filter(b => b.slip_filename && b.slip_filename !== 'staff_approved' && !b.slip_purged).length;
    res.json({ purged: batch.filter(b => b.slip_purged).length, remaining });
});

module.exports = router;
