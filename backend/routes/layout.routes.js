const express = require('express');
const { body, validationResult } = require('express-validator');
const { dbAll, dbTransaction } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { clean, isValidCssSize, isValidCssColor } = require('../utils/sanitize');
const { expireStalePending } = require('../utils/bookings');

const router = express.Router();

// GET /api/layout - สาธารณะ: หน้าแรกใช้แสดงผังโต๊ะ พร้อมสถานะจองล่าสุด (คำนวณจาก DB จริง ไม่ใช่ localStorage)
router.get('/', async (req, res) => {
    await expireStalePending();
    const items = await dbAll('SELECT * FROM layout_items ORDER BY sort_order ASC, id ASC');

    // โต๊ะที่กำลังถูกจองอยู่ (pending หรือ approved ถือว่าไม่ว่างแล้ว) พร้อมสถานะเช็กอินจริง (ไม่มีข้อมูลลูกค้าติดมาด้วย)
    const activeRows = await dbAll(`
        SELECT bt.layout_item_id AS id, b.status, b.checked_in
        FROM booking_tables bt
        JOIN bookings b ON b.id = bt.booking_id
        WHERE b.status IN ('pending', 'approved')
    `);
    const statusMap = new Map(activeRows.map(r => [Number(r.id), r.status]));
    const checkedInMap = new Map(activeRows.map(r => [Number(r.id), !!r.checked_in]));

    res.set('Cache-Control', 'no-store');
    res.json(items.map(item => ({
        ...item,
        booking_status: item.kind === 'table' ? (statusMap.get(Number(item.id)) || 'available') : undefined,
        checked_in: item.kind === 'table' ? (checkedInMap.get(Number(item.id)) || false) : undefined
    })));
});

const ZONE_TYPES = new Set(['vip', 'normal', 'general']);

// ตรวจและทำความสะอาดแต่ละรายการ — คืน { row } หรือ { error }
function validateItem(it, idx) {
    const where = `รายการที่ ${idx + 1}`;
    if (!it || typeof it !== 'object') return { error: `${where}: ข้อมูลไม่ถูกต้อง` };
    if (!['stage', 'zone', 'table'].includes(it.kind)) return { error: `${where}: kind ไม่ถูกต้อง` };

    const row = { kind: it.kind, table_code: null, zone_type: null };
    if (it.kind === 'table') {
        const code = clean(String(it.table_code || ''));
        if (!code) return { error: `${where}: โต๊ะต้องมีรหัสโต๊ะ (table_code)` };
        if (code.length > 30 || code.includes(',')) return { error: `${where}: รหัสโต๊ะต้องไม่เกิน 30 ตัวอักษรและห้ามมีเครื่องหมายจุลภาค` };
        row.table_code = code;
        row.zone_type = ZONE_TYPES.has(it.zone_type) ? it.zone_type : 'normal';
    }

    row.label = it.label ? clean(String(it.label)).slice(0, 200) : null;
    row.price = it.price ? clean(String(it.price)).slice(0, 30) : null;

    const pos = { pos_left: it.pos_left || '0px', pos_top: it.pos_top || '0px' };
    for (const [k, v] of Object.entries(pos)) {
        if (!isValidCssSize(String(v))) return { error: `${where}: ค่าตำแหน่ง ${k} ไม่ถูกต้อง` };
        row[k] = String(v).trim();
    }
    for (const k of ['width', 'height']) {
        if (it[k] === undefined || it[k] === null || it[k] === '') { row[k] = null; continue; }
        if (!isValidCssSize(String(it[k]))) return { error: `${where}: ค่า ${k} ไม่ถูกต้อง` };
        row[k] = String(it[k]).trim();
    }
    if (it.color === undefined || it.color === null || it.color === '') row.color = null;
    else if (!isValidCssColor(String(it.color))) return { error: `${where}: ค่าสีไม่ถูกต้อง` };
    else row.color = String(it.color).trim();

    return { row };
}

// PUT /api/layout - แอดมินเท่านั้น: บันทึกผังทั้งหมด (ใช้กับตัวแก้ไขแบบลาก-วาง)
// รับ array ของ item ทั้งชุด แล้ว diff กับของเดิม: อัปเดตของเก่า / เพิ่มของใหม่ / ลบที่หายไป
// ห้ามลบโต๊ะที่มีการจองค้างอยู่ (pending/approved) — เช็กและลบภายใน transaction เดียวกัน กันจองแทรกระหว่างทาง
router.put(
    '/',
    requireAdmin,
    [body('items').isArray({ min: 0, max: 600 })],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ error: 'รายการผังไม่ถูกต้อง' });

        const items = req.body.items;
        const rows = [];
        for (let i = 0; i < items.length; i++) {
            const v = validateItem(items[i], i);
            if (v.error) return res.status(400).json({ error: v.error });
            rows.push({ ...v.row, id: items[i].id ? Number(items[i].id) : null });
        }

        try {
            await dbTransaction(async (tx) => {
                const existingRows = await tx.all('SELECT id FROM layout_items');
                const existingIds = new Set(existingRows.map(r => Number(r.id)));
                const incomingIds = new Set(rows.filter(r => r.id).map(r => r.id));
                const toDelete = [...existingIds].filter(id => !incomingIds.has(id));

                if (toDelete.length > 0) {
                    const placeholders = toDelete.map(() => '?').join(',');
                    const blocked = await tx.all(`
                        SELECT DISTINCT bt.layout_item_id
                        FROM booking_tables bt
                        JOIN bookings b ON b.id = bt.booking_id
                        WHERE b.status IN ('pending','approved') AND bt.layout_item_id IN (${placeholders})
                    `, toDelete);
                    if (blocked.length > 0) throw new Error('BLOCKED');
                    for (const id of toDelete) await tx.run('DELETE FROM layout_items WHERE id = ?', [id]);
                }

                for (let idx = 0; idx < rows.length; idx++) {
                    const r = rows[idx];
                    if (r.id && existingIds.has(r.id)) {
                        await tx.run(
                            `UPDATE layout_items SET kind=?, table_code=?, zone_type=?, label=?, price=?,
                                    pos_left=?, pos_top=?, width=?, height=?, color=?, sort_order=? WHERE id=?`,
                            [r.kind, r.table_code, r.zone_type, r.label, r.price, r.pos_left, r.pos_top, r.width, r.height, r.color, idx, r.id]
                        );
                    } else {
                        await tx.run(
                            `INSERT INTO layout_items (kind, table_code, zone_type, label, price, pos_left, pos_top, width, height, color, sort_order)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [r.kind, r.table_code, r.zone_type, r.label, r.price, r.pos_left, r.pos_top, r.width, r.height, r.color, idx]
                        );
                    }
                }
            });
        } catch (err) {
            if (err.message === 'BLOCKED') {
                return res.status(409).json({ error: 'ไม่สามารถลบโต๊ะที่มีการจองค้างอยู่ได้ กรุณาอนุมัติ/ปฏิเสธการจองก่อน' });
            }
            if (String(err.message).includes('UNIQUE')) {
                return res.status(409).json({ error: 'มีรหัสโต๊ะซ้ำกันในผัง กรุณาตรวจสอบ' });
            }
            throw err;
        }

        res.json({ message: 'บันทึกผังเรียบร้อยแล้ว' });
    }
);

module.exports = router;
