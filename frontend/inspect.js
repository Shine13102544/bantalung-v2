// ==========================================================
// inspect.js  (โหลดต่อจาก app.js และ admin-tools.js)
// หน้าตรวจบัตรเข้างาน: ผังโต๊ะสถานะจริง, ค้นหา, เช็กอิน, Walk-in, ย้ายโต๊ะ, สแกน QR
// ใช้งานได้ทั้งแอดมินและพนักงานหน้างาน (พนักงานเห็นเบอร์โทรแบบปิดบัง และทำได้เฉพาะงานหน้าประตู)
// ==========================================================

let inspectBookings = [];          // รายการจองล่าสุดจาก /api/bookings/admin
let inspectMode = 'normal';        // 'normal' | 'move'
let inspectMove = null;            // { bookingId, fromCode } ตอนอยู่โหมดย้ายโต๊ะ
let inspectPollTimer = null;
let inspectLastUpdated = null;
let inspectLoadFailed = false;
let inspectSheetBookingId = null;

const INSPECT_COLORS = { checkedin: '#2ecc71', approved: '#e67e22', pending: '#f1c40f', free: '#34495e' };
const ZONE_LABELS = { vip: 'VIP', normal: 'ธรรมดา', general: 'ทั่วไป' };

function isStaffRole() { return getRole() === 'staff'; }

// ---------- เปิด/ปิดหน้า ----------
async function showTicketView() {
    const hub = btEl('admin-hub-section');
    if (hub) hub.style.display = 'none';
    ['.hero-section', '#table-summary-section', '.rules-section', '.booking-section'].forEach(sel => {
        const el = document.querySelector(sel);
        if (el) el.style.display = 'none';
    });
    hideAllAdminPages();
    const sec = btEl('inspect-section');
    if (sec) sec.style.display = 'block';
    rememberAdminPage('inspect');
    applyRoleUI();

    inspectMode = 'normal';
    inspectMove = null;
    await refreshInspectView();
    startInspectPolling();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeInspectPage() {
    stopInspectPolling();
    closeScanOverlay();
    exitMoveMode(true);
    btCloseModal('bt-sheet');
    const sec = btEl('inspect-section');
    if (sec) sec.style.display = 'none';
    showAdminHub();
    renderSalesQuick();
}

// ---------- โหลดข้อมูล ----------
async function fetchInspectData() {
    let ok = true;
    try {
        const [lRes, bRes] = await Promise.all([
            apiFetch('/api/layout'),
            apiFetch('/api/bookings/admin', { headers: { ...authHeaders() } })
        ]);
        if (lRes.ok) layoutData = await lRes.json(); else ok = false;
        if (bRes.ok) inspectBookings = await bRes.json(); else ok = false;
    } catch (err) {
        console.error('โหลดข้อมูลหน้าตรวจบัตรไม่สำเร็จ:', err);
        ok = false;
    }
    inspectLoadFailed = !ok;      // ถ้าล้มเหลวจะคงข้อมูลเดิมไว้ และแสดงแบนเนอร์เตือน
    if (ok) inspectLastUpdated = new Date();
    return ok;
}

async function refreshInspectView() {
    await fetchInspectData();
    renderInspectLayout();
    renderInspectSummary();
    updateInspectBanner();
    if (inspectSheetBookingId !== null && btEl('bt-sheet') && btEl('bt-sheet').style.display !== 'none') {
        const b = bookingById(inspectSheetBookingId);
        if (b && b.status !== 'rejected') renderBookingSheet(b); else btCloseModal('bt-sheet');
    }
    if (inspectMode === 'move' && !bookingById(inspectMove && inspectMove.bookingId)) exitMoveMode(true);
}

function isInspectBusy() {
    return ['bt-walkin', 'bt-move-confirm'].some(id => btEl(id) && btEl(id).style.display !== 'none');
}

// รีเฟรชอัตโนมัติทุก 15 วินาที (หยุดเมื่อซ่อนแท็บหรือกำลังกรอกฟอร์ม) เพื่อให้พนักงานหลายประตูเห็นตรงกัน
function startInspectPolling() {
    stopInspectPolling();
    inspectPollTimer = setInterval(() => {
        if (document.hidden || isInspectBusy()) return;
        refreshInspectView();
    }, 15000);
}
function stopInspectPolling() {
    if (inspectPollTimer) clearInterval(inspectPollTimer);
    inspectPollTimer = null;
}
document.addEventListener('visibilitychange', () => {
    const sec = btEl('inspect-section');
    if (!document.hidden && sec && sec.style.display !== 'none') refreshInspectView();
});

// ---------- ข้อมูลการจอง ----------
function bookingById(id) {
    return inspectBookings.find(b => Number(b.id) === Number(id)) || null;
}

function findActiveBookingForTable(code) {
    return inspectBookings.find(b =>
        (b.status === 'pending' || b.status === 'approved') && Array.isArray(b.tableList) && b.tableList.includes(code)
    ) || null;
}

function tableStatusKey(booking) {
    if (!booking) return 'free';
    if (booking.status === 'pending') return 'pending';
    return Number(booking.checked_in) === 1 ? 'checkedin' : 'approved';
}

const STATUS_TEXT = { checkedin: 'เข้างานแล้ว', approved: 'จองแล้ว', pending: 'รอตรวจสลิป', free: 'ว่าง' };

// ---------- แถบสรุป ----------
function renderInspectSummary() {
    const box = btEl('inspect-summary');
    if (!box || !Array.isArray(layoutData)) return;
    const tables = layoutData.filter(i => i.kind === 'table');
    const total = { checkedin: 0, approved: 0, pending: 0, free: 0 };
    const zones = {};
    tables.forEach(t => {
        const k = tableStatusKey(findActiveBookingForTable(t.table_code));
        total[k]++;
        const z = t.zone_type || 'normal';
        zones[z] = zones[z] || { all: 0, used: 0, in: 0 };
        zones[z].all++;
        if (k !== 'free') zones[z].used++;
        if (k === 'checkedin') zones[z].in++;
    });
    const zoneChips = Object.entries(zones).map(([z, v]) =>
        `<span class="bt-chip">${escapeHtml(ZONE_LABELS[z] || z)}: เข้างาน ${v.in}/${v.used} · ว่าง ${v.all - v.used}</span>`).join('');
    box.innerHTML = `
        <div class="bt-sum-main">
            <div class="bt-sum-box in"><b>${total.checkedin}</b><span>เข้างานแล้ว</span></div>
            <div class="bt-sum-box booked"><b>${total.approved}</b><span>จองแล้ว (รอเข้า)</span></div>
            <div class="bt-sum-box pend"><b>${total.pending}</b><span>รอตรวจสลิป</span></div>
            <div class="bt-sum-box free"><b>${total.free}</b><span>โต๊ะว่าง</span></div>
        </div>
        <div class="bt-sum-zones">${zoneChips}</div>`;
}

function updateInspectBanner() {
    const el = btEl('inspect-banner');
    const upd = btEl('inspect-updated');
    if (upd) upd.textContent = inspectLastUpdated ? `อัปเดตล่าสุด ${inspectLastUpdated.toLocaleTimeString('th-TH')}` : '';
    if (!el) return;

    if (inspectMode === 'move' && inspectMove) {
        const b = bookingById(inspectMove.bookingId);
        const name = b ? `${b.first_name} ${b.last_name}`.trim() : '';
        const tablesText = b ? b.tableList.join(', ') : '';
        const step = inspectMove.fromCode
            ? `ย้ายจากโต๊ะ <b>${escapeHtml(inspectMove.fromCode)}</b> → กดเลือก <b>โต๊ะว่าง</b> ที่จะย้ายไป (โต๊ะที่กดได้กะพริบสีเขียว)`
            : 'กดเลือก <b>โต๊ะของผู้จอง</b> ที่จะย้าย (โต๊ะสีฟ้า)';
        el.className = 'bt-banner move';
        el.innerHTML = `<div>🔀 <b>โหมดย้ายโต๊ะ</b> · ${escapeHtml(name)} (${escapeHtml(tablesText)})<br>${step}</div>
            <button type="button" class="bt-btn small" id="bt-move-cancel">ยกเลิกโหมดย้าย</button>`;
        btEl('bt-move-cancel').addEventListener('click', () => exitMoveMode());
        el.style.display = 'flex';
    } else if (inspectLoadFailed) {
        el.className = 'bt-banner error';
        el.innerHTML = `<div>⚠️ โหลดข้อมูลล่าสุดไม่สำเร็จ (เน็ตหลุด?) ข้อมูลที่เห็นอาจไม่ตรงกับความจริง</div>
            <button type="button" class="bt-btn small" id="bt-retry">🔄 ลองใหม่</button>`;
        btEl('bt-retry').addEventListener('click', () => refreshInspectView());
        el.style.display = 'flex';
    } else {
        el.style.display = 'none';
        el.innerHTML = '';
    }
}

// ---------- วาดผัง ----------
function zoneBgColor(colorStr) {
    if (!colorStr || colorStr === 'transparent') return 'transparent';
    if (colorStr.includes('rgb')) return colorStr;
    let c = colorStr.trim().replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    if (c.length === 6) {
        const r = parseInt(c.substring(0, 2), 16), g = parseInt(c.substring(2, 4), 16), b = parseInt(c.substring(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, 0.18)`;
    }
    return 'transparent';
}

function renderInspectLayout() {
    const canvas = btEl('inspect-seat-canvas');
    if (!canvas || !Array.isArray(layoutData)) return;
    canvas.innerHTML = '';

    const moving = inspectMode === 'move' && inspectMove ? bookingById(inspectMove.bookingId) : null;
    const ownCodes = moving ? moving.tableList : [];

    layoutData.forEach(item => {
        const el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.left = item.pos_left || '0px';
        el.style.top = item.pos_top || '0px';
        if (item.width) el.style.width = item.width;
        if (item.height) el.style.height = item.height;
        el.style.boxSizing = 'border-box';

        if (item.kind === 'stage') {
            el.textContent = item.label || '🎤 เวทีคอนเสิร์ต (STAGE)';
            el.style.backgroundColor = item.color || '#e74c3c';
            el.style.color = '#ffffff'; el.style.fontWeight = 'bold';
            el.style.display = 'flex'; el.style.alignItems = 'center'; el.style.justifyContent = 'center';
            el.style.borderRadius = '8px';
            canvas.appendChild(el);
        } else if (item.kind === 'zone') {
            const zc = item.color || '#3498db';
            el.style.border = `2px dashed ${zc}`;
            el.style.backgroundColor = zoneBgColor(zc);
            el.style.borderRadius = '12px';
            el.style.paddingTop = '6px'; el.style.textAlign = 'center';
            const label = document.createElement('div');
            label.style.cssText = `color:${zc};font-weight:bold;font-size:0.85rem;`;
            label.textContent = item.label || '';
            el.appendChild(label);
            canvas.appendChild(el);
        } else if (item.kind === 'table') {
            const code = item.table_code || '';
            const booking = findActiveBookingForTable(code);
            const layoutBusy = item.booking_status && item.booking_status !== 'available';
            const key = booking ? tableStatusKey(booking) : (layoutBusy ? (item.checked_in ? 'checkedin' : (item.booking_status === 'pending' ? 'pending' : 'approved')) : 'free');
            const isVIP = item.zone_type === 'vip';

            el.style.backgroundColor = key === 'free' ? (item.color || INSPECT_COLORS.free) : INSPECT_COLORS[key];
            el.style.borderRadius = '10px';
            el.style.display = 'flex'; el.style.flexDirection = 'column';
            el.style.alignItems = 'center'; el.style.justifyContent = 'center';
            el.style.cursor = 'pointer'; el.style.zIndex = '10'; el.style.padding = '2px';
            if (key === 'pending') el.style.border = '2px dashed #7d6608';
            el.dataset.inspectTableCode = code;
            el.dataset.status = key;

            const txtColor = key === 'pending' ? '#222' : '#fff';
            const codeEl = document.createElement('div');
            codeEl.style.cssText = `font-weight:bold;color:${txtColor};font-size:${isVIP ? '0.62rem' : '0.8rem'};line-height:1;text-align:center;white-space:nowrap;`;
            codeEl.textContent = code;
            const stEl = document.createElement('div');
            stEl.style.cssText = `font-size:${isVIP ? '0.5rem' : '0.6rem'};color:${txtColor};opacity:0.9;line-height:1;margin-top:2px;text-align:center;white-space:nowrap;`;
            stEl.textContent = STATUS_TEXT[key];
            el.appendChild(codeEl); el.appendChild(stEl);

            // โหมดย้ายโต๊ะ: ไฮไลต์โต๊ะของผู้จอง / โต๊ะว่างที่ย้ายไปได้ / หรี่โต๊ะอื่น
            if (moving) {
                if (ownCodes.includes(code)) {
                    el.classList.add('bt-own');
                    if (inspectMove.fromCode === code) el.classList.add('bt-source');
                } else if (key === 'free') {
                    if (inspectMove.fromCode) el.classList.add('bt-target');
                } else {
                    el.classList.add('bt-dim');
                }
            }

            el.addEventListener('click', () => onInspectTableTap(code, item, booking));
            if (booking && window.matchMedia && window.matchMedia('(hover: hover)').matches) {
                el.addEventListener('mouseenter', (e) => showInspectTip(el, booking));
                el.addEventListener('mouseleave', hideInspectTip);
            }
            canvas.appendChild(el);
        }
    });

    requestAnimationFrame(() => fitCanvasToScreen('inspect-seat-canvas'));
}

// กล่องข้อมูลเมื่อเอาเมาส์ชี้ (เฉพาะอุปกรณ์ที่มีเมาส์) + ไฮไลต์โต๊ะอื่นของผู้จองคนเดียวกัน
function showInspectTip(el, booking) {
    let tip = btEl('bt-inspect-tip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'bt-inspect-tip'; document.body.appendChild(tip); }
    tip.innerHTML = `<b>👤 ${escapeHtml(booking.first_name)} ${escapeHtml(booking.last_name)}</b><br>
        📞 ${escapeHtml(booking.phone)}<br>🪑 ${escapeHtml(booking.tableList.join(', '))}`;
    const r = el.getBoundingClientRect();
    tip.style.display = 'block';
    tip.style.left = `${Math.max(6, Math.min(window.innerWidth - tip.offsetWidth - 6, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${Math.max(6, r.top - tip.offsetHeight - 8)}px`;
    document.querySelectorAll('#inspect-seat-canvas [data-inspect-table-code]').forEach(t => {
        if (booking.tableList.includes(t.dataset.inspectTableCode)) t.classList.add('bt-related');
    });
}
function hideInspectTip() {
    const tip = btEl('bt-inspect-tip');
    if (tip) tip.style.display = 'none';
    document.querySelectorAll('#inspect-seat-canvas .bt-related').forEach(t => t.classList.remove('bt-related'));
}

// ---------- แตะโต๊ะ ----------
function onInspectTableTap(code, item, booking) {
    hideInspectTip();
    if (inspectMode === 'move') return handleMoveTap(code, item, booking);

    if (!booking) {
        if (item.booking_status && item.booking_status !== 'available') {
            btToast('โต๊ะนี้ถูกจองอยู่แต่ยังไม่พบรายละเอียด กำลังรีเฟรช...', 'warn');
            refreshInspectView();
            return;
        }
        return openWalkinModal(item);   // โต๊ะว่าง → ขายหน้างาน
    }
    openBookingSheet(booking.id, code);
}

// ---------- รายละเอียดผู้จอง (bottom sheet) ----------
function openBookingSheet(bookingId, focusCode) {
    const b = bookingById(bookingId);
    if (!b) return;
    inspectSheetBookingId = Number(b.id);
    renderBookingSheet(b, focusCode);
    const m = btEl('bt-sheet');
    m.classList.add('sheet');
    btOpenModal('bt-sheet');
}

function renderBookingSheet(b, focusCode) {
    const staff = isStaffRole();
    const checked = Number(b.checked_in) === 1;
    const key = tableStatusKey(b);
    const name = `${b.first_name} ${b.last_name}`.trim();
    const tableChips = b.tableList.map(c => {
        const d = (b.tableDetails || []).find(t => t.code === c);
        return `<span class="bt-chip ${c === focusCode ? 'on' : ''}">🪑 ${escapeHtml(c)}${d ? ` · ${btMoney(d.price)}฿` : ''}</span>`;
    }).join('');

    const m = btModal('bt-sheet', `
        <button type="button" class="bt-close" id="bt-sheet-x" aria-label="ปิด">&times;</button>
        <div class="bt-sheet-head">
            <div class="bt-sheet-name">👤 ${escapeHtml(name)}</div>
            <span class="bt-status-chip ${key}">${escapeHtml(STATUS_TEXT[key])}</span>
        </div>
        <div class="bt-sheet-grid">
            <div>📞 ${escapeHtml(b.phone)}</div>
            <div>🎫 ${escapeHtml(b.booking_code)}</div>
            <div>💰 ${btMoney(b.total_amount)} บาท ${b.status === 'approved' ? (b.payment_status === 'paid' ? `· ✅ จ่ายแล้ว (${escapeHtml(btPaymentLabel(b.payment_method))})` : '· ⏳ <b>ยังไม่จ่าย</b>') : `(${escapeHtml(btPaymentLabel(b.payment_method))})`}</div>
            <div>${checked ? `🕒 เข้างานเมื่อ ${escapeHtml(btFmtTime(b.checked_in_at))}` : '🕒 ยังไม่เข้างาน'}</div>
        </div>
        <div class="bt-sheet-tables">${tableChips}</div>
        <div class="bt-sheet-actions" id="bt-sheet-actions"></div>`);
    m.classList.add('sheet');
    btEl('bt-sheet-x').addEventListener('click', () => btCloseModal('bt-sheet'));

    const actions = btEl('bt-sheet-actions');
    const add = (label, cls, fn) => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = `bt-btn ${cls} full`; btn.textContent = label;
        btn.addEventListener('click', async () => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } });
        actions.appendChild(btn);
    };
    const note = (text) => { const p = document.createElement('p'); p.className = 'bt-hint'; p.textContent = text; actions.appendChild(p); };
    const n = b.tableList.length;

    if (b.status === 'approved' && b.payment_status !== 'paid') add('💰 รับชำระเงิน (ออกบิล)', 'amber big', () => doSettle(b));
    if (b.status === 'approved' && !checked) add(`✅ เช็กอินเข้างาน (ทั้ง ${n} โต๊ะ)`, 'green big', () => doCheckin(b, true));
    if (b.status === 'approved' && checked) add('↩️ ยกเลิกการเช็กอิน', 'amber', () => doCheckin(b, false));

    if (b.status === 'pending') {
        if (!staff) {
            add('✅ อนุมัติ + เช็กอินเลย', 'green big', () => doApprove(b, true));
            add('✅ อนุมัติ (ยังไม่เช็กอิน)', 'green', () => doApprove(b, false));
            add('❌ ปฏิเสธ', 'red', () => doReject(b));
            if (b.slipUrl) add('🔍 ดูสลิป', '', async () => viewSlip(b.slipUrl));
        } else {
            note('⏳ รายการนี้ยังรอแอดมินตรวจสลิป เช็กอินยังไม่ได้ กรุณาแจ้งแอดมิน');
        }
    }
    if (b.status === 'pending' || b.status === 'approved') add('🔀 ย้ายโต๊ะ', 'blue', async () => startMove(b.id));
    if (!staff && b.status === 'approved') add('🧾 ใบเสร็จ', '', async () => { btCloseModal('bt-sheet'); await openReceiptForBooking(b.id); });
    if (b.isWalkin) add('🗑️ ยกเลิก Walk-in (ปล่อยโต๊ะ)', 'red', () => doCancelWalkin(b));
}

async function afterInspectAction(msg) {
    if (msg) btToast(msg, 'ok');
    btCloseModal('bt-sheet');
    await refreshInspectView();
    if (typeof renderBookingTable === 'function' && btEl('admin-booking-page') && btEl('admin-booking-page').style.display !== 'none') renderBookingTable();
}

async function doCheckin(b, value) {
    if (!value && !confirm(`ยกเลิกการเช็กอินของ ${b.first_name} ${b.last_name} ใช่หรือไม่?`)) return;
    const r = await btJson(`/api/bookings/admin/${Number(b.id)}/checkin`, { method: 'PATCH', body: { checked_in: value } });
    if (!r.ok) return alert('❌ ' + (r.data.error || 'อัปเดตสถานะเช็กอินไม่สำเร็จ'));
    await afterInspectAction(value ? `✅ เช็กอิน ${b.first_name} เรียบร้อย (${b.tableList.join(', ')})` : '↩️ ยกเลิกการเช็กอินแล้ว');
}

// อนุมัติ: ขึ้นหน้าต่างเลือก จ่ายแล้ว (ออกบิลทันที) / ยังไม่จ่าย (ไม่ออกบิล) แล้วค่อยยิง API (toast แจ้งผลอยู่ใน btApproveFlow)
async function doApprove(b, withCheckIn) {
    if (!(await btApproveFlow(b, withCheckIn))) return;
    await afterInspectAction();
}

// รับชำระรายการที่อนุมัติแล้วแต่ยังไม่จ่าย (เลือกวิธีชำระ → ออกบิล) ใช้ได้ทั้งแอดมินและพนักงาน
async function doSettle(b) {
    if (!(await btSettlePayment(b))) return;
    await afterInspectAction();
}

async function doReject(b) {
    if (!confirm(`ปฏิเสธการจองของ ${b.first_name} ${b.last_name} ใช่หรือไม่? โต๊ะจะกลับเป็นว่าง`)) return;
    const r = await btJson(`/api/bookings/admin/${Number(b.id)}/status`, { method: 'PATCH', body: { status: 'rejected' } });
    if (!r.ok) return alert('❌ ' + (r.data.error || 'ปฏิเสธไม่สำเร็จ'));
    await afterInspectAction('ปฏิเสธรายการแล้ว');
}

async function doCancelWalkin(b) {
    if (!confirm(`ยกเลิกรายการ Walk-in โต๊ะ ${b.tableList.join(', ')} ใช่หรือไม่? โต๊ะจะกลับเป็นว่าง`)) return;
    const r = await btJson(`/api/bookings/admin/${Number(b.id)}/cancel-walkin`, { method: 'POST' });
    if (!r.ok) return alert('❌ ' + (r.data.error || 'ยกเลิกไม่สำเร็จ'));
    await afterInspectAction('🗑️ ยกเลิก Walk-in แล้ว โต๊ะกลับเป็นว่าง');
}

// ---------- Walk-in (ฟอร์มเดียว แทน prompt สองครั้ง) ----------
function openWalkinModal(item) {
    const code = item.table_code;
    btModal('bt-walkin', `
        <button type="button" class="bt-close" id="bt-walkin-x" aria-label="ปิด">&times;</button>
        <h3>🛒 ขายบัตรหน้างาน · โต๊ะ ${escapeHtml(code)}</h3>
        <p class="bt-hint">ราคา <b>${escapeHtml(item.price || '-')}</b> · บันทึกแล้วจะเช็กอินเข้างานทันที</p>
        <label class="bt-field">ชื่อลูกค้า (ไม่บังคับ)<input type="text" id="bt-wi-name" maxlength="100" autocomplete="off"></label>
        <label class="bt-field">เบอร์โทร (ไม่บังคับ)<input type="tel" id="bt-wi-phone" maxlength="20" autocomplete="off"></label>
        <div class="bt-field">วิธีชำระเงิน
            <div class="bt-seg" id="bt-wi-method">
                <label><input type="radio" name="bt-wi-m" value="cash" checked><span>💵 เงินสด</span></label>
                <label><input type="radio" name="bt-wi-m" value="transfer"><span>🏦 โอน</span></label>
                <label><input type="radio" name="bt-wi-m" value="promptpay"><span>📱 พร้อมเพย์</span></label>
            </div>
        </div>
        <button type="button" class="bt-btn green big full" id="bt-wi-go">✅ บันทึก Walk-in + เช็กอิน</button>
        <button type="button" class="bt-btn full" id="bt-wi-cancel">ยกเลิก</button>`);
    btEl('bt-walkin-x').addEventListener('click', () => btCloseModal('bt-walkin'));
    btEl('bt-wi-cancel').addEventListener('click', () => btCloseModal('bt-walkin'));
    btEl('bt-wi-go').addEventListener('click', async () => {
        const btn = btEl('bt-wi-go'); btn.disabled = true;
        const method = (document.querySelector('input[name="bt-wi-m"]:checked') || {}).value || 'cash';
        const r = await btJson('/api/bookings/admin/walkin', { method: 'POST', body: {
            tableCode: code, firstName: btEl('bt-wi-name').value.trim(), phone: btEl('bt-wi-phone').value.trim(), paymentMethod: method
        } });
        btn.disabled = false;
        if (!r.ok) {
            btToast('❌ ' + (r.data.error || 'บันทึกไม่สำเร็จ'), 'error', 4500);
            if (r.status === 409) { btCloseModal('bt-walkin'); refreshInspectView(); }   // โต๊ะถูกจองไปแล้ว → รีเฟรชผังทันที
            return;
        }
        btCloseModal('bt-walkin');
        btToast(`✅ เปิดโต๊ะ ${code} และเช็กอินแล้ว · ${btMoney(r.data.totalAmount)} บาท · ${r.data.bookingCode}`, 'ok', 5000);
        await refreshInspectView();
    });
    btOpenModal('bt-walkin');
    setTimeout(() => btEl('bt-wi-name').focus(), 60);
}

// ---------- ย้ายโต๊ะ ----------
function startMove(bookingId) {
    const b = bookingById(bookingId);
    if (!b) return;
    btCloseModal('bt-sheet');
    inspectMode = 'move';
    inspectMove = { bookingId: Number(b.id), fromCode: b.tableList.length === 1 ? b.tableList[0] : null };
    updateInspectBanner();
    renderInspectLayout();
    const sec = btEl('inspect-banner');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function exitMoveMode(silent) {
    inspectMode = 'normal';
    inspectMove = null;
    if (!silent) { updateInspectBanner(); renderInspectLayout(); }
}

function handleMoveTap(code, item, booking) {
    const b = bookingById(inspectMove.bookingId);
    if (!b) return exitMoveMode();

    if (b.tableList.includes(code)) {                // เลือก/สลับโต๊ะต้นทาง
        inspectMove.fromCode = code;
        updateInspectBanner();
        renderInspectLayout();
        return;
    }
    if (!inspectMove.fromCode) {
        return btToast('กรุณากดเลือกโต๊ะของผู้จองรายนี้ก่อน (โต๊ะสีฟ้า)', 'warn');
    }
    if (booking || (item.booking_status && item.booking_status !== 'available')) {
        return btToast('โต๊ะนี้ไม่ว่าง เลือกย้ายได้เฉพาะโต๊ะว่างเท่านั้น', 'warn');
    }
    openMoveConfirm(b, inspectMove.fromCode, item);
}

function openMoveConfirm(b, fromCode, toItem) {
    const detail = (b.tableDetails || []).find(t => t.code === fromCode);
    const paid = detail ? Number(detail.price) : 0;
    const newPrice = parsePrice(toItem.price);
    const diff = newPrice - paid;
    const name = `${b.first_name} ${b.last_name}`.trim();
    const diffText = diff === 0 ? 'ราคาเท่าเดิม'
        : diff > 0 ? `ราคาโต๊ะใหม่สูงกว่า <b style="color:#e67e22">+${btMoney(diff)} บาท</b> (ต้องเก็บเพิ่ม)`
            : `ราคาโต๊ะใหม่ต่ำกว่า <b style="color:#3498db">${btMoney(diff)} บาท</b> (ต้องคืนเงิน)`;

    btModal('bt-move-confirm', `
        <button type="button" class="bt-close" id="bt-mv-x" aria-label="ปิด">&times;</button>
        <h3>🔀 ยืนยันการย้ายโต๊ะ</h3>
        <div class="bt-move-box">
            <div>👤 <b>${escapeHtml(name)}</b></div>
            <div class="bt-move-arrow"><span class="bt-chip on">${escapeHtml(fromCode)}</span> ➜ <span class="bt-chip green">${escapeHtml(toItem.table_code)}</span></div>
            <div class="bt-hint">รหัสโต๊ะไม่เปลี่ยน แต่ชื่อ สถานะ และบัตรของผู้จองจะย้ายไปอยู่โต๊ะใหม่ โต๊ะเดิมกลับเป็นว่าง</div>
        </div>
        <div class="bt-move-price">
            ราคาที่ชำระไว้ของโต๊ะนี้ <b>${btMoney(paid)}฿</b> → ราคาโต๊ะใหม่ <b>${btMoney(newPrice)}฿</b><br>${diffText}
        </div>
        <label class="bt-check"><input type="checkbox" id="bt-mv-adjust" ${diff !== 0 ? 'checked' : ''}> ปรับยอดรวมของการจองตามราคาโต๊ะใหม่ (ถ้าไม่ติ๊ก = คงยอดเดิม)</label>
        <button type="button" class="bt-btn blue big full" id="bt-mv-go">✅ ยืนยันย้ายโต๊ะ</button>
        <button type="button" class="bt-btn full" id="bt-mv-cancel">ยกเลิก</button>`);
    btEl('bt-mv-x').addEventListener('click', () => btCloseModal('bt-move-confirm'));
    btEl('bt-mv-cancel').addEventListener('click', () => btCloseModal('bt-move-confirm'));
    btEl('bt-mv-go').addEventListener('click', async () => {
        const btn = btEl('bt-mv-go'); btn.disabled = true;
        const r = await btJson(`/api/bookings/admin/${Number(b.id)}/move`, {
            method: 'POST', body: { fromCode, toCode: toItem.table_code, adjustPrice: btEl('bt-mv-adjust').checked }
        });
        btn.disabled = false;
        if (!r.ok) {
            btToast('❌ ' + (r.data.error || 'ย้ายโต๊ะไม่สำเร็จ'), 'error', 4500);
            if (r.status === 409) { btCloseModal('bt-move-confirm'); await refreshInspectView(); }
            return;
        }
        btCloseModal('bt-move-confirm');
        exitMoveMode(true);
        await refreshInspectView();
        btToast(`✅ ย้ายโต๊ะ ${fromCode} → ${toItem.table_code} เรียบร้อย`, 'ok', 4500);
        if (r.data.hasReceipt && r.data.adjusted && r.data.priceDiff !== 0) {
            alert('⚠️ การจองนี้เคยออกใบเสร็จไว้แล้ว และยอดเงินเปลี่ยนไป\nหากต้องใช้ใบเสร็จตามยอดใหม่ ให้ยกเลิก (void) ใบเดิมแล้วออกใหม่ที่หน้า "รายการจอง"');
        }
    });
    btOpenModal('bt-move-confirm');
}

// ---------- ค้นหา ----------
function inspectMatches(q) {
    const text = q.trim().toLowerCase();
    if (!text) return [];
    const digits = text.replace(/\D/g, '');
    return inspectBookings.filter(b => {
        if (b.status !== 'pending' && b.status !== 'approved') return false;
        const name = `${b.first_name} ${b.last_name}`.toLowerCase();
        const phoneDigits = String(b.phone || '').replace(/\D/g, '');
        return b.tableList.some(c => c.toLowerCase() === text || c.toLowerCase().includes(text)) ||
            name.includes(text) ||
            String(b.booking_code || '').toLowerCase().includes(text) ||
            (digits.length >= 3 && phoneDigits.includes(digits));
    }).slice(0, 25);
}

function renderInspectSearchResults(list, q) {
    const box = btEl('inspect-search-results');
    if (!box) return;
    if (!q.trim()) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'block';
    box.innerHTML = '';
    if (list.length === 0) {
        const p = document.createElement('div');
        p.className = 'bt-result-empty'; p.textContent = '❌ ไม่พบข้อมูลการจองตามที่ค้นหา';
        box.appendChild(p);
        return;
    }
    list.forEach(b => {
        const key = tableStatusKey(b);
        const row = document.createElement('button');
        row.type = 'button'; row.className = 'bt-result-row';
        row.innerHTML = `<span class="bt-result-main"><b>${escapeHtml(b.first_name)} ${escapeHtml(b.last_name)}</b>
            <small>🪑 ${escapeHtml(b.tableList.join(', '))} · ${escapeHtml(b.booking_code)} · ${escapeHtml(b.phone)}</small></span>
            <span class="bt-status-chip ${key}">${escapeHtml(STATUS_TEXT[key])}</span>`;
        row.addEventListener('click', () => { openBookingSheet(b.id, b.tableList[0]); });
        box.appendChild(row);
    });
}

function inspectSearch() {
    const input = btEl('inspect-search-input');
    const q = input ? input.value : '';
    if (!q.trim()) return btToast('กรุณากรอกคำค้นหา (โต๊ะ ชื่อ เบอร์ หรือรหัสจอง)', 'warn');
    const list = inspectMatches(q);
    renderInspectSearchResults(list, q);
    if (list.length === 1) openBookingSheet(list[0].id, list[0].tableList[0]);   // เจอรายเดียวเปิดให้เลย
}

function inspectSearchClear() {
    const input = btEl('inspect-search-input');
    if (input) input.value = '';
    renderInspectSearchResults([], '');
}

document.addEventListener('DOMContentLoaded', () => {
    const input = btEl('inspect-search-input');
    if (!input) return;
    let t = null;
    input.addEventListener('input', () => {            // แสดงผลลัพธ์ระหว่างพิมพ์ (ไม่เปิดรายละเอียดเอง)
        clearTimeout(t);
        t = setTimeout(() => renderInspectSearchResults(inspectMatches(input.value), input.value), 150);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inspectSearch(); } });
});

// ==========================================================
// สแกน QR บัตรด้วยกล้องโทรศัพท์ (ใช้ jsQR ในโฟลเดอร์ vendor ไม่พึ่ง CDN)
// ต้องเปิดผ่าน HTTPS (หรือ localhost) เบราว์เซอร์ถึงจะยอมให้ใช้กล้อง
// ==========================================================
let scanStream = null;
let scanTimer = null;
let scanFacing = 'environment';
let scanPausedUntil = 0;
let scanLast = { text: '', at: 0 };
let scanAudio = null;

function beep(ok) {
    try {
        scanAudio = scanAudio || new (window.AudioContext || window.webkitAudioContext)();
        const o = scanAudio.createOscillator(), g = scanAudio.createGain();
        o.frequency.value = ok ? 880 : 220; o.type = 'sine';
        g.gain.value = 0.08;
        o.connect(g); g.connect(scanAudio.destination);
        o.start(); o.stop(scanAudio.currentTime + (ok ? 0.12 : 0.35));
    } catch (_) { /* ไม่มีเสียงก็ไม่เป็นไร */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [120, 60, 120]);
}

function openScanOverlay() {
    btModal('bt-scan-overlay', `
        <div class="bt-scan">
            <video id="bt-scan-video" playsinline muted></video>
            <canvas id="bt-scan-canvas" style="display:none"></canvas>
            <div class="bt-scan-frame"></div>
            <div class="bt-scan-top">
                <span id="bt-scan-status">กำลังเปิดกล้อง...</span>
                <button type="button" class="bt-btn small" id="bt-scan-switch">🔄 สลับกล้อง</button>
                <button type="button" class="bt-btn small red" id="bt-scan-close">✖ ปิด</button>
            </div>
            <div class="bt-scan-result" id="bt-scan-result" style="display:none"></div>
            <div class="bt-scan-bottom">
                <button type="button" class="bt-btn" id="bt-scan-manual">🔍 ค้นหาด้วยมือ (ชื่อ/เบอร์/รหัสจอง)</button>
            </div>
        </div>`);
    const m = btEl('bt-scan-overlay');
    m.classList.add('scan');
    btEl('bt-scan-close').addEventListener('click', closeScanOverlay);
    btEl('bt-scan-switch').addEventListener('click', () => { scanFacing = scanFacing === 'environment' ? 'user' : 'environment'; startScanCamera(); });
    btEl('bt-scan-manual').addEventListener('click', () => { closeScanOverlay(); const i = btEl('inspect-search-input'); if (i) i.focus(); });
    btOpenModal('bt-scan-overlay');
    startScanCamera();
}

function setScanStatus(text) { const el = btEl('bt-scan-status'); if (el) el.textContent = text; }

async function startScanCamera() {
    stopScanCamera();
    const video = btEl('bt-scan-video');
    if (!video) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return setScanStatus('เบราว์เซอร์นี้ใช้กล้องไม่ได้ (ต้องเปิดผ่าน HTTPS)');
    }
    if (typeof jsQR !== 'function') return setScanStatus('โหลดตัวอ่าน QR ไม่สำเร็จ กรุณารีเฟรชหน้า');
    try {
        scanStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: scanFacing }, width: { ideal: 1280 } }, audio: false
        });
        video.srcObject = scanStream;
        await video.play();
        setScanStatus('ส่องกล้องไปที่ QR บนบัตรของลูกค้า');
        scanTimer = setInterval(scanFrame, 140);
    } catch (err) {
        console.warn('เปิดกล้องไม่สำเร็จ:', err);
        setScanStatus(err && err.name === 'NotAllowedError'
            ? 'ไม่ได้อนุญาตให้ใช้กล้อง กรุณาเปิดสิทธิ์กล้องให้เว็บนี้ในตั้งค่าเบราว์เซอร์'
            : 'เปิดกล้องไม่สำเร็จ: ' + (err && err.message ? err.message : err));
    }
}

function stopScanCamera() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    if (scanStream) scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
}

function closeScanOverlay() {
    stopScanCamera();
    btCloseModal('bt-scan-overlay');
}

function scanFrame() {
    const video = btEl('bt-scan-video'), canvas = btEl('bt-scan-canvas');
    if (!video || !canvas || video.readyState < 2 || Date.now() < scanPausedUntil) return;
    const scale = Math.min(1, 640 / (video.videoWidth || 640));
    const w = Math.max(1, Math.round(video.videoWidth * scale)), h = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    if (code && code.data) onScanDecoded(code.data.trim());
}

async function onScanDecoded(text) {
    const now = Date.now();
    if (text === scanLast.text && now - scanLast.at < 3000) return;   // QR ใบเดิมที่ยังค้างหน้ากล้อง ไม่ยิงซ้ำ
    scanLast = { text, at: now };
    scanPausedUntil = now + 1200;
    setScanStatus('⏳ กำลังตรวจบัตร...');

    let r;
    try {
        r = await btJson('/api/bookings/staff/scan', { method: 'POST', body: { token: text } });
    } catch (err) {
        return showScanResult({ result: 'ERROR', message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองใหม่อีกครั้ง' });
    }
    if (!r.ok) return showScanResult({ result: 'ERROR', message: r.data.error || 'ตรวจบัตรไม่สำเร็จ' });
    showScanResult(r.data);
    if (r.data.result === 'OK') refreshInspectView();

    // บัตรที่อนุมัติแล้วแต่ยังไม่จ่าย (เช็กอินให้แล้วหรือใช้แล้ว): ขึ้นหน้าต่างถาม จ่ายแล้ว (ออกบิลเลย) / ยังไม่จ่าย
    if ((r.data.result === 'OK' || r.data.result === 'ALREADY') && r.data.paymentStatus === 'unpaid' && r.data.bookingId) {
        scanPausedUntil = Date.now() + 3600 * 1000;          // หยุดสแกนระหว่างตอบคำถาม กันยิงซ้ำ
        const d = r.data;
        const paid = await btSettlePayment({
            id: d.bookingId, first_name: d.name, last_name: '', booking_code: d.bookingCode, tableList: d.tables || [], total_amount: d.totalAmount
        });
        scanPausedUntil = 0;
        scanLast = { text: '', at: 0 };
        if (paid) {
            const sub = btEl('bt-scan-result') && btEl('bt-scan-result').querySelector('.bt-scan-sub');
            if (sub) sub.textContent += ' · ✅ จ่ายแล้ว';
            refreshInspectView();
        }
    }
}

function showScanResult(d) {
    const box = btEl('bt-scan-result');
    if (!box) return;
    const tables = (d.tables || []).join(', ');
    const M = {
        OK: { cls: 'ok', title: '✅ เข้าได้', sub: `โต๊ะ ${tables}` },
        ALREADY: { cls: 'warn', title: '⚠️ บัตรนี้ใช้แล้ว', sub: `เช็กอินไปแล้วเมื่อ ${btFmtTime(d.checkedInAt)} · โต๊ะ ${tables}` },
        NOT_APPROVED: { cls: 'bad', title: '⏳ ยังไม่อนุมัติ', sub: 'การจองนี้ยังรอตรวจสลิป กรุณาติดต่อแอดมิน' },
        REJECTED: { cls: 'bad', title: '❌ การจองถูกยกเลิก', sub: 'บัตรนี้ใช้เข้างานไม่ได้' },
        NOT_FOUND: { cls: 'bad', title: '❌ ไม่พบบัตร', sub: 'QR ไม่ถูกต้อง หรือไม่ใช่บัตรของงานนี้' },
        ERROR: { cls: 'bad', title: '⚠️ เกิดข้อผิดพลาด', sub: d.message || '' }
    }[d.result] || { cls: 'bad', title: '⚠️ ผลลัพธ์ไม่ทราบ', sub: '' };

    beep(d.result === 'OK');
    box.className = `bt-scan-result ${M.cls}`;
    box.innerHTML = `<div class="bt-scan-title">${escapeHtml(M.title)}</div>
        ${d.name ? `<div class="bt-scan-name">👤 ${escapeHtml(d.name)}</div>` : ''}
        <div class="bt-scan-sub">${escapeHtml(M.sub)}</div>
        ${d.bookingCode ? `<div class="bt-scan-sub small">${escapeHtml(d.bookingCode)}</div>` : ''}
        <div class="bt-scan-btns"></div>`;
    box.style.display = 'block';
    const btns = box.querySelector('.bt-scan-btns');
    if (d.result === 'OK' && d.bookingId) {
        const undo = document.createElement('button');
        undo.type = 'button'; undo.className = 'bt-btn small'; undo.textContent = '↩️ ยกเลิกเช็กอิน (สแกนผิดคน)';
        undo.addEventListener('click', async () => {
            const u = await btJson(`/api/bookings/admin/${Number(d.bookingId)}/checkin`, { method: 'PATCH', body: { checked_in: false } });
            btToast(u.ok ? '↩️ ยกเลิกการเช็กอินแล้ว' : '❌ ' + (u.data.error || 'ไม่สำเร็จ'), u.ok ? 'ok' : 'error');
            box.style.display = 'none';
            scanLast = { text: '', at: 0 };
            refreshInspectView();
        });
        btns.appendChild(undo);
    }
    const next = document.createElement('button');
    next.type = 'button'; next.className = 'bt-btn small primary'; next.textContent = 'สแกนใบถัดไป';
    next.addEventListener('click', () => { box.style.display = 'none'; scanPausedUntil = 0; scanLast = { text: '', at: 0 }; setScanStatus('ส่องกล้องไปที่ QR บนบัตรของลูกค้า'); });
    btns.appendChild(next);
    setScanStatus(M.title);
}
