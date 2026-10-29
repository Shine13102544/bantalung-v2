// ตัวช่วยสำหรับชุดทดสอบ: ใช้ฐานข้อมูล SQLite ไฟล์ชั่วคราว และจำลอง Cloudinary (ไม่ต้องต่อเน็ต)
const os = require('os');
const fs = require('fs');
const path = require('path');

function setupEnv() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bantalung-test-'));
    process.env.TURSO_DATABASE_URL = 'file:' + path.join(dir, 'test.db');
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
    process.env.CLOUDINARY_CLOUD_NAME = 'demo';
    process.env.CLOUDINARY_API_KEY = '123';
    process.env.CLOUDINARY_API_SECRET = 'secret';
    process.env.NODE_ENV = 'test';
    delete process.env.VERCEL;
    return dir;
}

// แทนที่ utils/cloudinary ด้วยตัวปลอมที่บันทึกการเรียกไว้ตรวจสอบ
function stubCloudinary() {
    const real = require('../utils/cloudinary');
    const calls = { uploaded: [], destroyed: [] };
    let n = 0;
    const stub = {
        ...real,
        uploadBuffer: async (buf, opts) => {
            n++;
            const publicId = `bantalung/${opts.folder}/fake${n}`;
            calls.uploaded.push({ publicId, private: !!opts.private });
            return { publicId, url: `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.jpg`, type: opts.private ? 'authenticated' : 'upload' };
        },
        destroyAsset: async (publicId, o) => { calls.destroyed.push({ publicId, private: !!(o && o.private) }); return true; },
        slipUrlFor: (stored) => (stored && stored !== 'staff_approved' ? `https://signed.example/${stored}` : null)
    };
    const key = require.resolve('../utils/cloudinary');
    require.cache[key].exports = stub;
    return calls;
}

// ไฟล์ JPEG จำลอง (มี magic number ถูกต้อง)
function fakeJpeg() {
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF-test-image-data'.repeat(4))]);
}

module.exports = { setupEnv, stubCloudinary, fakeJpeg };
