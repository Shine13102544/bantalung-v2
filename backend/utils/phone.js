// เบอร์โทร: เก็บและเทียบแบบตัวเลขล้วน (0812345678) เพื่อให้ "081-234-5678" กับ "+66 81 234 5678" ถือเป็นเบอร์เดียวกัน
function normalizePhone(raw) {
    const s = String(raw || '').trim();
    const hasPlus = s.startsWith('+');
    let d = s.replace(/\D/g, '');
    if (hasPlus && d.startsWith('66') && d.length >= 10) d = '0' + d.slice(2);
    else if (!hasPlus && d.startsWith('66') && d.length === 11) d = '0' + d.slice(2);
    return d;
}

function isValidPhone(digits) {
    return /^\d{9,15}$/.test(digits);
}

// ซ่อนเบอร์สำหรับพนักงานหน้างาน เช่น 0812345678 -> 08x-xxx-5678 (ยังค้นด้วยเลข 4 ตัวท้ายได้)
function maskPhone(raw) {
    const d = String(raw || '').replace(/\D/g, '');
    if (d.length < 6) return raw;
    return `${d.slice(0, 2)}x-xxx-${d.slice(-4)}`;
}

module.exports = { normalizePhone, isValidPhone, maskPhone };
