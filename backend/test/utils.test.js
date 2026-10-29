const { test } = require('node:test');
const assert = require('node:assert/strict');

require('./helpers').setupEnv(); // ตั้งค่า env จำลอง (ฐานข้อมูลไฟล์ชั่วคราว + คีย์ Cloudinary ปลอม)

const { slipUrlFor, publicIdFromUrl, detectImageType } = require('../utils/cloudinary');
const { normalizePhone, maskPhone, isValidPhone } = require('../utils/phone');
const { clean, cleanUrl, isValidCssSize, isValidCssColor } = require('../utils/sanitize');
const { parsePrice } = require('../utils/money');
const { computeSalesState } = require('../utils/settings');

test('slipUrlFor: ไฟล์ private ได้ signed URL, ของเก่าใช้ URL เดิม, walk-in ไม่มีสลิป', () => {
    const u = slipUrlFor('bantalung/slips/abc123');
    assert.match(u, /^https:\/\/res\.cloudinary\.com\/demo\/image\/authenticated\/s--[A-Za-z0-9_-]{8}--\/.*bantalung\/slips\/abc123/);
    assert.equal(slipUrlFor('https://res.cloudinary.com/demo/image/upload/v1/x.jpg'), 'https://res.cloudinary.com/demo/image/upload/v1/x.jpg');
    assert.equal(slipUrlFor('staff_approved'), null);
    assert.equal(slipUrlFor('/uploads/old.jpg'), null);
});

test('publicIdFromUrl และ detectImageType', () => {
    assert.equal(publicIdFromUrl('https://res.cloudinary.com/demo/image/upload/q_auto/v123/bantalung/menu/ab12.jpg'), 'bantalung/menu/ab12');
    assert.equal(publicIdFromUrl('https://evil.com/x.jpg'), null);
    assert.equal(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'png');
    assert.equal(detectImageType(Buffer.from('RIFFxxxxWEBPyyyy')), 'webp');
    assert.equal(detectImageType(Buffer.from('<?php echo 1; ?> not an image')), null);
});

test('เบอร์โทร: แปลงรูปแบบ, ตรวจ, ปิดบัง', () => {
    for (const p of ['081-234-5678', '081 234 5678', '+66 81 234 5678', '66812345678', '0812345678']) assert.equal(normalizePhone(p), '0812345678', p);
    assert.equal(isValidPhone('12'), false); assert.equal(isValidPhone('0812345678'), true);
    assert.equal(maskPhone('0812345678'), '08x-xxx-5678');
    assert.equal(maskPhone('จองผ่านพนักงาน'), 'จองผ่านพนักงาน');
});

test('sanitize: ลบ tag, ลิงก์ต้อง http/https, ค่า CSS ที่ปลอดภัย', () => {
    assert.equal(clean('  <img src=x onerror=alert(1)>สวัสดี  '), 'สวัสดี');
    assert.equal(cleanUrl('javascript:alert(1)'), null);
    assert.equal(cleanUrl('data:text/html,hi'), null);
    assert.equal(cleanUrl('facebook.com/x'), 'https://facebook.com/x');
    assert.equal(cleanUrl(''), '');
    assert.ok(isValidCssSize('150px') && isValidCssSize('12.345678px') && isValidCssSize('-5%') && !isValidCssSize('10px;x') && !isValidCssSize('calc(1px)'));
    assert.ok(isValidCssColor('#e74c3c') && isValidCssColor('rgb(231, 76, 60)') && !isValidCssColor('red;x') && !isValidCssColor('url(x)'));
});

test('parsePrice และ computeSalesState (เวลาไทย)', () => {
    assert.equal(parsePrice('2,500฿'), 2500); assert.equal(parsePrice('800 บาท'), 800); assert.equal(parsePrice(null), 0);
    assert.equal(computeSalesState({}).open, true);
    assert.equal(computeSalesState({ sales_status: 'closed' }).code, 'SALES_CLOSED');
    assert.equal(computeSalesState({ sales_status: 'soldout' }).code, 'SOLD_OUT');
    // 18:00 เวลาไทย = 11:00 UTC
    const close = '2026-10-20T18:00';
    assert.equal(computeSalesState({ sales_close_at: close }, Date.parse('2026-10-20T10:59:00Z')).open, true);
    assert.equal(computeSalesState({ sales_close_at: close }, Date.parse('2026-10-20T11:00:01Z')).open, false);
});
