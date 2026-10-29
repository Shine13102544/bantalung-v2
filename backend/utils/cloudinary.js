const cloudinary = require('cloudinary').v2;

// ต้องตั้งค่า 3 ตัวนี้ใน .env (สมัครฟรีที่ cloudinary.com แล้วคัดลอกมาจากหน้า Dashboard)
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error('ไม่พบค่า CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET ใน .env กรุณาตั้งค่าก่อนรันเซิร์ฟเวอร์ (ดูวิธีได้ที่ cloudinary.com)');
}

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

// ตรวจชนิดไฟล์จากเนื้อไฟล์จริง (magic number) ไม่เชื่อ Content-Type ที่ client ส่งมา
function detectImageType(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return null;
}

// อัปโหลดไฟล์จาก buffer ขึ้น Cloudinary
// opts.folder: โฟลเดอร์ย่อย, opts.private: true = เก็บแบบ authenticated (ต้องมี signed URL ถึงจะเปิดได้)
function uploadBuffer(buffer, opts = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            folder: `bantalung/${opts.folder || 'misc'}`,
            resource_type: 'image',
            type: opts.private ? 'authenticated' : 'upload',
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp']
        };
        if (opts.optimize) options.transformation = [{ quality: 'auto' }];
        const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
            if (err) return reject(err);
            resolve({ publicId: result.public_id, url: result.secure_url, type: options.type });
        });
        stream.end(buffer);
    });
}

// ลบไฟล์ (ใช้เมื่อการจองไม่สำเร็จ หรือเมื่อลบเมนู) — ไม่ throw เพราะเป็นงานเก็บกวาด
async function destroyAsset(publicId, { private: isPrivate = false } = {}) {
    if (!publicId) return false;
    try {
        await cloudinary.uploader.destroy(publicId, {
            resource_type: 'image',
            type: isPrivate ? 'authenticated' : 'upload',
            invalidate: true
        });
        return true;
    } catch (err) {
        console.error('ลบไฟล์บน Cloudinary ไม่สำเร็จ:', publicId, err.message);
        return false;
    }
}

// ดึง public_id จาก URL ของ Cloudinary (ใช้กับรูปเมนู/สลิปเก่าที่เก็บเป็น URL เต็ม)
function publicIdFromUrl(url) {
    const m = /\/image\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(bantalung\/[^.]+)\.[a-z0-9]+(?:\?.*)?$/i.exec(String(url || ''));
    return m ? m[1] : null;
}

// URL สำหรับให้แอดมินดูสลิป: ไฟล์ใหม่เป็น authenticated ต้องใช้ signed URL
// ค่าใน DB: 'staff_approved' = walk-in (ไม่มีสลิป), http(s)://... = สลิปเก่าแบบสาธารณะ, อย่างอื่น = public_id (private)
function slipUrlFor(stored) {
    if (!stored || stored === 'staff_approved') return null;
    if (/^https?:\/\//i.test(stored)) return stored;
    if (/^\/?uploads\//i.test(stored)) return null; // ไฟล์บนดิสก์เดิมที่ใช้ไม่ได้บน Vercel
    return cloudinary.url(stored, {
        resource_type: 'image',
        type: 'authenticated',
        sign_url: true,
        secure: true
    });
}

module.exports = { cloudinary, uploadBuffer, destroyAsset, publicIdFromUrl, slipUrlFor, detectImageType };
