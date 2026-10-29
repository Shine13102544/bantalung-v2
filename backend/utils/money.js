// ราคาโต๊ะใน layout_items เก็บเป็นข้อความ เช่น '2,500฿' -> 2500 (บาทเต็ม)
function parsePrice(text) {
    if (text === null || text === undefined) return 0;
    const n = Number(String(text).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? Math.round(n) : 0;
}

module.exports = { parsePrice };
