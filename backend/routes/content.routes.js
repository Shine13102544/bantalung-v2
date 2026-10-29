const express = require('express');
const router = express.Router();
const multer = require('multer');
const { dbGet, dbAll, dbRun } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { clean, cleanUrl } = require('../utils/sanitize');
const { uploadBuffer, destroyAsset, publicIdFromUrl, detectImageType } = require('../utils/cloudinary');

// ---- อัปโหลดรูปเมนู/โปสเตอร์ ----
// รับเข้า memory (จำกัด 5MB และตรวจชนิดไฟล์จากเนื้อไฟล์จริง) แล้วส่งขึ้น Cloudinary
// เก็บบน Cloudinary ไม่ใช่ดิสก์เซิร์ฟเวอร์ เพราะไฟล์บนดิสก์จะหายทุกครั้งที่ redeploy
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_MIME.has(file.mimetype)) return cb(new Error('รองรับเฉพาะไฟล์รูปภาพ (JPEG, PNG, WEBP) เท่านั้น'));
        cb(null, true);
    }
});

function singleImage(field) {
    return (req, res, next) => {
        imageUpload.single(field)(req, res, (err) => {
            if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ต้องมีขนาดไม่เกิน 5MB' : err.message });
            if (req.file && !detectImageType(req.file.buffer)) {
                return res.status(400).json({ error: 'ไฟล์ที่แนบไม่ใช่รูปภาพที่รองรับ (JPEG, PNG, WEBP)' });
            }
            next();
        });
    };
}

// GET /api/content/menu
router.get('/menu', async (req, res) => {
    const items = await dbAll('SELECT * FROM menu_items ORDER BY id DESC');
    res.json(items);
});

// POST /api/content/menu/save (อัปโหลดรูปขึ้น Cloudinary โดยตรง)
router.post('/menu/save', requireAdmin, singleImage('image'), async (req, res) => {
    const { id, is_available } = req.body;
    const name = clean(req.body.name || '');
    const category = clean(req.body.category || '');
    const price = Number(req.body.price);

    if (!name || !Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: 'กรุณากรอกชื่อเมนูและราคาที่ถูกต้อง' });
    }
    if (id && !/^\d+$/.test(String(id))) return res.status(400).json({ error: 'รหัสเมนูไม่ถูกต้อง' });

    let imageUrl = null;
    if (req.file) {
        try {
            imageUrl = (await uploadBuffer(req.file.buffer, { folder: 'menu', optimize: true })).url;
        } catch (err) {
            console.error('อัปโหลดรูปเมนูไม่สำเร็จ:', err.message);
            return res.status(502).json({ error: 'อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่' });
        }
    }

    const available = is_available === 'true' || is_available === true ? 1 : 0;
    if (id) {
        const old = imageUrl ? await dbGet('SELECT image_url FROM menu_items WHERE id = ?', [id]) : null;
        if (imageUrl) {
            await dbRun('UPDATE menu_items SET name=?, category=?, price=?, is_available=?, image_url=? WHERE id=?',
                [name, category, price, available, imageUrl, id]);
            // ลบรูปเก่าที่ถูกแทนที่ ไม่ให้ค้างบน Cloudinary
            if (old && old.image_url) await destroyAsset(publicIdFromUrl(old.image_url));
        } else {
            await dbRun('UPDATE menu_items SET name=?, category=?, price=?, is_available=? WHERE id=?',
                [name, category, price, available, id]);
        }
    } else {
        await dbRun('INSERT INTO menu_items (name, category, price, is_available, image_url) VALUES (?, ?, ?, ?, ?)',
            [name, category, price, available, imageUrl]);
    }
    res.json({ message: 'บันทึกเมนูสำเร็จ' });
});

// DELETE /api/content/menu/:id (ลบรูปบน Cloudinary ด้วย)
router.delete('/menu/:id', requireAdmin, async (req, res) => {
    if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: 'รหัสเมนูไม่ถูกต้อง' });
    const old = await dbGet('SELECT image_url FROM menu_items WHERE id = ?', [req.params.id]);
    await dbRun('DELETE FROM menu_items WHERE id = ?', [req.params.id]);
    if (old && old.image_url) await destroyAsset(publicIdFromUrl(old.image_url));
    res.json({ message: 'ลบสำเร็จ' });
});

// GET & POST Contact
router.get('/contact', async (req, res) => {
    res.json(await dbGet('SELECT * FROM site_contact WHERE id = 1'));
});
router.post('/contact/save', requireAdmin, async (req, res) => {
    const phone = clean(req.body.phone || '');
    const line_id = clean(req.body.line_id || '');
    const open_hours = clean(req.body.open_hours || '');
    const address = clean(req.body.address || '');

    // ลิงก์ต้องเป็น http/https เท่านั้น (กัน javascript: ที่ถูกนำไปใส่ใน href)
    const facebook = cleanUrl(req.body.facebook || '');
    const google_maps_url = cleanUrl(req.body.google_maps_url || '');
    if (facebook === null) return res.status(400).json({ error: 'ลิงก์ Facebook ไม่ถูกต้อง' });
    if (google_maps_url === null) return res.status(400).json({ error: 'ลิงก์ Google Maps ไม่ถูกต้อง' });

    await dbRun('UPDATE site_contact SET phone=?, line_id=?, facebook=?, open_hours=?, address=?, google_maps_url=? WHERE id=1',
        [phone, line_id, facebook, open_hours, address, google_maps_url]);
    res.json({ message: 'อัปเดตเรียบร้อย' });
});

// POST /api/content/poster/upload - อัปโหลดรูปโปสเตอร์ 1 รูปขึ้น Cloudinary (แอดมินเท่านั้น)
// คืนแค่ URL กลับไป ไม่ได้บันทึกลง DB ที่นี่ - ฝั่งหน้าเว็บจะเก็บ URL นี้ไว้ในรายการโปสเตอร์
// แล้วค่อยกด "บันทึกโปสเตอร์" (PUT /api/settings) เพื่อบันทึกทั้งชุดอีกที
router.post('/poster/upload', requireAdmin, singleImage('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'กรุณาแนบรูปภาพ' });
    try {
        const up = await uploadBuffer(req.file.buffer, { folder: 'posters', optimize: true });
        res.json({ url: up.url });
    } catch (err) {
        console.error('อัปโหลดโปสเตอร์ไม่สำเร็จ:', err.message);
        res.status(502).json({ error: 'อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่' });
    }
});

module.exports = router;
