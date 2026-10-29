// ==========================================================
// ticket.js — หน้า "ดูบัตรของฉัน" สำหรับลูกค้า
// กรอกชื่อ + นามสกุล + เบอร์โทร (หรือเปิดจากลิงก์ ?t=<token> ที่แอดมินส่งให้) เพื่อดูสถานะและ QR เข้างาน
// QR เก็บแค่รหัสลับของบัตร (BT1:<token>) ไม่มีข้อมูลส่วนตัว
// ==========================================================
const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'http://localhost:3000' : '';
const $ = (id) => document.getElementById(id);

let lastQuery = null;           // { type: 'lookup', body } | { type: 'token', token } ใช้รีเฟรชสถานะอัตโนมัติ
let lastStatusMap = {};
let lastPayMap = {};
let pollTimer = null;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function parseDbTime(s) {
    if (!s) return null;
    const d = new Date(String(s).replace(' ', 'T') + 'Z');   // เวลาใน DB เป็น UTC (Safari ไม่อ่านรูปแบบมีช่องว่าง)
    return Number.isNaN(d.getTime()) ? null : d;
}
function fmtTime(s) {
    const d = parseDbTime(s);
    return d ? d.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }) : '-';
}
function money(n) { return (Number(n) || 0).toLocaleString('th-TH'); }

function showError(msg) {
    const e = $('err');
    e.textContent = msg || '';
    e.style.display = msg ? 'block' : 'none';
}

function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 4000);
}

// วาด QR ลง canvas (เว้นขอบขาว 4 โมดูลตามมาตรฐานให้สแกนง่าย)
function drawQr(canvas, text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount(), quiet = 4, cell = 8;
    const size = (n + quiet * 2) * cell;
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    }
}

const PAY_LABELS = { transfer: 'โอนเงิน', cash: 'เงินสด', promptpay: 'พร้อมเพย์' };

function fmtDateTime(s) {
    const d = parseDbTime(s);
    return d ? d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'long', timeStyle: 'short' }) : '-';
}

// แตะ QR เล็กเพื่อขยายเต็มจอ (สแกนง่ายขึ้น) แตะอีกครั้งเพื่อปิด
function showQrBig(token) {
    const ov = el('div', 'qr-overlay');
    const box = el('div', 'qr-box');
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    ov.appendChild(box);
    ov.appendChild(el('div', 'qr-note', 'แตะที่ใดก็ได้เพื่อปิด'));
    ov.addEventListener('click', () => ov.remove());
    document.body.appendChild(ov);
    drawQr(canvas, 'BT1:' + token);
}

// QR ขนาดเล็กมุมขวาบนของการ์ด
function renderSmallQr(t) {
    const wrap = el('div', 'tk-qr');
    const qbox = el('div', 'qr-box sm');
    const canvas = document.createElement('canvas');
    qbox.appendChild(canvas);
    qbox.title = 'แตะเพื่อขยาย';
    qbox.addEventListener('click', () => showQrBig(t.ticketToken));
    wrap.appendChild(qbox);
    wrap.appendChild(el('div', 'qr-note sm', 'แสดง QR นี้ให้พนักงานสแกนที่ประตูทางเข้า (แตะเพื่อขยาย)'));
    drawQr(canvas, 'BT1:' + t.ticketToken);
    return wrap;
}

function appendUsedBox(parent, t) {
    const ub = el('div', 'used-box');
    ub.appendChild(el('b', '', '✅ เช็กอินเข้างานแล้ว'));
    ub.appendChild(document.createTextNode(`เมื่อเวลา ${fmtTime(t.checkedInAt)} น.`));
    parent.appendChild(ub);
}

// บิล (อนุมัติแล้ว + จ่ายแล้ว): หน้าตาเหมือนใบเสร็จฝั่งแอดมิน แสดงสถานะ "จ่ายแล้ว" (QR อยู่ที่มุมขวาบนของการ์ด)
function renderBill(t) {
    const rc = t.receipt;
    const paper = el('div', 'bill');
    paper.appendChild(el('div', 'bill-paid', '✅ จ่ายแล้ว'));
    paper.appendChild(el('div', 'bill-shop', rc.shopName));
    if (rc.shopAddress) paper.appendChild(el('div', 'bill-small', rc.shopAddress));
    if (rc.taxId) paper.appendChild(el('div', 'bill-small', `เลขประจำตัวผู้เสียภาษี ${rc.taxId}`));
    paper.appendChild(el('h2', 'bill-title', 'ใบเสร็จรับเงิน'));

    const tbl = el('table', 'bill-table');
    billRows(t).forEach(([k, v, cls]) => {
        const tr = document.createElement('tr');
        if (cls) tr.className = cls;
        tr.appendChild(el('td', '', k));
        const td = document.createElement('td');
        td.appendChild(cls === 'bill-total' || k === 'เลขที่' ? el('b', '', v) : document.createTextNode(v));
        tr.appendChild(td);
        tbl.appendChild(tr);
    });
    paper.appendChild(tbl);
    paper.appendChild(el('div', 'bill-small center', rc.footer));
    return paper;
}

// แถวในบิล (ใช้ทั้งบนหน้าเว็บและตอนวาดรูปที่บันทึก)
function billRows(t) {
    const rc = t.receipt;
    const rows = [];
    if (rc.receiptNo) rows.push(['เลขที่', rc.receiptNo]);
    rows.push(['วันที่', fmtDateTime(rc.issuedAt)]);
    rows.push(['ได้รับเงินจาก', t.name]);
    rows.push(['รหัสการจอง', t.bookingCode]);
    rows.push(['รายการ', `บัตรเข้าชมคอนเสิร์ต โต๊ะ ${(t.tables || []).join(', ')}`]);
    rows.push(['วิธีชำระเงิน', PAY_LABELS[rc.paymentMethod] || rc.paymentMethod || '-']);
    rows.push(['จำนวนเงินรวม', `${money(rc.amount)} บาท`, 'bill-total']);
    return rows;
}

// ---------- บันทึกทั้งการ์ด (ข้อมูล + QR + บิล) เป็นรูปเดียว ----------
function wrapLines(g, text, maxW) {
    const segs = (typeof Intl !== 'undefined' && Intl.Segmenter)
        ? [...new Intl.Segmenter('th', { granularity: 'word' }).segment(String(text))].map(x => x.segment)
        : [...String(text)];
    const lines = [];
    let line = '';
    const push = () => { if (line.trim()) lines.push(line.trim()); line = ''; };
    for (const seg of segs) {
        if (g.measureText(line + seg).width <= maxW) { line += seg; continue; }
        push();
        if (g.measureText(seg).width <= maxW) { line = seg; continue; }
        for (const ch of seg) {                       // คำยาวเกินบรรทัด: ตัดทีละตัวอักษร
            if (g.measureText(line + ch).width > maxW) push();
            line += ch;
        }
    }
    push();
    return lines.length ? lines : [''];
}

function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

async function buildTicketImage(t) {
    try { await Promise.all([document.fonts.load('400 20px Kanit'), document.fonts.load('600 20px Kanit')]); } catch (e) { /* ใช้ฟอนต์สำรอง */ }
    const S = 2, W = 760, M = 20, P = 26;
    const font = (w, px) => `${w} ${px}px Kanit, system-ui, sans-serif`;
    const unpaid = t.paymentStatus !== 'paid';
    const hasQr = !t.checkedIn && !!t.ticketToken;
    const hasBill = !unpaid && !!t.receipt;
    const qrCanvas = document.createElement('canvas');
    if (hasQr) drawQr(qrCanvas, 'BT1:' + t.ticketToken);

    // วาด 2 รอบ: รอบแรกวัดความสูง (ไม่วาด) รอบสองวาดจริง
    function paint(g, draw, H) {
        g.textBaseline = 'top';
        const x0 = M + P, xr = W - M - P, innerW = W - 2 * (M + P);
        const cx = x0 + innerW / 2;
        let dry = false;                       // true = วัดขนาดอย่างเดียว ไม่วาด
        const text = (str, x, y, f, color, align, maxW, lh) => {
            if (!lh) lh = Math.round((parseInt(/(\d+)px/.exec(f)[1], 10) || 18) * 1.4);
            g.font = f; g.fillStyle = color; g.textAlign = align || 'left';
            const lines = maxW ? wrapLines(g, str, maxW) : [String(str)];
            lines.forEach((ln, i) => { if (draw && !dry) g.fillText(ln, x, y + i * lh); });
            return lines.length * lh;
        };
        if (draw) {
            g.fillStyle = '#12161c'; g.fillRect(0, 0, W, H);
            roundRect(g, M, M, W - 2 * M, H - 2 * M, 22); g.fillStyle = '#1e2530'; g.fill();
            g.lineWidth = 1.5; g.strokeStyle = '#334155'; g.stroke();
        }
        let y = M + P;

        // ----- ส่วนหัว: ข้อมูลซ้าย / ป้ายสถานะ + QR ขวา -----
        const sideW = 190, leftW = innerW - sideW - 22;
        let ly = y;
        ly += text(t.name, x0, ly, font(600, 30), '#f1f5f9', 'left', leftW, 40) + 8;
        const kv = (label, value, color, weight) => {
            g.font = font(400, 20);
            const lw = g.measureText(label + '  ').width;
            text(label, x0, ly, font(400, 20), '#94a3b8', 'left');
            ly += text(value, x0 + lw, ly, font(weight || 400, 20), color, 'left', leftW - lw, 30) + 2;
        };
        kv('โต๊ะ', (t.tables || []).join(', '), '#f1c40f', 600);
        kv('รหัสจอง', t.bookingCode, '#f1f5f9');
        kv('ยอดเงิน', `${money(t.totalAmount)} บาท`, '#f1f5f9');
        kv('สถานะการชำระเงิน', unpaid ? 'ยังไม่จ่าย' : 'จ่ายแล้ว', unpaid ? '#fbbf24' : '#4ade80', 600);

        // ป้ายสถานะมุมขวาบน
        const chipText = unpaid ? 'ยังไม่จ่าย' : (t.checkedIn ? 'ใช้แล้ว · จ่ายแล้ว' : 'อนุมัติแล้ว · จ่ายแล้ว');
        g.font = font(600, 18);
        const cw = g.measureText(chipText).width + 28;
        if (draw) {
            roundRect(g, xr - cw, y, cw, 34, 17);
            g.fillStyle = unpaid ? '#d97706' : (t.checkedIn ? '#475569' : '#1f9d55'); g.fill();
            g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(chipText, xr - cw / 2, y + 5);
        }
        let ry = y + 34 + 12;
        if (hasQr) {
            const qs = 168;
            if (draw) {
                roundRect(g, xr - sideW + (sideW - (qs + 12)) / 2, ry, qs + 12, qs + 12, 10);
                g.fillStyle = '#fff'; g.fill();
                g.imageSmoothingEnabled = false;
                g.drawImage(qrCanvas, xr - sideW + (sideW - qs) / 2, ry + 6, qs, qs);
            }
            ry += qs + 12 + 8;
            ry += text('แสดง QR นี้ให้พนักงานสแกนที่ประตูทางเข้า', xr - sideW / 2, ry, font(400, 13), '#94a3b8', 'center', sideW, 18);
        }
        y = Math.max(ly, ry) + 18;

        // ----- บิล -----
        if (hasBill) {
            const rc = t.receipt;
            const top = y, bx = x0, bp = 24;
            // วัดความสูงบิลด้วยการวาดแบบไม่แสดงผลก่อน แล้วค่อยวาดพื้นขาว
            let by = top + bp;
            const labelW = 190;
            const rows = billRows(t);
            let h = bp;
            dry = true;
            h += text(rc.shopName, cx, 0, font(600, 26), '#111', 'center', innerW - 2 * 140, 36) + 4;
            if (rc.shopAddress) h += text(rc.shopAddress, cx, 0, font(400, 15), '#475569', 'center', innerW - 80, 22);
            if (rc.taxId) h += text(`เลขประจำตัวผู้เสียภาษี ${rc.taxId}`, cx, 0, font(400, 15), '#475569', 'center', innerW - 80, 22);
            h += 10 + 34 + 8;                                  // หัวข้อ "ใบเสร็จรับเงิน"
            rows.forEach(([k, v, cls]) => {
                const f = font(cls ? 600 : 400, cls ? 22 : 18);
                const vh = text(v, 0, 0, f, '#111', 'left', innerW - 2 * bp - labelW, cls ? 32 : 28);
                h += vh + 14;
            });
            h += 14 + text(rc.footer, cx, 0, font(400, 15), '#475569', 'center', innerW - 80, 22) + bp;
            dry = false;
            if (draw) {
                roundRect(g, bx, top, innerW, h, 16); g.fillStyle = '#fff'; g.fill();
                // ตราจ่ายแล้ว
                g.save(); g.translate(xr - bp - 56, top + 44); g.rotate(6 * Math.PI / 180);
                g.font = font(600, 20); const sw = g.measureText('จ่ายแล้ว').width + 28;
                roundRect(g, -sw / 2, -18, sw, 36, 8); g.lineWidth = 3; g.strokeStyle = '#15803d'; g.stroke();
                g.fillStyle = '#15803d'; g.textAlign = 'center'; g.fillText('จ่ายแล้ว', 0, -11); g.restore();
            }
            by += text(rc.shopName, cx, by, font(600, 26), '#111', 'center', innerW - 2 * 140, 36) + 4;
            if (rc.shopAddress) by += text(rc.shopAddress, cx, by, font(400, 15), '#475569', 'center', innerW - 80, 22);
            if (rc.taxId) by += text(`เลขประจำตัวผู้เสียภาษี ${rc.taxId}`, cx, by, font(400, 15), '#475569', 'center', innerW - 80, 22);
            by += 10;
            by += text('ใบเสร็จรับเงิน', cx, by, font(600, 24), '#111', 'center', null, 34) + 8;
            rows.forEach(([k, v, cls], i) => {
                text(k, bx + bp, by + (cls ? 4 : 2), font(400, 18), '#475569', 'left');
                const vh = text(v, bx + bp + labelW, by, font(cls ? 600 : (k === 'เลขที่' ? 600 : 400), cls ? 22 : 18), '#111', 'left', innerW - 2 * bp - labelW, cls ? 32 : 28);
                by += vh + 14;
                if (draw && !cls) {
                    g.save(); g.setLineDash([5, 4]); g.lineWidth = 1; g.strokeStyle = '#cbd5e1';
                    g.beginPath(); g.moveTo(bx + bp, by - 7); g.lineTo(bx + innerW - bp, by - 7); g.stroke(); g.restore();
                }
            });
            by += 14;
            text(rc.footer, cx, by, font(400, 15), '#475569', 'center', innerW - 80, 22);
            y = top + h + 18;
        } else if (t.checkedIn) {
            y += text('เช็กอินเข้างานแล้ว', cx, y, font(600, 26), '#4ade80', 'center') + 4;
            y += text(`เมื่อเวลา ${fmtTime(t.checkedInAt)} น.`, cx, y, font(400, 18), '#cbd5e1', 'center') + 10;
        } else if (unpaid) {
            y += text('ยังไม่ได้ชำระเงิน แสดง QR นี้ที่หน้างานและชำระเงินกับพนักงานได้', cx, y, font(400, 16), '#94a3b8', 'center', innerW, 24) + 6;
        }
        return y + P - 8 + M;
    }

    const dummy = document.createElement('canvas').getContext('2d');
    const H = Math.ceil(paint(dummy, false, 0));
    const c = document.createElement('canvas');
    c.width = W * S; c.height = H * S;
    const g = c.getContext('2d');
    g.scale(S, S);
    paint(g, true, H);
    return c;
}

async function saveTicketImage(t, btn) {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳ กำลังสร้างรูป...';
    try {
        const canvas = await buildTicketImage(t);
        const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `ticket-${t.bookingCode}.png`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
        alert('บันทึกรูปไม่สำเร็จ ลองใหม่อีกครั้ง หรือแคปหน้าจอเก็บไว้แทน');
    } finally {
        btn.disabled = false; btn.textContent = old;
    }
}

function renderTickets(list) {
    const box = $('results');
    box.textContent = '';
    list.forEach(t => {
        const card = el('div', 'card');
        const used = t.status === 'approved' && t.checkedIn;
        const unpaid = t.status === 'approved' && t.paymentStatus !== 'paid';
        const showQr = t.status === 'approved' && !t.checkedIn && !!t.ticketToken;

        // ส่วนหัว: ข้อมูลซ้าย / ป้ายสถานะ + QR เล็กขวา
        const top = el('div', 'tk-top');
        const info = el('div', 'tk-info');
        info.appendChild(el('div', 'tk-name', t.name));
        const meta = el('div', 'tk-meta');
        const l1 = el('div'); l1.appendChild(document.createTextNode('🪑 โต๊ะ: ')); l1.appendChild(el('span', 'tk-tables', (t.tables || []).join(', '))); meta.appendChild(l1);
        meta.appendChild(el('div', '', `🎫 รหัสจอง ${t.bookingCode}`));
        meta.appendChild(el('div', '', `💰 ${money(t.totalAmount)} บาท`));
        if (t.status === 'approved') meta.appendChild(el('div', unpaid ? 'pay-line unpaid' : 'pay-line paid', unpaid ? '⏳ สถานะการชำระเงิน: ยังไม่จ่าย' : '✅ สถานะการชำระเงิน: จ่ายแล้ว'));
        info.appendChild(meta);
        top.appendChild(info);

        const side = el('div', 'tk-side');
        const chip = unpaid
            ? el('span', 'chip unpaid', 'ยังไม่จ่าย')
            : el('span', `chip ${used ? 'used' : t.status}`,
                used ? 'ใช้แล้ว · จ่ายแล้ว' : t.status === 'approved' ? 'อนุมัติแล้ว · จ่ายแล้ว' : t.status === 'pending' ? 'รอตรวจสอบสลิป' : 'ไม่ผ่าน/ยกเลิก');
        side.appendChild(chip);
        if (showQr) side.appendChild(renderSmallQr(t));
        top.appendChild(side);
        card.appendChild(top);

        if (t.status === 'approved' && !unpaid && t.receipt) {
            card.appendChild(renderBill(t));            // จ่ายแล้ว: บิลอยู่ใต้ส่วนหัว (QR อยู่มุมขวาบน)
        }
        if (used) appendUsedBox(card, t);
        if (unpaid && showQr) card.appendChild(el('div', 'hint', '💡 ยังไม่ได้ชำระเงิน สามารถแสดง QR นี้ที่หน้างานและชำระเงินกับพนักงานได้'));
        if (t.status === 'pending') card.appendChild(el('div', 'hint', '⏳ ทางร้านกำลังตรวจสอบสลิปของคุณ เมื่ออนุมัติแล้ว QR จะแสดงที่นี่อัตโนมัติ (หน้านี้รีเฟรชให้เองทุก 1 นาที)'));
        if (t.status === 'rejected') card.appendChild(el('div', 'hint', '❌ การจองนี้ไม่ผ่านการตรวจสอบหรือถูกยกเลิก กรุณาติดต่อทางร้าน'));

        if (t.status === 'approved') {
            // บันทึกทั้งการ์ด (ข้อมูล + QR + บิล) เป็นรูปเดียว
            const save = el('button', 'btn ghost', '⬇️ บันทึกรูปบัตร/บิลไว้ในเครื่อง');
            save.type = 'button';
            save.addEventListener('click', () => saveTicketImage(t, save));
            card.appendChild(save);
        }
        box.appendChild(card);
    });
}

async function requestTickets(q) {
    const res = q.type === 'token'
        ? await fetch(`${API_BASE}/api/tickets/${encodeURIComponent(q.token)}`)
        : await fetch(`${API_BASE}/api/tickets/lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q.body) });
    let data = {};
    try { data = await res.json(); } catch (_) { /* ไม่ใช่ JSON */ }
    return { ok: res.ok, status: res.status, data };
}

function schedulePoll(list) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!list.some(t => t.status === 'pending' || (t.status === 'approved' && t.paymentStatus !== 'paid'))) return;   // รีเฟรชอัตโนมัติเฉพาะตอนมีรายการรออนุมัติ/ยังไม่จ่าย (บิลจะขึ้นเองเมื่อชำระแล้ว)
    pollTimer = setTimeout(async () => {
        if (!document.hidden && lastQuery) {
            const r = await requestTickets(lastQuery);
            if (r.ok) {
                const newly = r.data.bookings.find(t => t.status === 'approved' && lastStatusMap[t.bookingCode] === 'pending');
                const nowPaid = r.data.bookings.find(t => t.status === 'approved' && t.paymentStatus === 'paid' && lastPayMap[t.bookingCode] === 'unpaid');
                applyResult(r.data.bookings);
                if (nowPaid) toast('✅ ได้รับการชำระเงินแล้ว ออกบิลเรียบร้อย');
                else if (newly) toast('✅ การจองของคุณได้รับการอนุมัติแล้ว');
                return;
            }
        }
        schedulePoll(list);
    }, 60000);
}

function applyResult(list) {
    lastStatusMap = Object.fromEntries(list.map(t => [t.bookingCode, t.status]));
    lastPayMap = Object.fromEntries(list.map(t => [t.bookingCode, t.paymentStatus]));
    renderTickets(list);
    schedulePoll(list);
}

$('lookup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const btn = $('submit-btn');
    btn.disabled = true; btn.textContent = 'กำลังค้นหา...';
    try {
        const body = { firstName: $('first-name').value.trim(), lastName: $('last-name').value.trim(), phone: $('phone').value.trim() };
        lastQuery = { type: 'lookup', body };
        const r = await requestTickets(lastQuery);
        if (!r.ok) {
            $('results').textContent = '';
            showError(r.data.error || 'ค้นหาไม่สำเร็จ กรุณาลองใหม่');
            return;
        }
        applyResult(r.data.bookings);
    } catch (err) {
        showError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
    } finally {
        btn.disabled = false; btn.textContent = 'ค้นหาบัตรของฉัน';
    }
});

(async function init() {
    try {
        const res = await fetch(`${API_BASE}/api/settings`);
        if (res.ok) {
            const s = await res.json();
            $('event-line').textContent = [s.concert_title, s.concert_date].filter(Boolean).join(' · ');
        }
    } catch (_) { /* ไม่มีข้อมูลงานก็ใช้หน้านี้ได้ */ }

    // เปิดจากลิงก์ที่แอดมินส่งให้ (?t=<token>) ไม่ต้องกรอกข้อมูล
    const token = new URLSearchParams(location.search).get('t');
    if (token) {
        $('lookup-form').style.display = 'none';
        lastQuery = { type: 'token', token };
        try {
            const r = await requestTickets(lastQuery);
            if (r.ok) applyResult(r.data.bookings);
            else { $('lookup-form').style.display = ''; showError(r.data.error || 'ไม่พบบัตร กรุณากรอกข้อมูลเพื่อค้นหา'); }
        } catch (_) {
            $('lookup-form').style.display = '';
            showError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่');
        }
    }
})();
