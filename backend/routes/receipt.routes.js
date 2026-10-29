const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { dbGet, dbAll, dbTransaction, dbRun } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { clean } = require('../utils/sanitize');
const { PAYMENT_METHODS, issueReceiptTx } = require('../utils/receipts');

const router = express.Router();
router.use(requireAdmin);

// GET /api/receipts?bookingId=  - รายการใบเสร็จ (ล่าสุด 300 ใบ) หรือเฉพาะของการจองนั้น
router.get('/', [query('bookingId').optional().isInt()], async (req, res) => {
    const rows = req.query.bookingId
        ? await dbAll('SELECT * FROM receipts WHERE booking_id = ? ORDER BY id DESC', [req.query.bookingId])
        : await dbAll(`SELECT r.*, b.ticket_token FROM receipts r LEFT JOIN bookings b ON b.id = r.booking_id ORDER BY r.id DESC LIMIT 300`);
    res.json(rows);
});

router.get('/:id', [param('id').isInt()], async (req, res) => {
    const r = await dbGet('SELECT * FROM receipts WHERE id = ?', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'ไม่พบใบเสร็จ' });
    res.json(r);
});

// POST /api/receipts - ออกใบเสร็จของการจองที่อนุมัติแล้ว (เก็บ snapshot ชื่อ/โต๊ะ/ยอด ณ ตอนออก)
// เลขที่ใบเสร็จรันต่อเนื่องรายปี (R2026-0001) ออกโดย server ใน transaction และไม่มีการลบ ถ้าผิดให้ void แล้วออกใหม่
router.post(
    '/',
    [
        body('bookingId').isInt(),
        body('paymentMethod').optional().isString(),
        body('note').optional().isString(),
        body('amount').optional({ nullable: true }).isInt({ min: 0, max: 10000000 })
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ error: 'ข้อมูลใบเสร็จไม่ถูกต้อง' });

        try {
            const receipt = await dbTransaction((tx) => issueReceiptTx(tx, req.body.bookingId, {
                amount: req.body.amount, method: req.body.paymentMethod, note: req.body.note, issuedBy: req.admin.username
            }));
            res.status(201).json(receipt);
        } catch (err) {
            if (err.http) return res.status(err.http).json({ error: err.message, code: err.code });
            console.error(err);
            res.status(500).json({ error: 'ออกใบเสร็จไม่สำเร็จ' });
        }
    }
);

// POST /api/receipts/:id/void - ยกเลิกใบเสร็จ (ต้องระบุเหตุผล) เลขที่เดิมไม่ถูกนำกลับมาใช้
router.post('/:id/void', [param('id').isInt(), body('reason').isString().trim().notEmpty()], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'กรุณาระบุเหตุผลที่ยกเลิกใบเสร็จ' });

    // void แล้วการจองกลับเป็น "ยังไม่จ่าย" (ถ้าไม่มีใบเสร็จอื่นที่ใช้งานอยู่) เพื่อให้หน้าลูกค้ากลับไปแสดง QR + ยังไม่จ่าย
    const changed = await dbTransaction(async (tx) => {
        const r = await tx.run(
            `UPDATE receipts SET status = 'void', void_reason = ?, voided_by = ?, voided_at = datetime('now')
             WHERE id = ? AND status = 'issued'`,
            [clean(req.body.reason).slice(0, 200), req.admin.username, req.params.id]
        );
        if (r.changes === 0) return false;
        const rc = await tx.get('SELECT booking_id FROM receipts WHERE id = ?', [req.params.id]);
        if (rc && rc.booking_id) {
            await tx.run(
                `UPDATE bookings SET payment_status = 'unpaid', updated_at = datetime('now')
                 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM receipts WHERE booking_id = ? AND status = 'issued')`,
                [rc.booking_id, rc.booking_id]
            );
        }
        return true;
    });
    if (!changed) return res.status(404).json({ error: 'ไม่พบใบเสร็จ หรือใบเสร็จถูกยกเลิกไปแล้ว' });
    res.json({ message: 'ยกเลิกใบเสร็จเรียบร้อยแล้ว' });
});

module.exports = router;
