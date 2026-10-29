const express = require('express');
const { body, validationResult } = require('express-validator');
const { dbBatch } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { clean, cleanUrl } = require('../utils/sanitize');
const { getAllSettings, invalidateSettings, PUBLIC_KEYS, computeSalesState } = require('../utils/settings');

const router = express.Router();

// ตัวตรวจ/ทำความสะอาดค่าของแต่ละคีย์ — คืนค่าที่จะบันทึก หรือ throw Error(ข้อความภาษาไทย) ถ้าไม่ถูกต้อง
const plain = (v) => clean(String(v));
const VALIDATORS = {
    concert_title: plain, concert_date: plain, price_vip: plain, price_normal: plain, price_general: plain,
    bank_name: plain, bank_account_no: plain, bank_account_name: plain, promptpay_id: plain,
    receipt_shop_name: plain, receipt_shop_address: plain, receipt_tax_id: plain, receipt_footer: plain,

    google_sheet_url: (v) => {
        const u = cleanUrl(v);
        if (u === null) throw new Error('ลิงก์ Google Sheet ไม่ถูกต้อง (ต้องขึ้นต้นด้วย https://)');
        return u;
    },
    // JSON ของลิงก์รูปจาก Cloudinary ที่ระบบสร้างเอง จึงไม่ตัดที่ 500 ตัวอักษรแบบข้อความทั่วไป แต่ต้องเป็น JSON ที่ถูกต้อง
    poster_config: (v) => {
        try { JSON.parse(String(v)); } catch { throw new Error('ข้อมูลโปสเตอร์ไม่ถูกต้อง (poster_config ต้องเป็น JSON)'); }
        return String(v);
    },
    sales_status: (v) => {
        if (!['open', 'closed', 'soldout'].includes(String(v))) throw new Error('สถานะการขายไม่ถูกต้อง');
        return String(v);
    },
    sales_close_at: (v) => {
        const s = String(v || '').trim();
        if (s && Number.isNaN(Date.parse(s.length <= 16 ? s + '+07:00' : s))) throw new Error('วันเวลาปิดขายไม่ถูกต้อง');
        return s;
    },
    max_tables_per_booking: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('จำนวนโต๊ะสูงสุดต่อการจองต้องเป็นเลข 1-50');
        return String(n);
    },
    pending_expire_hours: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 720) throw new Error('ชั่วโมงหมดอายุของรายการรอตรวจสอบต้องเป็น 0-720 (0 = ไม่หมดอายุ)');
        return String(n);
    },
    // เงื่อนไขการจอง: array ของข้อความ (เก็บใน DB ให้ลูกค้าทุกเครื่องเห็นตรงกัน แสดงผลด้วย textContent)
    booking_rules: (v) => {
        let arr;
        try { arr = typeof v === 'string' ? JSON.parse(v) : v; } catch { arr = null; }
        if (!Array.isArray(arr) || arr.length > 30) throw new Error('เงื่อนไขการจองต้องเป็นรายการข้อความ (ไม่เกิน 30 ข้อ)');
        const rules = arr.map(x => clean(String(x))).filter(Boolean);
        return JSON.stringify(rules);
    }
};
const ALLOWED_KEYS = new Set(Object.keys(VALIDATORS));

// GET /api/settings - สาธารณะ: ส่งเฉพาะค่าที่หน้าเว็บลูกค้าต้องใช้ (ไม่รวมลิงก์ Google Sheet/ข้อมูลใบเสร็จ)
router.get('/', async (req, res) => {
    const all = await getAllSettings();
    const obj = {};
    PUBLIC_KEYS.forEach(k => { if (all[k] !== undefined) obj[k] = all[k]; });
    res.json(obj);
});

// GET /api/settings/admin - แอดมินเท่านั้น: ค่าทั้งหมดรวมค่าภายใน
router.get('/admin', requireAdmin, async (req, res) => {
    const all = await getAllSettings(true);
    const obj = {};
    for (const k of ALLOWED_KEYS) if (all[k] !== undefined) obj[k] = all[k];
    res.json(obj);
});

// GET /api/settings/sales - สาธารณะ: สถานะการขายที่คำนวณจากเวลาบน server (เปิด/ปิดการขาย/ขายหมด)
router.get('/sales', async (req, res) => {
    const state = computeSalesState(await getAllSettings());
    res.set('Cache-Control', 'no-store');
    res.json(state);
});

router.get('/bank', async (req, res) => {
    const obj = await getAllSettings();
    res.json({
        bank_name: obj.bank_name || '',
        account_no: obj.bank_account_no || '',
        account_name: obj.bank_account_name || '',
        promptpay_id: obj.promptpay_id || ''
    });
});

// PUT /api/settings - แอดมินเท่านั้น
router.put('/', requireAdmin, [body().custom(v => v && typeof v === 'object' && !Array.isArray(v))], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });

    const statements = [];
    for (const [key, value] of Object.entries(req.body)) {
        if (!ALLOWED_KEYS.has(key)) continue;
        let safeValue;
        try {
            safeValue = VALIDATORS[key](value === null || value === undefined ? '' : value);
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }
        statements.push({
            sql: `INSERT INTO settings (key, value) VALUES (?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            args: [key, safeValue]
        });
    }

    if (statements.length > 0) {
        await dbBatch(statements);
        invalidateSettings();
    }
    res.json({ message: 'บันทึกการตั้งค่าเรียบร้อยแล้ว' });
});

module.exports = router;
