const sanitizeHtml = require('sanitize-html');

// ใช้กับข้อมูลที่ผู้ใช้กรอกทุกจุดก่อนบันทึกลง DB (ชื่อ, เบอร์โทร, ข้อความป้าย ฯลฯ)
// ตัด tag/attribute อันตรายทั้งหมดออก เหลือแค่ plain text
function clean(input) {
    if (typeof input !== 'string') return input;
    return sanitizeHtml(input.trim(), { allowedTags: [], allowedAttributes: {} }).trim().slice(0, 500);
}

// ลิงก์ที่แอดมินกรอก (Facebook, Google Maps, Google Sheet ฯลฯ): อนุญาตเฉพาะ http/https
// ถ้าไม่ใส่ scheme จะเติม https:// ให้ ส่งคืนสตริงว่างถ้าไม่ได้กรอก และคืน null ถ้ารูปแบบไม่ถูกต้อง
// (กัน javascript: / data: ที่ถูกนำไปใส่ใน href)
function cleanUrl(input) {
    if (input === undefined || input === null) return '';
    const raw = String(input).trim();
    if (!raw) return '';
    if (raw.length > 2000) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw;
    try {
        const u = new URL(withScheme);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        return u.href;
    } catch (_) {
        return null;
    }
}

// ค่า CSS ของผังโต๊ะ: ยอมรับเฉพาะตัวเลข+หน่วย px/% และสี hex/rgb/hsl/ชื่อสี กัน CSS injection
const SIZE_RE = /^-?\d{1,5}(\.\d{1,10})?(px|%)$/;
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla)\([\d\s.,%/]{1,40}\)|[a-zA-Z]{3,20})$/;

function isValidCssSize(v) { return typeof v === 'string' && SIZE_RE.test(v.trim()); }
function isValidCssColor(v) { return typeof v === 'string' && COLOR_RE.test(v.trim()); }

module.exports = { clean, cleanUrl, isValidCssSize, isValidCssColor };
