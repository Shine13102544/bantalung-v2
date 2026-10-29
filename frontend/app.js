// ==========================================================
// ตั้งค่าที่อยู่ backend API
// ถ้ารัน frontend คนละ origin กับ backend ให้แก้ค่านี้ เช่น 'http://localhost:3000'
// ถ้าเสิร์ฟจากเซิร์ฟเวอร์เดียวกัน (proxy/same domain) ปล่อยเป็นค่าว่างได้เลย
// ==========================================================
// เปลี่ยนจากเดิม: const API_URL = 'http://localhost:3000/api';
// เป็นการเช็คสภาพแวดล้อมอัตโนมัติ:
// กำหนด URL ของ API ให้ถูกต้อง
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : '';
const TOKEN_KEY = 'bantalung_admin_token';
const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const ROLE_KEY = 'bantalung_admin_role';
const ADMIN_PAGE_KEY = 'bantalung_admin_page';
const getRole = () => localStorage.getItem(ROLE_KEY) || 'admin';
const clearToken = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROLE_KEY);
    sessionStorage.removeItem(ADMIN_PAGE_KEY);
};
// จำหน้าแอดมินที่เปิดอยู่ เพื่อให้รีเฟรชแล้วอยู่หน้าเดิม (เก็บใน sessionStorage = อยู่จนกว่าจะปิดแท็บหรือออกจากระบบ)
function rememberAdminPage(key) {
    if (getToken()) sessionStorage.setItem(ADMIN_PAGE_KEY, key);
}

function authHeaders() {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

// wrapper กลาง: ถ้า token หมดอายุ (401) จะเด้งกลับไปหน้าแรกอัตโนมัติ
// ใช้กับทุก endpoint ที่ต้อง login (ไม่ใช่เฉพาะ path ที่มีคำว่า /admin) ยกเว้นหน้า login เอง
// (การกรอกรหัสผ่านยืนยันผิด server ตอบ 403 จึงไม่ถูกตีความว่าเซสชันหมดอายุ)
let _sessionExpiredShown = false;
async function apiFetch(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, options);
    if (res.status === 401 && getToken() && !path.startsWith('/api/auth/login')) {
        if (!_sessionExpiredShown) {
            _sessionExpiredShown = true;
            alert('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
            closeAdmin();
            setTimeout(() => { _sessionExpiredShown = false; }, 1500);
        }
    }
    return res;
}

let layoutData = [];
let selectedTables = [];
let activeAdminItem = null;
let lastTableWidth = '85px';
let lastTableHeight = '55px';

// ------------------ Escape ข้อความก่อนใส่ผ่าน innerHTML (กัน XSS ฝั่ง client เสริมจาก server) ------------------
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// 🟢 สร้าง Payload สำหรับ QR พร้อมเพย์ (มาตรฐาน EMV QR Code ของ ธปท./สมาคมธนาคารไทย)
// รองรับ: เบอร์โทร 10 หลัก (ขึ้นต้น 0) หรือเลขบัตรประชาชน/เลขผู้เสียภาษี 13 หลัก
function generatePromptPayPayload(id, amount) {
    const digits = String(id || '').replace(/[^0-9]/g, '');

    let subTag, targetId;
    if (digits.length === 10 && digits.startsWith('0')) {
        subTag = '01'; // เบอร์โทรศัพท์
        targetId = '0066' + digits.substring(1); // แปลงเป็นรูปแบบสากล 13 หลัก
    } else if (digits.length === 13) {
        subTag = '02'; // เลขบัตรประชาชน / เลขผู้เสียภาษี
        targetId = digits;
    } else {
        throw new Error('เลขพร้อมเพย์ต้องเป็นเบอร์โทร 10 หลัก หรือเลขบัตรประชาชน 13 หลักเท่านั้น');
    }

    const tlv = (tag, value) => `${tag}${String(value.length).padStart(2, '0')}${value}`;

    const merchantAccountInfo = tlv('29',
        tlv('00', 'A000000677010111') + // Application ID ของพร้อมเพย์
        tlv(subTag, targetId)
    );

    const amountStr = amount ? Number(amount).toFixed(2) : '';

    let payload =
        tlv('00', '01') +                              // Payload Format Indicator
        tlv('01', amountStr ? '12' : '11') +            // 12 = ระบุยอดเงินคงที่, 11 = ไม่ระบุยอด
        merchantAccountInfo +
        tlv('53', '764') +                              // รหัสสกุลเงิน THB
        (amountStr ? tlv('54', amountStr) : '') +       // จำนวนเงิน
        tlv('58', 'TH');                                // รหัสประเทศ

    payload += '6304'; // แท็ก CRC + ความยาว (checksum ต่อท้าย 4 หลัก)
    return payload + crc16(payload);
}

// คำนวณ CRC16/CCITT-FALSE ตามสเปกของ EMV QR Code
function crc16(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
        crc ^= str.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

// 🟢 สร้าง/วาด QR พร้อมเพย์ลงในกล่อง #bank-qr-container ตามยอดเงินจริงของออเดอร์นี้
function renderPromptPayQR(promptpayId, amount) {
    const container = document.getElementById('bank-qr-container');
    if (!container) return;

    if (!promptpayId) {
        container.innerHTML = '<p style="color:#dc2626; font-size:0.75rem; margin:0;">ร้านยังไม่ได้ตั้งค่าเลขพร้อมเพย์</p>';
        return;
    }
    if (typeof QRCode === 'undefined') {
        container.innerHTML = '<p style="color:#dc2626; font-size:0.75rem; margin:0;">โหลดไลบรารีสร้าง QR ไม่สำเร็จ</p>';
        return;
    }

    let payload;
    try {
        payload = generatePromptPayPayload(promptpayId, amount);
    } catch (err) {
        container.innerHTML = `<p style="color:#dc2626; font-size:0.75rem; margin:0;">${escapeHtml(err.message)}</p>`;
        return;
    }

    container.innerHTML = ''; // ล้าง QR เดิมก่อนสร้างใหม่ทุกครั้ง (ยอดเงินเปลี่ยนตามโต๊ะที่เลือก)
    new QRCode(container, {
        text: payload,
        width: 160,
        height: 160,
        colorDark: '#000000',
        colorLight: '#ffffff'
    });
}

function getFaintBgColor(hexColor) {
    let hex = (hexColor || '#f1c40f').replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length === 6) {
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, 0.18)`;
    }
    return 'rgba(241, 196, 15, 0.18)';
}

// แปลงข้อความราคา เช่น "2,500฿" ให้เป็นตัวเลข 2500
function parsePrice(priceStr) {
    if (!priceStr) return 0;
    const digits = String(priceStr).replace(/[^0-9]/g, '');
    return digits ? parseInt(digits, 10) : 0;
}

function rgbToHex(rgb) {
    if (!rgb || rgb.startsWith('#')) return rgb || '#3498db';
    const rgbValues = rgb.match(/\d+/g);
    if (!rgbValues) return '#3498db';
    return '#' + rgbValues.slice(0, 3).map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
}

// 🟢 1. ดึงข้อมูลผังโต๊ะจาก Backend
async function fetchLayout() {
    try {
        const res = await apiFetch('/api/layout');
        if (!res.ok) throw new Error('ไม่สามารถดึงข้อมูลผังได้');
        layoutData = await res.json();
        return layoutData;
    } catch (err) {
        console.error('Error fetching layout:', err);
        return [];
    }
}

// 🟢 2. รวบรวมผังจาก Canvas ส่งไปบันทึกที่ Backend
async function saveAdminLayout() {
    const canvasEl = document.getElementById('admin-seat-canvas');
    if (!canvasEl) return;

    try {
        const items = [];

        // เวที (Stage)
        canvasEl.querySelectorAll('.draggable-stage').forEach(stage => {
            items.push({
                id: stage.getAttribute('data-db-id') ? Number(stage.getAttribute('data-db-id')) : undefined,
                kind: 'stage',
                label: stage.textContent?.trim() || 'เวที',
                pos_left: stage.style.left || '150px',
                pos_top: stage.style.top || '15px',
                width: stage.style.width || '400px',
                height: stage.style.height || '55px',
                color: stage.getAttribute('data-color') || '#e74c3c'
            });
        });

        // ป้ายโซน (Zone Tags)
        canvasEl.querySelectorAll('.canvas-zone-tag').forEach(zone => {
            items.push({
                id: zone.getAttribute('data-db-id') ? Number(zone.getAttribute('data-db-id')) : undefined,
                kind: 'zone',
                label: zone.textContent?.trim() || 'โซน',
                pos_left: zone.style.left || '10px',
                pos_top: zone.style.top || '10px',
                width: zone.style.width || '200px',
                height: zone.style.height || '80px',
                color: zone.getAttribute('data-color') || '#f1c40f'
            });
        });

        // ราคาประจำโซน
        const prices = {
            vip: document.getElementById('edit-price-vip')?.value || '2,500฿',
            normal: document.getElementById('edit-price-normal')?.value || '1,200฿',
            general: document.getElementById('edit-price-general')?.value || '800฿'
        };

        // โต๊ะ (Tables)
        canvasEl.querySelectorAll('.draggable-table').forEach(table => {
            const tType = table.getAttribute('data-type') || 'normal';
            items.push({
                id: table.getAttribute('data-db-id') ? Number(table.getAttribute('data-db-id')) : undefined,
                kind: 'table',
                table_code: table.getAttribute('data-id'),
                zone_type: tType,
                price: prices[tType] || '1,000฿',
                pos_left: table.style.left || '10px',
                pos_top: table.style.top || '10px',
                width: table.style.width || '85px',
                height: table.style.height || '55px',
                color: table.getAttribute('data-color') || '#3498db'
            });
        });

        // รวม Headers ป้องกันกรณี authHeaders ไม่ถูกส่งมา
        const headers = { 'Content-Type': 'application/json' };
        if (typeof authHeaders === 'function') {
            Object.assign(headers, authHeaders());
        }

        const res = await apiFetch('/api/layout', {
            method: 'PUT',
            headers: headers,
            body: JSON.stringify({ items })
        });

        const data = await res.json();
        if (!res.ok) return alert('❌ ' + (data.error || 'บันทึกผังไม่สำเร็จ'));

        if (typeof renderMainPageLayout === 'function') await renderMainPageLayout();
        if (typeof renderAdminCanvasLayout === 'function') await renderAdminCanvasLayout();
        
        alert('💾 บันทึกผังโต๊ะเรียบร้อยแล้ว!');
    } catch (err) {
        console.error('Error in saveAdminLayout:', err);
        alert('เกิดข้อผิดพลาดในการบันทึกผัง: ' + err.message);
    }
}

// 🟢 3. เปิด Modal การจองฝั่งลูกค้า (ดูฟังก์ชันจริงด้านล่าง - รวมเหลือจุดเดียวเพื่อไม่ให้สับสน)

async function fetchSettings() {
    const res = await apiFetch('/api/settings');
    return res.json();
}

async function refreshConcertInfo() {
    const settings = await fetchSettings();
    document.getElementById('display-concert-title').textContent = settings.concert_title || '';
    document.getElementById('display-concert-date').textContent = settings.concert_date || '';
    if (document.getElementById('edit-title')) document.getElementById('edit-title').value = settings.concert_title || '';
    if (document.getElementById('edit-date')) document.getElementById('edit-date').value = settings.concert_date || '';
    if (document.getElementById('edit-price-vip')) document.getElementById('edit-price-vip').value = settings.price_vip || '';
    if (document.getElementById('edit-price-normal')) document.getElementById('edit-price-normal').value = settings.price_normal || '';
    if (document.getElementById('edit-price-general')) document.getElementById('edit-price-general').value = settings.price_general || '';
}
// =====================================================
// 🚫 ป้องกันการเลือกโต๊ะที่ติดกันในแนวนอน
// อนุญาตให้เลือกโต๊ะที่อยู่บน-ล่างกันได้
// =====================================================
function isHorizontalAdjacentTable(candidateBtn) {

    const candidateRect = candidateBtn.getBoundingClientRect();

    const selectedButtons = document.querySelectorAll(
        '.table-btn.selected'
    );

    const allTables = Array.from(
        document.querySelectorAll('.table-btn')
    );

    return Array.from(selectedButtons).some(selectedBtn => {

        const selectedRect = selectedBtn.getBoundingClientRect();

        // =================================================
        // 1. ตรวจว่าโต๊ะอยู่แถวเดียวกันหรือไม่
        // =================================================
        const verticalOverlap =
            Math.min(
                candidateRect.bottom,
                selectedRect.bottom
            ) -
            Math.max(
                candidateRect.top,
                selectedRect.top
            );

        const minHeight = Math.min(
            candidateRect.height,
            selectedRect.height
        );

        const sameRow =
            verticalOverlap > minHeight * 0.5;

        // ถ้าไม่ได้อยู่แถวเดียวกัน = อนุญาต
        if (!sameRow) {
            return false;
        }

        // =================================================
        // 2. ตรวจว่า candidate อยู่ซ้ายหรือขวาของโต๊ะที่เลือก
        // =================================================
        const candidateCenter =
            candidateRect.left + candidateRect.width / 2;

        const selectedCenter =
            selectedRect.left + selectedRect.width / 2;

        const isCandidateRight =
            candidateCenter > selectedCenter;

        // =================================================
        // 3. หาโต๊ะทุกตัวที่อยู่แถวเดียวกัน
        // =================================================
        const sameRowTables = allTables
            .filter(table => table !== candidateBtn)
            .filter(table => table !== selectedBtn)
            .map(table => ({
                element: table,
                rect: table.getBoundingClientRect()
            }))
            .filter(item => {

                const rect = item.rect;

                const overlap =
                    Math.min(
                        candidateRect.bottom,
                        rect.bottom
                    ) -
                    Math.max(
                        candidateRect.top,
                        rect.top
                    );

                const height =
                    Math.min(
                        candidateRect.height,
                        rect.height
                    );

                return overlap > height * 0.5;
            });

        // =================================================
        // 4. ตรวจว่ามีโต๊ะอื่นคั่นระหว่าง 2 โต๊ะหรือไม่
        // =================================================
        const tableBetween = sameRowTables.some(item => {

            const rect = item.rect;

            const center =
                rect.left + rect.width / 2;

            if (isCandidateRight) {

                return (
                    center > selectedCenter &&
                    center < candidateCenter
                );

            } else {

                return (
                    center < selectedCenter &&
                    center > candidateCenter
                );
            }
        });

        // =================================================
        // ถ้ามีโต๊ะคั่นกลาง = ไม่ถือว่าติดกัน
        // สามารถเลือกได้
        // =================================================
        if (tableBetween) {
            return false;
        }

        // =================================================
        // ไม่มีโต๊ะคั่นกลาง = ติดกันแนวนอน
        // ห้ามเลือก
        // =================================================
        return true;
    });
}
// --- ระบบผังโต๊ะหน้าแรก (User Mode) ---
async function renderMainPageLayout() {
    const seatGrid = document.getElementById('main-seat-grid');
    if (!seatGrid) return;

    await fetchLayout();

    seatGrid.style.position = 'relative';
    seatGrid.style.height = '1200px';
    seatGrid.style.background = '#111';
    seatGrid.style.border = '2px dashed #333';
    seatGrid.style.borderRadius = '12px';
    seatGrid.style.overflow = 'hidden';
    seatGrid.innerHTML = '';

    const tooltip = document.getElementById('table-tooltip');
    selectedTables = [];

    // 🔴 1. สร้างเวทีขนาดตามภาพตัวอย่าง (340px x 55px) หากในระบบไม่มีข้อมูลเวที
    const hasStage = layoutData && layoutData.some(item => item.kind === 'stage');
    if (!hasStage) {
        const defaultStage = document.createElement('div');
        defaultStage.className = 'stage-item';
        defaultStage.style.position = 'absolute';
        defaultStage.style.left = '50%';
        defaultStage.style.transform = 'translateX(-50%)';
        defaultStage.style.top = '20px';
        defaultStage.style.width = '280px';  // 🟢 ขยายความกว้าง
        defaultStage.style.height = '55px';  // 🟢 ขยายความสูง
        defaultStage.style.backgroundColor = '#e74c3c';
        defaultStage.style.color = '#ffffff';
        defaultStage.style.display = 'flex';
        defaultStage.style.alignItems = 'center';
        defaultStage.style.justifyContent = 'center';
        defaultStage.style.fontWeight = 'bold';
        defaultStage.style.fontSize = '0.95rem';
        defaultStage.style.borderRadius = '10px';
        defaultStage.style.boxShadow = '0 4px 12px rgba(231, 76, 60, 0.4)';
        defaultStage.style.zIndex = '5';
        defaultStage.style.border = '1px solid #c0392b';
        defaultStage.textContent = '🎤 เวทีคอนเสิร์ต (STAGE)';
        seatGrid.appendChild(defaultStage);
    }

    // 🟢 2. วาดองค์ประกอบตามข้อมูล layoutData
    layoutData.forEach(item => {
        if (item.kind === 'stage') {
            const stage = document.createElement('div');
            stage.className = 'stage-item';
            stage.style.position = 'absolute';
            stage.style.left = item.pos_left;
            stage.style.top = item.pos_top;
            stage.style.width = item.width || '340px';
            stage.style.height = item.height || '55px';
            stage.style.backgroundColor = item.color || '#e74c3c';
            stage.style.color = '#ffffff';
            stage.style.display = 'flex';
            stage.style.alignItems = 'center';
            stage.style.justifyContent = 'center';
            stage.style.fontWeight = 'bold';
            stage.style.fontSize = '0.95rem';
            stage.style.borderRadius = '10px';
            stage.style.boxShadow = '0 4px 12px rgba(231, 76, 60, 0.4)';
            stage.style.zIndex = '5';
            stage.textContent = item.label || '🎤 เวทีคอนเสิร์ต (STAGE)';
            seatGrid.appendChild(stage);
        } else if (item.kind === 'zone') {
            const zone = document.createElement('div');
            zone.className = 'zone-item';
            zone.style.position = 'absolute';
            zone.style.left = item.pos_left;
            zone.style.top = item.pos_top;
            zone.style.width = item.width || '200px';
            zone.style.height = item.height || '80px';
            zone.style.color = item.color || '#f1c40f';
            zone.style.backgroundColor = getFaintBgColor(item.color);
            zone.style.border = `2px dashed ${item.color || '#f1c40f'}`;
            zone.style.display = 'flex';
            zone.style.alignItems = 'flex-start';
            zone.style.justifyContent = 'center';
            zone.style.paddingTop = '6px';
            zone.textContent = item.label;
            seatGrid.appendChild(zone);
        } else if (item.kind === 'table') {
            const tableCode = item.table_code || item.code || item.id;

            const isCheckedIn = !!item.checked_in;
            const isReserved = item.booking_status === 'pending' || item.booking_status === 'approved';

            const btn = document.createElement('button');
            
            let classList = `table-btn ${item.zone_type}`;
            if (isCheckedIn) {
                classList += ' checked-in reserved';
            } else if (isReserved) {
                classList += ' reserved';
            }
            btn.className = classList;

            btn.style.position = 'absolute';
            btn.style.left = item.pos_left;
            btn.style.top = item.pos_top;
            if (item.width) btn.style.width = item.width;
            if (item.height) btn.style.height = item.height;

            btn.style.setProperty('display', 'flex', 'important');
            btn.style.setProperty('flex-direction', 'column', 'important');
            btn.style.setProperty('align-items', 'center', 'important');
            btn.style.setProperty('justify-content', 'center', 'important');
            btn.style.setProperty('padding', '2px', 'important');
            btn.style.setProperty('box-sizing', 'border-box', 'important');

            btn.disabled = isReserved;

            if (isCheckedIn) {
                btn.style.setProperty('background-color', '#2ecc71', 'important');
                btn.style.setProperty('color', '#ffffff', 'important');
                btn.style.setProperty('opacity', '1', 'important');
                btn.style.setProperty('border', 'none', 'important');
                
                btn.innerHTML = `
                    <span style="font-size: 0.65rem; font-weight: bold; line-height: 1; color: #fff !important; white-space: nowrap;">${escapeHtml(tableCode)}</span>
                    <span style="font-size: 0.48rem; line-height: 1; margin-top: 3px; color: #fff !important; opacity: 0.9; white-space: nowrap;">เข้างานแล้ว</span>
                `;
          } else {
    // 🟠 โต๊ะที่รอตรวจสอบสลิป = สีส้ม
    if (item.booking_status === 'pending') {
        btn.style.setProperty('background-color', '#e74c3c', 'important');
        btn.style.setProperty('color', '#ffffff', 'important');
    } else if (item.color && !isReserved) {
        btn.style.backgroundColor = item.color;
    }

    btn.innerHTML = `<span style="font-size: 0.75rem; font-weight: bold; line-height: 1;">${escapeHtml(tableCode)}</span>`;
}

            btn.addEventListener('mouseenter', () => {
                if (!tooltip) return;
                tooltip.style.display = 'block';
                let statusText = '';
                if (isCheckedIn) {
                    statusText = '✅ เข้างานเรียบร้อยแล้ว';
                } else if (item.booking_status === 'approved') {
                    statusText = '🔒 จองแล้ว (ยืนยันแล้ว)';
                } else if (item.booking_status === 'pending') {
                    statusText = '⏳ กำลังรอตรวจสอบสลิป';
                } else {
                    statusText = `💰 ราคาบัตร: ${escapeHtml(item.price || '-')}`;
                }
                tooltip.innerHTML = `🎫 โต๊ะ: <b>${escapeHtml(tableCode)}</b><br>${statusText}`;
            });

            btn.addEventListener('mousemove', (e) => {
                if (!tooltip) return;
                tooltip.style.left = (e.pageX + 15) + 'px';
                tooltip.style.top = (e.pageY + 15) + 'px';
            });
            btn.addEventListener('mouseleave', () => { if (tooltip) tooltip.style.display = 'none'; });

           if (!isReserved) {
    btn.addEventListener('click', () => {

        // =================================================
        // กรณีคลิกโต๊ะที่เลือกอยู่แล้ว = ยกเลิกการเลือก
        // =================================================
        if (btn.classList.contains('selected')) {
            btn.classList.remove('selected');

            selectedTables = selectedTables.filter(
                id => id !== tableCode
            );

            updateSelectionSummary();
            return;
        }

        // =================================================
        // 🚫 ป้องกันการเลือกโต๊ะที่ติดกันในแนวนอน
        // =================================================
       if (isHorizontalAdjacentTable(btn)) {

    showTableWarning(
        `ไม่สามารถเลือกโต๊ะ ${tableCode} ได้<br>` +
        `โต๊ะนี้อยู่ติดกับโต๊ะที่คุณเลือกอยู่ในแนวนอน<br>` +
        `กรุณาเลือกโต๊ะด้านบนหรือด้านล่างแทนครับ`
    );

    return;
}

        // =================================================
        // เลือกโต๊ะตามปกติ
        // =================================================
        btn.classList.add('selected');
        selectedTables.push(tableCode);

        updateSelectionSummary();
    });
}

            seatGrid.appendChild(btn);
        }
    });

    updateSelectionSummary();
    // ใช้ requestAnimationFrame รอให้เบราว์เซอร์จัด layout ของโต๊ะ/โซนที่เพิ่ง append เสร็จสมบูรณ์ก่อน
    // ค่อยวัดขนาด ไม่งั้นบางครั้งจะวัดค่าไม่ครบ (เจอปัญหานี้พอดี - บางรอบโหลดได้ครบ บางรอบไม่ครบ)
    requestAnimationFrame(() => fitCanvasToScreen('main-seat-grid'));
}
function showTableWarning(message) {

    // ลบข้อความเดิมก่อน
    const oldWarning = document.getElementById('table-selection-warning');

    if (oldWarning) {
        oldWarning.remove();
    }

    const warning = document.createElement('div');

    warning.id = 'table-selection-warning';

    warning.innerHTML = `
        <div style="
            font-size: 18px;
            font-weight: 700;
            margin-bottom: 8px;
        ">
            ⚠️ ไม่สามารถเลือกโต๊ะนี้ได้
        </div>

        <div style="
            font-size: 15px;
            line-height: 1.6;
        ">
            ${message}
        </div>
    `;

    Object.assign(warning.style, {
        position: 'fixed',
        left: '50%',
        bottom: '30px',
        transform: 'translateX(-50%)',
        zIndex: '999999',
        width: 'min(90vw, 420px)',
        boxSizing: 'border-box',
        padding: '16px 20px',
        background: '#e74c3c',
        color: '#ffffff',
        borderRadius: '14px',
        textAlign: 'center',
        boxShadow: '0 6px 25px rgba(0,0,0,0.3)',
        fontFamily: 'inherit'
    });

    document.body.appendChild(warning);

    // แสดง 2.5 วินาที
    setTimeout(() => {
        warning.remove();
    }, 2500);
}
// อัปเดตยอดรวม "เลือกแล้ว X โต๊ะ | รวม Y บาท" ที่แสดงเหนือปุ่มยืนยัน (คำนวณสดทุกครั้งที่เลือก/ยกเลิกโต๊ะ)
function updateSelectionSummary() {
    const el = document.getElementById('selection-summary');
    if (!el) return;

    let total = 0;
    selectedTables.forEach(code => {
        const item = layoutData.find(i => i.kind === 'table' && i.table_code === code);
        if (item) total += parsePrice(item.price);
    });

    el.textContent = `เลือกแล้ว ${selectedTables.length} โต๊ะ | รวม ${total.toLocaleString('th-TH')} บาท`;
}

// --- สรุปจำนวนโต๊ะคงเหลือแยกตามโซน (หน้าแรก - ดูอย่างเดียว กดจองไม่ได้) ---
async function renderTableSummary() {
    const container = document.getElementById('table-summary-list');
    if (!container) return;

    await fetchLayout();

    const zoneLabels = { vip: 'VIP', normal: 'ธรรมดา', general: 'ทั่วไป' };
    const zoneStats = {};

    layoutData.filter(i => i.kind === 'table').forEach(item => {
        const zone = item.zone_type || 'normal';
        if (!zoneStats[zone]) zoneStats[zone] = { total: 0, available: 0 };
        zoneStats[zone].total++;
        if (item.booking_status === 'available') zoneStats[zone].available++;
    });

    container.innerHTML = '';
    Object.keys(zoneStats).forEach(zone => {
        const stat = zoneStats[zone];
        const soldOut = stat.available === 0;
        const card = document.createElement('div');
        card.className = 'summary-card';
        card.innerHTML = `
            <div class="summary-zone-name">${escapeHtml(zoneLabels[zone] || zone)}</div>
            <div class="summary-count ${soldOut ? 'sold-out' : ''}">${soldOut ? 'เต็ม' : stat.available}</div>
            <div class="summary-sub">จากทั้งหมด ${stat.total} โต๊ะ</div>
        `;
        container.appendChild(card);
    });

    if (Object.keys(zoneStats).length === 0) {
        container.innerHTML = '<p style="color:#888;">ยังไม่มีผังโต๊ะในระบบ</p>';
    }
}

// 🔧 ฟังก์ชันกลาง: ซ่อนทุก "หน้า" ฝั่งลูกค้าก่อนสลับไปหน้าใหม่ (หน้าแรก/ผังจองโต๊ะ/เมนูอาหาร/ติดต่อเรา)
// ใช้ร่วมกันทุกฟังก์ชัน showXxxView() เพื่อไม่ให้มีหน้าซ้อนกันโดยไม่ตั้งใจ
// 🟢 เปิด/ปิดเมนู Navbar บนมือถือ (แฮมเบอร์เกอร์เมนู)
function toggleMobileNav() {
    const wrap = document.getElementById('navMobileWrap');
    if (wrap) wrap.classList.toggle('open');
}
function closeMobileNav() {
    const wrap = document.getElementById('navMobileWrap');
    if (wrap) wrap.classList.remove('open');
}
// 🟢 ปรับผังโต๊ะ (canvas พิกัด px ตายตัว) ให้ย่อพอดีจอมือถือ โดยไม่กระทบระยะห่างจริงที่แอดมินจัดไว้
// ใช้กับหน้าดูอย่างเดียว (ลูกค้าจอง/ตรวจบัตร) เท่านั้น ไม่ใช้กับหน้าแก้ไขผัง เพราะการลากวางต้องใช้พิกัดจริงแบบไม่ย่อ
// ถ้าจอกว้างพอ (เดสก์ท็อป) จะไม่แตะอะไรเลย คงหน้าตาเดิมไว้ทั้งหมด
function fitCanvasToScreen(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    // รีเซ็ตของเก่าก่อนวัดใหม่ทุกครั้ง (เผื่อเรียกซ้ำตอน resize/re-render)
    canvas.style.transform = '';
    canvas.style.removeProperty('height');
    canvas.style.removeProperty('width');
    canvas.style.removeProperty('max-width');
    canvas.style.marginBottom = '';
    canvas.dataset.fitScale = '1';

    // 1) วัด "พื้นที่จอที่มีจริง" ก่อน ตอนที่ canvas ยังใช้ค่า max-width ปกติ (800px หรือแคบกว่าตามจอ)
    const availableWidth = canvas.clientWidth;

    // 2) วัดขนาดที่ "ต้องใช้จริง" จากตำแหน่ง+ขนาดของทุกชิ้นในผัง (เวที/โซน/โต๊ะ)
    let maxRight = 0, maxBottom = 0, minLeft = Infinity, minTop = Infinity;
    canvas.querySelectorAll(':scope > div').forEach(el => {
        const left = parseFloat(el.style.left) || 0;
        const top = parseFloat(el.style.top) || 0;
        const width = parseFloat(el.style.width) || el.offsetWidth || 0;
        const height = parseFloat(el.style.height) || el.offsetHeight || 0;
        maxRight = Math.max(maxRight, left + width);
        maxBottom = Math.max(maxBottom, top + height);
        minLeft = Math.min(minLeft, left);
        minTop = Math.min(minTop, top);
    });
    if (maxRight === 0 || maxBottom === 0) return;

    // เผื่อระยะขอบขวา/ล่าง ให้เท่ากับระยะขอบซ้าย/บนที่แอดมินจัดไว้อยู่แล้ว (minLeft/minTop)
    // แทนที่จะใช้ค่าคงที่ตายตัว จะได้ดูสมมาตรทั้งสองฝั่ง ไม่ใช่ฝั่งนึงห่างฝั่งนึงชิด
    const rightPad = Number.isFinite(minLeft) ? minLeft : 6;
    const bottomPad = Number.isFinite(minTop) ? minTop : 6;
    maxRight += rightPad;
    maxBottom += bottomPad;

    const needsWidthScale = availableWidth > 0 && availableWidth < maxRight;

    if (!needsWidthScale) {
        // 🔧 กว้างพอดีอยู่แล้ว (เดสก์ท็อป) ไม่ต้องย่อ แต่ยังต้องแก้ความสูงให้พอดีเนื้อหาเสมอ
        // เดิมโค้ดจุดนี้ return ออกไปเลยโดยไม่แตะความสูง ทำให้ผังที่มีโต๊ะเยอะๆ/หลายแถว (สูงเกิน 1000px)
        // โดน overflow:hidden ตัดท่อนล่างทิ้งไปเงียบๆ เพราะสไตล์ชีตหลักบังคับ height:1000px !important ไว้ตายตัว
        canvas.style.setProperty('height', `${maxBottom}px`, 'important');
        return;
    }

    const scale = availableWidth / maxRight;
    canvas.dataset.fitScale = String(scale);

    // 3) 🔑 สำคัญ: ต้องขยาย canvas ให้กว้างพอรับโต๊ะทุกตัวก่อน (ไม่งั้น overflow:hidden จะตัดโต๊ะที่อยู่ขวาสุดทิ้ง
    //    ไปตั้งแต่ก่อนที่ transform:scale จะมีผล เพราะ transform ไม่เปลี่ยนกรอบ clip ของตัวมันเอง)
    canvas.style.setProperty('max-width', 'none', 'important');
    canvas.style.setProperty('width', `${maxRight}px`, 'important');

    // 4) ค่อยย่อภาพรวมทั้งหมดให้พอดีความกว้างจอจริง
    canvas.style.transformOrigin = 'top left';
    canvas.style.transform = `scale(${scale})`;

    // .seat-grid มี height: 1000px !important ในสไตล์ชีตหลัก (เผื่อพื้นที่ลากผังฝั่งแอดมิน)
    // ต้องตั้งเป็นความสูง "ก่อนย่อ" (maxBottom เฉยๆ ไม่คูณ scale) ให้เท่ากับ width ที่ตั้งไว้ข้างบน
    // แล้วปล่อยให้ transform:scale ย่อทั้งกว้าง-สูงไปพร้อมกันเอง ไม่งั้นเนื้อหาจะโดนตัดแนวตั้งเพราะกรอบเพี้ยนสัดส่วน
    canvas.style.setProperty('height', `${maxBottom}px`, 'important');

    // 5) เบราว์เซอร์ยังจอง "พื้นที่จริงก่อนย่อ" ไว้ในหน้าเสมอ (transform ไม่ลดพื้นที่ใน document flow)
    //    ใช้ margin ติดลบดึงเนื้อหาถัดไปขึ้นมาชิดกับภาพที่ย่อแล้วจริงๆ กันเหลือช่องว่างเปล่าด้านล่าง
    const visualHeight = maxBottom * scale;
    canvas.style.marginBottom = `${visualHeight - maxBottom}px`;
}

function hideAllPublicPages() {
    const hero = document.querySelector('.hero-section');
    const summary = document.getElementById('table-summary-section');
    const rules = document.querySelector('.rules-section');
    const booking = document.getElementById('booking');
    const menuPage = document.getElementById('menu-page');
    const contactPage = document.getElementById('contact-page');

    if (hero) hero.style.display = 'none';
    if (summary) summary.style.display = 'none';
    if (rules) rules.style.display = 'none';
    if (booking) booking.style.display = 'none';
    if (menuPage) menuPage.style.display = 'none';
    if (contactPage) contactPage.style.display = 'none';
}

// --- สลับไปหน้าจองบัตร (แก้ปัญหา Navbar บังหัวข้อ) ---
async function showBookingView() {
    hideAllPublicPages();

    // รันฟังก์ชัน Render ของระบบ
    if (typeof renderMainPageLayout === 'function') {
        await renderMainPageLayout();
    }

    const booking = document.getElementById('booking');
    if (booking) {
        booking.style.display = 'block';
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- กลับไปหน้าแรก ---
async function showHomeView() {
    hideAllPublicPages();

    const hero = document.querySelector('.hero-section');
    const summary = document.getElementById('table-summary-section');
    const rules = document.querySelector('.rules-section');

    if (hero) hero.style.display = 'flex';
    if (summary) summary.style.display = 'block';
    if (rules) rules.style.display = 'block';

    if (typeof renderTableSummary === 'function') {
        await renderTableSummary();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- ระบบสร้าง/ซ่อนเส้นจัดแนว (Snap Guide Lines) ---
function ensureGuideLines() {
    const canvas = document.getElementById('admin-seat-canvas');
    if (!canvas) return;
    if (!document.getElementById('guide-line-h')) {
        const gh = document.createElement('div');
        gh.id = 'guide-line-h';
        gh.className = 'guide-line guide-line-h';
        canvas.appendChild(gh);
    }
    if (!document.getElementById('guide-line-v')) {
        const gv = document.createElement('div');
        gv.id = 'guide-line-v';
        gv.className = 'guide-line guide-line-v';
        canvas.appendChild(gv);
    }
}

function hideGuideLines() {
    const gh = document.getElementById('guide-line-h');
    const gv = document.getElementById('guide-line-v');
    if (gh) gh.style.display = 'none';
    if (gv) gv.style.display = 'none';
}

// --- ระบบผังโต๊ะโหมดแอดมิน (Drag & Drop Canvas + Smart Align) ---
async function renderAdminCanvasLayout() {
    const canvas = document.getElementById('admin-seat-canvas');
    if (!canvas) return;

    await fetchLayout();

    canvas.style.position = 'relative';
    canvas.style.height = '1200px';
    canvas.style.background = '#111';
    canvas.style.border = '2px dashed #444';
    canvas.style.borderRadius = '12px';
    canvas.style.overflow = 'hidden';
    canvas.innerHTML = '';

    ensureGuideLines();

    layoutData.forEach(item => {
        if (item.kind === 'stage') {
            const stage = document.createElement('div');
            stage.className = 'draggable-stage';
            stage.textContent = item.label || '🎤 เวทีคอนเสิร์ต (STAGE)';
            stage.style.position = 'absolute';
            stage.style.left = item.pos_left;
            stage.style.top = item.pos_top;
            stage.style.width = item.width || '400px';
            stage.style.height = item.height || '55px';
            stage.style.backgroundColor = item.color || '#e74c3c';
            stage.setAttribute('data-kind', 'stage');
            stage.setAttribute('data-db-id', item.id);
            stage.setAttribute('data-color', item.color || '#e74c3c');
            setupInteractiveElement(stage);
            canvas.appendChild(stage);
        } else if (item.kind === 'zone') {
            const zone = document.createElement('div');
            zone.className = 'canvas-zone-tag';
            zone.textContent = item.label;
            zone.style.position = 'absolute';
            zone.style.left = item.pos_left;
            zone.style.top = item.pos_top;
            zone.style.width = item.width || '200px';
            zone.style.height = item.height || '80px';
            zone.style.color = item.color || '#f1c40f';
            zone.style.backgroundColor = getFaintBgColor(item.color);
            zone.style.border = `2px dashed ${item.color || '#f1c40f'}`;
            zone.style.display = 'flex';
            zone.style.alignItems = 'flex-start';
            zone.style.justifyContent = 'center';
            zone.style.paddingTop = '6px';
            zone.setAttribute('data-kind', 'zone');
            zone.setAttribute('data-db-id', item.id);
            zone.setAttribute('data-color', item.color || '#f1c40f');
            setupInteractiveElement(zone);
            canvas.appendChild(zone);
        } else if (item.kind === 'table') {
            const table = document.createElement('div');
            table.className = `draggable-table ${item.zone_type}`;
            table.style.position = 'absolute';
            table.style.left = item.pos_left;
            table.style.top = item.pos_top;
            table.style.width = item.width || '85px';
            table.style.height = item.height || '55px';
            if (item.color) table.style.backgroundColor = item.color;
            table.setAttribute('data-kind', 'table');
            table.setAttribute('data-db-id', item.id);
            table.setAttribute('data-id', item.table_code);
            table.setAttribute('data-type', item.zone_type);
            table.setAttribute('data-price', item.price || '');
            table.setAttribute('data-color', item.color || (item.zone_type === 'vip' ? '#e74c3c' : '#3498db'));
            table.setAttribute('data-booking-status', item.booking_status || 'available');
            table.setAttribute('data-checked-in', item.checked_in ? '1' : '0');
            table.innerHTML = `<span>${escapeHtml(item.table_code)}</span>`;
            setupInteractiveElement(table);
            canvas.appendChild(table);
        }
    });

    requestAnimationFrame(() => fitCanvasToScreen('admin-seat-canvas'));
}

function setupInteractiveElement(el) {
    el.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('resize-handle')) return;

        selectAdminItem(el);
        ensureGuideLines();

        const canvas = document.getElementById('admin-seat-canvas');
        const canvasRect = canvas.getBoundingClientRect();
        const scale = parseFloat(canvas.dataset.fitScale || '1'); // ผังอาจถูกย่อให้พอดีจอเล็ก ต้องคูณกลับตอนคำนวณระยะลาก
        const offsetX = (e.clientX - el.getBoundingClientRect().left) / scale;
        const offsetY = (e.clientY - el.getBoundingClientRect().top) / scale;

        const snapEnabled = document.getElementById('snap-to-grid')?.checked ?? true;
        const SNAP_THRESHOLD = 8;

        const others = Array.from(canvas.children).filter(child =>
            child !== el &&
            !child.classList.contains('guide-line') &&
            !child.classList.contains('resize-handle')
        );

        const gh = document.getElementById('guide-line-h');
        const gv = document.getElementById('guide-line-v');

        const onMouseMove = (moveEvent) => {
            let x = (moveEvent.clientX - canvasRect.left) / scale - offsetX;
            let y = (moveEvent.clientY - canvasRect.top) / scale - offsetY;

            x = Math.max(0, Math.min(x, (canvasRect.width / scale) - el.offsetWidth));
            y = Math.max(0, Math.min(y, (canvasRect.height / scale) - el.offsetHeight));

            let snappedX = false;
            let snappedY = false;

            if (snapEnabled) {
                const elW = el.offsetWidth;
                const elH = el.offsetHeight;
                const curL = x, curR = x + elW, curCX = x + elW / 2;
                const curT = y, curB = y + elH, curCY = y + elH / 2;

                for (const other of others) {
                    const oL = other.offsetLeft, oR = oL + other.offsetWidth, oCX = oL + other.offsetWidth / 2;
                    const oT = other.offsetTop, oB = oT + other.offsetHeight, oCY = oT + other.offsetHeight / 2;

                    if (!snappedX) {
                        if (Math.abs(curL - oL) < SNAP_THRESHOLD) { x = oL; snappedX = true; showGuideV(oL); }
                        else if (Math.abs(curL - oR) < SNAP_THRESHOLD) { x = oR; snappedX = true; showGuideV(oR); }
                        else if (Math.abs(curR - oR) < SNAP_THRESHOLD) { x = oR - elW; snappedX = true; showGuideV(oR); }
                        else if (Math.abs(curR - oL) < SNAP_THRESHOLD) { x = oL - elW; snappedX = true; showGuideV(oL); }
                        else if (Math.abs(curCX - oCX) < SNAP_THRESHOLD) { x = oCX - elW / 2; snappedX = true; showGuideV(oCX); }
                    }
                    if (!snappedY) {
                        if (Math.abs(curT - oT) < SNAP_THRESHOLD) { y = oT; snappedY = true; showGuideH(oT); }
                        else if (Math.abs(curT - oB) < SNAP_THRESHOLD) { y = oB; snappedY = true; showGuideH(oB); }
                        else if (Math.abs(curB - oB) < SNAP_THRESHOLD) { y = oB - elH; snappedY = true; showGuideH(oB); }
                        else if (Math.abs(curB - oT) < SNAP_THRESHOLD) { y = oT - elH; snappedY = true; showGuideH(oT); }
                        else if (Math.abs(curCY - oCY) < SNAP_THRESHOLD) { y = oCY - elH / 2; snappedY = true; showGuideH(oCY); }
                    }
                }
            }

            if (!snappedX && gv) gv.style.display = 'none';
            if (!snappedY && gh) gh.style.display = 'none';

            el.style.left = x + 'px';
            el.style.top = y + 'px';
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            hideGuideLines();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

function showGuideV(xPos) {
    const gv = document.getElementById('guide-line-v');
    if (gv) { gv.style.left = xPos + 'px'; gv.style.display = 'block'; }
}
function showGuideH(yPos) {
    const gh = document.getElementById('guide-line-h');
    if (gh) { gh.style.top = yPos + 'px'; gh.style.display = 'block'; }
}

function selectAdminItem(el) {
    if (activeAdminItem && activeAdminItem !== el) deselectAdminItem();
    activeAdminItem = el;
    activeAdminItem.classList.add('selected-admin-item');
    createResizeHandles(activeAdminItem);

    const label = document.getElementById('selected-item-label');
    const kind = el.getAttribute('data-kind');

    if (kind === 'table') {
        label.textContent = `🎯 กำลังเลือก: โต๊ะ ${el.getAttribute('data-id')}`;
        lastTableWidth = el.style.width || el.offsetWidth + 'px';
        lastTableHeight = el.style.height || el.offsetHeight + 'px';
    } else if (kind === 'stage') {
        label.textContent = `🎯 กำลังเลือก: เวทีคอนเสิร์ต (STAGE)`;
    } else {
        label.textContent = `🎯 กำลังเลือก: โซน (${el.textContent})`;
    }

    updateSizeDisplay();
    const currentColor = el.getAttribute('data-color') || '#3498db';
    document.getElementById('item-color-picker').value = rgbToHex(currentColor);
}

function deselectAdminItem() {
    if (activeAdminItem) {
        activeAdminItem.classList.remove('selected-admin-item');
        removeResizeHandles(activeAdminItem);
        activeAdminItem = null;
    }
}

function createResizeHandles(el) {
    removeResizeHandles(el);
    ['e', 's', 'se'].forEach(type => {
        const handle = document.createElement('div');
        handle.className = `resize-handle handle-${type}`;

        handle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            const canvas = document.getElementById('admin-seat-canvas');
            const scale = parseFloat(canvas?.dataset.fitScale || '1');
            const startX = e.clientX, startY = e.clientY;
            const startWidth = el.offsetWidth, startHeight = el.offsetHeight;

            const onHandleMove = (moveEv) => {
                const dx = (moveEv.clientX - startX) / scale;
                const dy = (moveEv.clientY - startY) / scale;
                if (type === 'e' || type === 'se') el.style.width = Math.max(40, startWidth + dx) + 'px';
                if (type === 's' || type === 'se') el.style.height = Math.max(25, startHeight + dy) + 'px';
                if (el.getAttribute('data-kind') === 'table') {
                    lastTableWidth = el.style.width;
                    lastTableHeight = el.style.height;
                }
                updateSizeDisplay();
            };
            const onHandleUp = () => {
                document.removeEventListener('mousemove', onHandleMove);
                document.removeEventListener('mouseup', onHandleUp);
            };
            document.addEventListener('mousemove', onHandleMove);
            document.addEventListener('mouseup', onHandleUp);
        });
        el.appendChild(handle);
    });
}

function removeResizeHandles(el) {
    if (!el) return;
    el.querySelectorAll('.resize-handle').forEach(h => h.remove());
}

function updateSizeDisplay() {
    if (!activeAdminItem) return;
    document.getElementById('item-size-display').textContent =
        `ขนาด: ${Math.round(activeAdminItem.offsetWidth)} x ${Math.round(activeAdminItem.offsetHeight)} px`;
}

function applyLastSizeToSelected() {
    if (!activeAdminItem) return alert('กรุณาคลิกเลือกโต๊ะที่ต้องการปรับขนาดก่อนครับ');
    activeAdminItem.style.width = lastTableWidth;
    activeAdminItem.style.height = lastTableHeight;
    updateSizeDisplay();
}

function applyItemColor(colorHex) {
    if (!activeAdminItem) return alert('กรุณาคลิกเลือกวัตถุที่ต้องการเปลี่ยนสีก่อนครับ');
    const kind = activeAdminItem.getAttribute('data-kind');
    activeAdminItem.setAttribute('data-color', colorHex);
    if (kind === 'zone') {
        activeAdminItem.style.color = colorHex;
        activeAdminItem.style.border = `2px dashed ${colorHex}`;
        activeAdminItem.style.backgroundColor = getFaintBgColor(colorHex);
    } else {
        activeAdminItem.style.backgroundColor = colorHex;
    }
}

function deleteSelectedItem() {
    if (!activeAdminItem) return alert('กรุณาคลิกเลือกวัตถุที่ต้องการลบก่อนครับ');

    // 🔒 กันลบโต๊ะที่มีลูกค้าจองอยู่ (pending/approved) หรือเช็กอินเข้างานแล้ว
    // เพราะถ้าลบไปตอนนี้ จะไม่มีทางเชื่อมโยงกลับไปหารายการจองเดิมได้อีก
    if (activeAdminItem.getAttribute('data-kind') === 'table') {
        const bStatus = activeAdminItem.getAttribute('data-booking-status') || 'available';
        const isCheckedIn = activeAdminItem.getAttribute('data-checked-in') === '1';
        if (bStatus !== 'available' || isCheckedIn) {
            const tableCode = activeAdminItem.getAttribute('data-id') || '';
            alert(`⚠️ ไม่สามารถลบโต๊ะ "${tableCode}" ได้ เพราะมีลูกค้าจองอยู่แล้ว${isCheckedIn ? ' (เช็กอินเข้างานแล้ว)' : ''}\n\nถ้าต้องการลบจริงๆ ให้ยกเลิกรายการจองที่หน้า "รายการจองและตรวจสอบสลิป" ก่อน หรือกด "สิ้นสุดคอนเสิร์ต" เพื่อล้างรายการจองทั้งหมดก่อน แล้วค่อยกลับมาลบโต๊ะนี้`);
            return;
        }
    }

    if (confirm('คุณต้องการลบวัตถุนี้ออกจากผังใช่หรือไม่? (จะมีผลจริงเมื่อกด "บันทึกผังลงหน้าแรก")')) {
        activeAdminItem.remove();
        activeAdminItem = null;
        document.getElementById('selected-item-label').textContent = '👈 คลิกที่โต๊ะ เวที หรือโซนเพื่อแก้ไข';
        document.getElementById('item-size-display').textContent = 'ขนาด: -';
    }
}

function addAdminTable() {
    const idInput = document.getElementById('new-table-id');
    const typeInput = document.getElementById('new-table-type');
    const tableId = idInput.value.trim();
    const type = typeInput.value;
    if (!tableId) return alert('กรุณากรอกเลขโต๊ะ');

    // กันเลขโต๊ะซ้ำฝั่ง client (server จะเช็คซ้ำอีกชั้นตอนบันทึก)
    const dup = Array.from(document.querySelectorAll('#admin-seat-canvas [data-kind="table"]'))
        .some(el => el.getAttribute('data-id') === tableId);
    if (dup) return alert('มีเลขโต๊ะนี้อยู่ในผังแล้ว กรุณาใช้เลขอื่น');

    const prices = {
        vip: document.getElementById('edit-price-vip')?.value || '2,500฿',
        normal: document.getElementById('edit-price-normal')?.value || '1,200฿',
        general: document.getElementById('edit-price-general')?.value || '800฿'
    };
    const price = prices[type] || '1,000฿';

    let defaultColor = '#3498db';
   if (type === 'vip') defaultColor = '#0000FF';
    if (type === 'general') defaultColor = '#2ecc71';

    const table = document.createElement('div');
    table.className = `draggable-table ${type}`;
    table.style.position = 'absolute';
    table.style.left = '40%';
    table.style.top = '150px';
    table.style.width = lastTableWidth;
    table.style.height = lastTableHeight;
    table.style.backgroundColor = defaultColor;
    table.setAttribute('data-kind', 'table');
    table.setAttribute('data-id', tableId);
    table.setAttribute('data-type', type);
    table.setAttribute('data-price', price);
    table.setAttribute('data-color', defaultColor);
    table.innerHTML = `<span>${escapeHtml(tableId)}</span>`;

    setupInteractiveElement(table);
    document.getElementById('admin-seat-canvas').appendChild(table);
    selectAdminItem(table);
    idInput.value = '';
}

// กู้คืน/สร้างเวทีใหม่ (เผื่อกรณีเวทีถูกลบไปจากผัง จะได้มีทางเพิ่มกลับเข้ามาได้จาก UI โดยตรง)
function addAdminStage() {
    const existing = document.querySelector('#admin-seat-canvas [data-kind="stage"]');
    if (existing) {
        return alert('มีเวทีอยู่ในผังแล้ว 1 อัน ถ้าต้องการย้ายตำแหน่งให้คลิกแล้วลากได้เลย');
    }

    const stage = document.createElement('div');
    stage.className = 'draggable-stage';
    stage.textContent = '🎤 เวทีคอนเสิร์ต (STAGE)';
    stage.style.position = 'absolute';
    stage.style.left = '150px';
    stage.style.top = '15px';
    stage.style.width = '400px';
    stage.style.height = '55px';
    stage.style.backgroundColor = '#e74c3c';
    stage.setAttribute('data-kind', 'stage');
    stage.setAttribute('data-color', '#e74c3c');

    setupInteractiveElement(stage);
    document.getElementById('admin-seat-canvas').appendChild(stage);
    selectAdminItem(stage);
}

function addAdminZone() {
    const zoneInput = document.getElementById('new-zone-name');
    const colorInput = document.getElementById('new-zone-color');
    const zoneName = zoneInput.value.trim();
    const zoneColor = colorInput ? colorInput.value : '#f1c40f';
    if (!zoneName) return alert('กรุณากรอกชื่อโซน');

    const zone = document.createElement('div');
    zone.className = 'canvas-zone-tag';
    zone.style.position = 'absolute';
    zone.style.left = '30%';
    zone.style.top = '100px';
    zone.style.width = '300px';
    zone.style.height = '120px';
    zone.style.color = zoneColor;
    zone.style.border = `2px dashed ${zoneColor}`;
    zone.style.backgroundColor = getFaintBgColor(zoneColor);
    zone.style.display = 'flex';
    zone.style.alignItems = 'flex-start';
    zone.style.justifyContent = 'center';
    zone.style.paddingTop = '6px';
    zone.setAttribute('data-kind', 'zone');
    zone.setAttribute('data-color', zoneColor);
    zone.textContent = zoneName;

    setupInteractiveElement(zone);
    document.getElementById('admin-seat-canvas').appendChild(zone);
    selectAdminItem(zone);
    zoneInput.value = '';
}



// --- ระบบจองโต๊ะของลูกค้า ---
window.openUserBookingModal = async function() {
    try {
        // 1. ตรวจสอบว่าเลือกโต๊ะหรือยัง
        if (typeof selectedTables === 'undefined' || selectedTables.length === 0) {
            alert('กรุณาคลิกเลือกโต๊ะที่ต้องการจองอย่างน้อย 1 โต๊ะครับ');
            return;
        }

        // 2. คำนวณราคารวม
        let total = 0;
        if (typeof layoutData !== 'undefined' && Array.isArray(layoutData)) {
            selectedTables.forEach(code => {
                const item = layoutData.find(i => i.kind === 'table' && i.table_code === code);
                if (item) {
                    total += (typeof parsePrice === 'function') ? parsePrice(item.price) : (parseFloat(item.price) || 0);
                }
            });
        }

        // 3. แสดงเลขโต๊ะและราคารวมใน Modal
        const tableEl = document.getElementById('modal-selected-tables');
        const priceEl = document.getElementById('modal-total-price');

        if (tableEl) tableEl.textContent = selectedTables.join(', ');
        if (priceEl) priceEl.textContent = `${total.toLocaleString('th-TH')} บาท`;

        // 4. ดึงข้อมูลบัญชี/เลขพร้อมเพย์ล่าสุดจากเซิร์ฟเวอร์ แล้วสร้าง QR ตามยอดจริงของออเดอร์นี้
        try {
            const res = await fetch(`${API_BASE}/api/settings/bank`);
            const data = res.ok ? await res.json() : {};

            const bankNameElem = document.getElementById('bank-name');
            const bankNumElem = document.getElementById('bank-number');
            const accNameElem = document.getElementById('bank-account-name');
            if (bankNameElem) bankNameElem.textContent = `ธนาคาร: ${data.bank_name || 'ยังไม่ได้ตั้งค่า'}`;
            if (bankNumElem) bankNumElem.textContent = `เลขบัญชี: ${data.account_no || 'ยังไม่ได้ตั้งค่า'}`;
            if (accNameElem) accNameElem.textContent = `ชื่อบัญชี: ${data.account_name || 'ยังไม่ได้ตั้งค่า'}`;

            renderPromptPayQR(data.promptpay_id, total);
        } catch (err) {
            console.warn('โหลดข้อมูลบัญชี/พร้อมเพย์ไม่สำเร็จ:', err);
        }

        // 5. เปิด Modal
        const modal = document.getElementById('user-booking-modal');
        if (modal) {
            modal.style.display = 'flex';
        }
    } catch (err) {
        console.error('Error in openUserBookingModal:', err);
        alert('เกิดข้อผิดพลาดในการเปิดหน้าต่างจอง: ' + err.message);
    }
};

function closeUserBookingModal() {
    document.getElementById('user-booking-modal').style.display = 'none';
}

async function submitBooking(e) {
    e.preventDefault();
    const fname = document.getElementById('cust-firstname').value.trim();
    const lname = document.getElementById('cust-lastname').value.trim();
    const phone = document.getElementById('cust-phone').value.trim();
    const slipInput = document.getElementById('cust-slip');

    if (!slipInput.files || slipInput.files.length === 0) {
        return alert('กรุณาแนบสลิปการโอนเงิน');
    }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ กำลังส่งข้อมูล...';

    const formData = new FormData();
    formData.append('firstName', fname);
    formData.append('lastName', lname);
    formData.append('phone', phone);
    formData.append('tableIds', JSON.stringify(selectedTables));
    formData.append('slip', slipInput.files[0]);

    try {
        const res = await apiFetch('/api/bookings', { method: 'POST', body: formData });
        const data = await res.json();

        if (!res.ok) {
            alert('❌ ' + (data.error || 'ส่งข้อมูลไม่สำเร็จ'));
            // ถ้าโต๊ะถูกจองไปก่อนแล้ว (409) ให้รีเฟรชผังใหม่ทันทีเพื่อความถูกต้อง
            if (res.status === 409) { closeUserBookingModal(); await renderMainPageLayout(); }
            // ปิดการขาย/ขายหมดระหว่างที่ลูกค้ากำลังกรอกฟอร์ม → อัปเดตแบนเนอร์และปิดฟอร์ม
            if (res.status === 403 && (data.code === 'SALES_CLOSED' || data.code === 'SOLD_OUT')) {
                closeUserBookingModal();
                if (typeof applySalesState === 'function') applySalesState();
            }
            return;
        }

        alert(`✅ ส่งข้อมูลการจองเรียบร้อยแล้ว!\nรหัสการจอง: ${data.bookingCode}\nยอดรวม ${Number(data.totalAmount || 0).toLocaleString('th-TH')} บาท\n\nทางร้านจะตรวจสอบสลิปของท่าน เมื่ออนุมัติแล้วสามารถดูบัตรและ QR เข้างานได้ที่เมนู "ดูบัตรของฉัน" โดยกรอกชื่อ นามสกุล และเบอร์โทรที่ใช้จอง`);
        selectedTables = [];
        document.getElementById('booking-form').reset();
        closeUserBookingModal();
        await renderMainPageLayout();
    } catch (err) {
        alert('❌ ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '📤 ยืนยันและส่งสลิปการจอง';
    }
}

// (renderBookingTable() ย้ายไป admin-tools.js: ใช้ยอดเงิน total_amount ที่ server คำนวณและเก็บไว้ ไม่เดาราคาจากรหัสโต๊ะอีกต่อไป)

async function changeStatus(id, newStatus) {
    if (newStatus === 'rejected' && !confirm('คุณต้องการยกเลิก/ปฏิเสธรายการนี้ใช่หรือไม่?')) return;

    // อนุมัติ: เด้งหน้าต่างให้เลือก จ่ายแล้ว (ออกบิลทันที) / ยังไม่จ่าย (ไม่ออกบิล) — อยู่ใน admin-tools.js
    if (newStatus === 'approved') {
        const b = (window.__adminBookings || []).find(x => Number(x.id) === Number(id));
        if (!b) return alert('❌ ไม่พบรายการจองนี้ กรุณารีเฟรชหน้ารายการจอง');
        if (await btApproveFlow(b, false)) await renderBookingTable();
        return;
    }

    const res = await apiFetch(`/api/bookings/admin/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (!res.ok) return alert('❌ ' + (data.error || 'อัปเดตสถานะไม่สำเร็จ'));

    await renderBookingTable();
}

function filterBookings() {
    const searchVal = document.getElementById('booking-search').value.toLowerCase();
    const filterVal = document.getElementById('booking-status-filter').value;
    const rows = document.querySelectorAll('#full-booking-list tr');

    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        const status = row.getAttribute('data-status');
        const pay = row.getAttribute('data-pay');
        const matchesSearch = text.includes(searchVal);
        const matchesFilter = (filterVal === 'all') || (status === filterVal) || (filterVal === 'unpaid' && pay === 'unpaid');
        row.style.display = (matchesSearch && matchesFilter) ? '' : 'none';
    });
}

// --- เข้า/ออกโหมดแอดมิน (login ผ่าน backend จริง แทนรหัสผ่าน hardcode ในโค้ด) ---
function openAdminLogin() {
    document.getElementById('admin-login-modal').style.display = 'flex';
    document.getElementById('admin-login-error').textContent = '';
}

function closeAdminLoginModal() {
    document.getElementById('admin-login-modal').style.display = 'none';
}

async function submitAdminLogin(e) {
    e.preventDefault();
    const username = document.getElementById('admin-username').value.trim();
    const password = document.getElementById('admin-password').value;
    const errorEl = document.getElementById('admin-login-error');
    const btn = e.target.querySelector('button[type="submit"]');

    btn.disabled = true;
    btn.textContent = '⏳ กำลังเข้าสู่ระบบ...';

    try {
        const res = await fetch(`${API_BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (!res.ok) {
            errorEl.textContent = data.error || 'เข้าสู่ระบบไม่สำเร็จ';
            return;
        }

        setToken(data.token);
        localStorage.setItem(ROLE_KEY, data.role || 'admin');
        document.getElementById('admin-login-form').reset();
        closeAdminLoginModal();
        
        // ✅ แอดมินเข้าเมนูกลาง / พนักงานหน้างานเข้าหน้าตรวจบัตรโดยตรง
        enterAdminByRole();

    } catch (err) {
        errorEl.textContent = 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้';
    } finally {
        btn.disabled = false;
        btn.textContent = '🔐 เข้าสู่ระบบ';
    }
}
async function enterAdminMode() {
    document.querySelector('.hero-section').style.display = 'none';
    document.getElementById('table-summary-section').style.display = 'none';
    document.querySelector('.booking-section').style.display = 'none';
    document.querySelector('.rules-section').style.display = 'none';

    document.getElementById('admin-section').style.display = 'block';
    document.getElementById('admin-booking-page').style.display = 'none';
    document.getElementById('admin-poster-page').style.display = 'none';

    await refreshConcertInfo();
    await renderAdminCanvasLayout();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openBookingPage() {
    document.getElementById('admin-section').style.display = 'none';
    document.getElementById('admin-booking-page').style.display = 'block';
    
    // 🟢 เปลี่ยนกลับมาใช้ฟังก์ชันเดิมของคุณ
    if (typeof renderBookingTable === 'function') {
        renderBookingTable(); 
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeBookingPage() {
    document.getElementById('admin-booking-page').style.display = 'none';
    document.getElementById('admin-section').style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function viewSlip(imgUrl) {
    const modal = document.getElementById('slip-modal');
    const img = document.getElementById('slip-img-full');
    if (imgUrl) img.src = imgUrl;
    modal.style.display = 'flex';
}

function closeSlipModal() {
    document.getElementById('slip-modal').style.display = 'none';
}

document.getElementById('btn-save-concert')?.addEventListener('click', async () => {
    const title = document.getElementById('edit-title').value;
    const date = document.getElementById('edit-date').value;
    const priceVip = document.getElementById('edit-price-vip').value;
    const priceNormal = document.getElementById('edit-price-normal').value;
    const priceGeneral = document.getElementById('edit-price-general').value;

    const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
            concert_title: title,
            concert_date: date,
            price_vip: priceVip,
            price_normal: priceNormal,
            price_general: priceGeneral
        })
    });
    const data = await res.json();
    if (!res.ok) return alert('❌ ' + (data.error || 'บันทึกไม่สำเร็จ'));

    await refreshConcertInfo();
    await renderAdminCanvasLayout();
    await renderMainPageLayout();
    alert('💾 บันทึกข้อมูลงานคอนเสิร์ต และอัปเดตราคาบัตรเรียบร้อยแล้ว!');
});

// 🔧 เดิมโปสเตอร์เก็บไว้ใน localStorage ของเบราว์เซอร์ผู้ดูแลระบบเท่านั้น ทำให้เปลี่ยนรูปแล้ว
// คนอื่นที่เปิดลิงก์จากเครื่อง/เบราว์เซอร์อื่นไม่เห็นรูปใหม่เลย ตอนนี้เปลี่ยนมาเก็บลงฐานข้อมูลจริง
// (ตัว URL รูปเองก็อัปโหลดขึ้น Cloudinary แทนการแปลงเป็น base64 เก็บในเบราว์เซอร์ด้วย)
let posterData = [
    { id: 1, url: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=800', duration: 5, unit: 'sec' },
    { id: 2, url: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800', duration: 7, unit: 'sec' }
];
let isPosterLoop = true;
let activePosterIdx = 0;
let posterTimer = null;

function renderPosterPage() {
    const container = document.getElementById('poster-timeline-container');
    if (!container) return;
    container.innerHTML = '';

    posterData.forEach((item, index) => {
        const card = document.createElement('div');
        card.className = `poster-card ${index === activePosterIdx ? 'active-slide' : ''}`;
        card.innerHTML = `
            <img src="${item.url}" alt="Poster ${index + 1}">
            <div style="font-size: 0.8rem; font-weight: bold; color: #f1c40f;">รูปที่ ${index + 1}</div>
            <div class="poster-time-control">
                <label>เวลา:</label>
                <input type="number" min="1" value="${item.duration}" onchange="updatePosterDuration(${index}, this.value)">
                <select onchange="updatePosterUnit(${index}, this.value)">
                    <option value="sec" ${item.unit === 'sec' ? 'selected' : ''}>วินาที</option>
                    <option value="min" ${item.unit === 'min' ? 'selected' : ''}>นาที</option>
                </select>
            </div>
            <div class="poster-card-actions">
                <div>
                    <button type="button" onclick="movePoster(${index}, -1)">◀</button>
                    <button type="button" onclick="movePoster(${index}, 1)">▶</button>
                </div>
                <button type="button" class="del-btn" onclick="deletePoster(${index})">🗑️ ลบ</button>
            </div>
        `;
        container.appendChild(card);
    });

    updatePosterLivePreview();
}

function updatePosterDuration(idx, val) { posterData[idx].duration = parseInt(val) || 1; restartPosterCarousel(); }
function updatePosterUnit(idx, unit) { posterData[idx].unit = unit; restartPosterCarousel(); }

function movePoster(idx, direction) {
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= posterData.length) return;
    [posterData[idx], posterData[targetIdx]] = [posterData[targetIdx], posterData[idx]];
    renderPosterPage();
    restartPosterCarousel();
}

function deletePoster(idx) {
    if (posterData.length <= 1) return alert('ต้องมีรูปภาพอย่างน้อย 1 ภาพครับ');
    if (confirm('ต้องการลบรูปภาพนี้ใช่หรือไม่?')) {
        posterData.splice(idx, 1);
        if (activePosterIdx >= posterData.length) activePosterIdx = 0;
        renderPosterPage();
        restartPosterCarousel();
    }
}

async function handlePosterUpload(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('image', file);

        try {
            const res = await apiFetch('/api/content/poster/upload', {
                method: 'POST',
                headers: { ...authHeaders() }, // ห้ามตั้ง Content-Type เอง ต้องปล่อยให้ browser ใส่ boundary ของ FormData เอง
                body: formData
            });
            const data = await res.json();
            if (!res.ok) {
                alert('❌ อัปโหลดรูปไม่สำเร็จ: ' + (data.error || 'ไม่ทราบสาเหตุ'));
                continue;
            }
            posterData.push({ id: Date.now() + Math.random(), url: data.url, duration: 5, unit: 'sec' });
            renderPosterPage();
            restartPosterCarousel();
        } catch (err) {
            alert('❌ เกิดข้อผิดพลาดในการอัปโหลด: ' + err.message);
        }
    }

    e.target.value = ''; // ให้เลือกไฟล์เดิมซ้ำได้อีกครั้งถ้าต้องการ
}

function togglePosterLoop(val) { isPosterLoop = val; restartPosterCarousel(); }

function updatePosterLivePreview() {
    if (posterData.length === 0) return;
    const current = posterData[activePosterIdx];
    const imgEl = document.getElementById('preview-poster-img');
    const timerBadge = document.getElementById('preview-poster-timer');
    const heroImg = document.getElementById('main-hero-poster');
    if (imgEl) imgEl.src = current.url;
    if (heroImg) heroImg.src = current.url;
    if (timerBadge) {
        const unitStr = current.unit === 'min' ? 'นาที' : 'วินาที';
        timerBadge.textContent = `กำลังเล่น: รูปที่ ${activePosterIdx + 1} / ${posterData.length} (${current.duration} ${unitStr})`;
    }
    document.querySelectorAll('.poster-card').forEach((card, i) => {
        card.classList.toggle('active-slide', i === activePosterIdx);
    });
}

function restartPosterCarousel() {
    clearTimeout(posterTimer);
    if (!isPosterLoop || posterData.length <= 1) return;
    const current = posterData[activePosterIdx];
    let ms = (current.duration || 5) * 1000;
    if (current.unit === 'min') ms = ms * 60;
    posterTimer = setTimeout(() => {
        activePosterIdx = (activePosterIdx + 1) % posterData.length;
        updatePosterLivePreview();
        restartPosterCarousel();
    }, ms);
}

async function savePosterSettings() {
    try {
        const res = await apiFetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ poster_config: JSON.stringify(posterData) })
        });
        const data = await res.json();
        if (!res.ok) {
            alert('❌ บันทึกโปสเตอร์ไม่สำเร็จ: ' + (data.error || 'ไม่ทราบสาเหตุ'));
            return;
        }
        alert('💾 บันทึกโปสเตอร์คอนเสิร์ตเรียบร้อยแล้ว! ทุกคนที่เข้าเว็บจะเห็นรูปชุดนี้');
        closePosterPage();
    } catch (err) {
        alert('❌ เกิดข้อผิดพลาด: ' + err.message);
    }
}

function openPosterPage() {
    document.getElementById('admin-section').style.display = 'none';
    document.getElementById('admin-poster-page').style.display = 'block';
    renderPosterPage();
    restartPosterCarousel();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closePosterPage() {
    document.getElementById('admin-poster-page').style.display = 'none';
    document.getElementById('admin-section').style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('DOMContentLoaded', async () => {
    // 🔧 เดิมโหลดโปสเตอร์จาก localStorage (เห็นแค่เครื่องที่เคยตั้งค่าไว้) เปลี่ยนมาดึงจากฐานข้อมูลจริงแทน
    try {
        const res = await fetch(`${API_BASE}/api/settings`);
        const settings = res.ok ? await res.json() : {};
        if (settings.poster_config) {
            const parsed = JSON.parse(settings.poster_config);
            if (Array.isArray(parsed) && parsed.length > 0) posterData = parsed;
        }
    } catch (err) {
        console.warn('โหลดข้อมูลโปสเตอร์จากฐานข้อมูลไม่สำเร็จ ใช้ค่าเริ่มต้นแทน:', err);
    }

    await fetchLayout(); // 🟢 เพิ่มการดึงผังโต๊ะล่าสุดจากฐานข้อมูล
    await refreshConcertInfo();
    await renderTableSummary(); // หน้าแรกแสดงแค่จำนวนโต๊ะคงเหลือ ผังที่กดจองได้จริงจะโหลดตอนกด "จองบัตรที่นี่"
    restartPosterCarousel();

    // รีเฟรชแล้วอยู่หน้าแอดมินเดิมจนกว่าจะออกจากระบบ (ดู admin-tools.js)
    if (typeof restoreAdminSession === 'function') await restoreAdminSession();
});







// (exportToGoogleSheet() ย้ายไป admin-tools.js: อ่านข้อมูลจาก API แทนการอ่านจากเซลล์ในตาราง)

// ==========================================
// ระบบจัดการข้อมูลบัญชีธนาคาร + พร้อมเพย์ (เชื่อมกับฐานข้อมูลจริงผ่าน /api/settings)
// ==========================================

// โหลดข้อมูลบัญชี/พร้อมเพย์/ลิงก์ Google Sheet ล่าสุดมาใส่ในฟอร์มตั้งค่าฝั่งแอดมิน (เฉพาะแอดมินที่ login แล้ว)
// ลิงก์ Google Sheet ไม่ถูกเปิดให้ผู้เข้าชมทั่วไปอีกต่อไป จึงต้องดึงจาก /api/settings/admin
async function loadBankSettingsToAdminForm() {
    if (!getToken() || getRole() !== 'admin') return;
    try {
        const res = await apiFetch('/api/settings/admin', { headers: { ...authHeaders() } });
        const settings = res.ok ? await res.json() : {};

        const nameEl = document.getElementById('set-bank-name');
        const numEl = document.getElementById('set-bank-number');
        const accEl = document.getElementById('set-account-name');
        const ppEl = document.getElementById('set-promptpay-id');
        const sheetEl = document.getElementById('set-google-sheet-url');

        if (nameEl) nameEl.value = settings.bank_name || '';
        if (numEl) numEl.value = settings.bank_account_no || '';
        if (accEl) accEl.value = settings.bank_account_name || '';
        if (ppEl) ppEl.value = settings.promptpay_id || '';
        if (sheetEl) sheetEl.value = settings.google_sheet_url || '';
    } catch (err) {
        console.warn('โหลดข้อมูลบัญชีมาใส่ฟอร์มแอดมินไม่สำเร็จ:', err);
    }
}

// บันทึกข้อมูลบัญชี + เลขพร้อมเพย์ + ลิงก์ Google Sheets ลงฐานข้อมูลจริง (แอดมินเท่านั้น) - เชื่อมกับปุ่ม "บันทึกข้อมูลบัญชี"
async function saveBankSettings(event) {
    if (event) event.preventDefault();

    const bankName = document.getElementById('set-bank-name')?.value.trim() || '';
    const bankNumber = document.getElementById('set-bank-number')?.value.trim() || '';
    const accountName = document.getElementById('set-account-name')?.value.trim() || '';
    const promptpayId = document.getElementById('set-promptpay-id')?.value.trim() || '';
    const googleSheetUrl = document.getElementById('set-google-sheet-url')?.value.trim() || '';

    if (!bankName || !bankNumber || !accountName) {
        alert('⚠️ กรุณากรอกข้อมูลธนาคาร เลขบัญชี และชื่อบัญชีให้ครบถ้วนก่อนบันทึกครับ');
        return;
    }

    // ตรวจรูปแบบเลขพร้อมเพย์คร่าวๆ ถ้ามีการกรอก (เบอร์โทร 10 หลัก หรือเลขบัตร ปชช. 13 หลัก)
    if (promptpayId) {
        const digits = promptpayId.replace(/[^0-9]/g, '');
        if (!((digits.length === 10 && digits.startsWith('0')) || digits.length === 13)) {
            alert('⚠️ เลขพร้อมเพย์ต้องเป็นเบอร์โทร 10 หลัก (ขึ้นต้นด้วย 0) หรือเลขบัตรประชาชน 13 หลักเท่านั้น');
            return;
        }
    }

    // ตรวจว่าลิงก์ Google Sheets (ถ้ากรอก) ขึ้นต้นด้วย https:// จริง
    if (googleSheetUrl && !/^https:\/\//i.test(googleSheetUrl)) {
        alert('⚠️ ลิงก์ Google Sheets ต้องขึ้นต้นด้วย https:// เท่านั้น');
        return;
    }

    try {
        const res = await apiFetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
                bank_name: bankName,
                bank_account_no: bankNumber,
                bank_account_name: accountName,
                promptpay_id: promptpayId,
                google_sheet_url: googleSheetUrl
            })
        });
        const data = await res.json();
        if (!res.ok) {
            alert('❌ ' + (data.error || 'บันทึกไม่สำเร็จ'));
            return;
        }
        alert('✅ บันทึกข้อมูลบัญชีเรียบร้อยแล้ว!');
    } catch (err) {
        alert('❌ เกิดข้อผิดพลาด: ' + err.message);
    }
}

// (loadBankSettingsToAdminForm() จะถูกเรียกตอนเข้าหน้าแอดมิน ดู admin-tools.js)

// 🟢 หมุนจอ/ปรับขนาดหน้าต่าง ให้ปรับขนาดผังโต๊ะที่กำลังแสดงอยู่ใหม่ตามจอจริง
let _resizeFitTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(_resizeFitTimer);
    _resizeFitTimer = setTimeout(() => {
        const mainGrid = document.getElementById('main-seat-grid');
        const inspectCanvas = document.getElementById('inspect-seat-canvas');
        if (mainGrid && mainGrid.offsetParent !== null) fitCanvasToScreen('main-seat-grid');
        if (inspectCanvas && inspectCanvas.offsetParent !== null) fitCanvasToScreen('inspect-seat-canvas');
    }, 200);
});









// ระบบตรวจบัตรเข้าชม/เช็กอิน/Walk-in/ย้ายโต๊ะ/สแกน QR ทั้งหมดย้ายไปอยู่ที่ inspect.js

// (เดิมมีระบบแสดงรายการจองซ้ำซ้อนอีกชุดที่อ่านจาก localStorage 'user_bookings'
//  ซึ่งไม่มีทางได้รับข้อมูลการจองจริงจากลูกค้าเลย (ลูกค้าจองผ่าน API ไปเก็บใน DB)
//  ทำให้ตารางรายการจองฝั่งแอดมินขึ้นว่าง/ไม่ตรงกับความจริงอยู่เสมอ จึงตัดออก
//  ให้ใช้ renderBookingTable() ด้านบน ซึ่งดึงข้อมูลจริงจาก /api/bookings/admin แทน)



// ฟังก์ชันปิดหน้าแอดมินย่อยทั้งหมด
function hideAllAdminPages() {
    const adminPages = ['admin-hub-section', 'admin-section', 'admin-poster-page', 'admin-booking-page', 'admin-receipts-page', 'admin-archives-page'];
    adminPages.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
}

// 🟢 ฟังก์ชันสลับหน้าแอดมินย่อย (ฉบับอัปเดตเพิ่มเมนูอาหาร & ติดต่อเรา)
function openAdminSubPage(pageKey) {
    if (['layout-editor', 'poster', 'booking'].includes(pageKey)) rememberAdminPage(pageKey);
    // ซ่อนหน้าย่อยเดิมแบบปลอดภัย
    if (typeof hideAllAdminPages === 'function') {
        hideAllAdminPages();
    }

    if (pageKey === 'layout-editor') {
        const adminSec = document.getElementById('admin-section');
        if (adminSec) {
            adminSec.style.display = 'block';
            setTimeout(() => {
                if (typeof renderAdminCanvasLayout === 'function') {
                    renderAdminCanvasLayout();
                }
            }, 50);
        }
    } else if (pageKey === 'poster') {
        const posterPage = document.getElementById('admin-poster-page');
        if (posterPage) posterPage.style.display = 'block';
        if (typeof renderPosterTimeline === 'function') renderPosterTimeline();
    } else if (pageKey === 'booking') {
        const bookingPage = document.getElementById('admin-booking-page');
        if (bookingPage) bookingPage.style.display = 'block';
        if (typeof renderBookingTable === 'function') renderBookingTable();
    } else if (pageKey === 'receipts') {
        const pg = document.getElementById('admin-receipts-page');
        if (pg) pg.style.display = 'block';
        if (typeof renderReceiptPage === 'function') renderReceiptPage();
    } else if (pageKey === 'archives') {
        const pg = document.getElementById('admin-archives-page');
        if (pg) pg.style.display = 'block';
        if (typeof renderArchivePage === 'function') renderArchivePage();
    } else if (pageKey === 'menu' || pageKey === 'edit-menu' || pageKey === 'food') {
        // 🍔 เปิดหน้าต่างแก้ไขเมนูอาหาร
        if (typeof showAdminHub === 'function') showAdminHub();
        if (typeof openEditMenuModal === 'function') openEditMenuModal();
    } else if (pageKey === 'contact' || pageKey === 'edit-contact') {
        // 📞 เปิดหน้าต่างแก้ไขติดต่อเรา
        if (typeof showAdminHub === 'function') showAdminHub();
        if (typeof openEditContactModal === 'function') openEditContactModal();
    } else {
        alert('ระบบส่วนนี้กำลังอยู่ระหว่างการพัฒนา');
        if (typeof showAdminHub === 'function') showAdminHub();
    }
}


// 1. ฟังก์ชันเปิดหน้า Central Hub (ซ่อนส่วนฝั่งลูกค้าทั้งหมดอย่างหมดจด)
function showAdminHub() {
    hideAllAdminPages();
    rememberAdminPage('hub');
    
    // แสดงหน้า Admin Central Hub
    const hub = document.getElementById('admin-hub-section');
    if (hub) hub.style.display = 'block';

    // 🔴 รายการ Selector ฝั่งลูกค้าที่สั่งซ่อน (เพิ่ม ID ของผังโต๊ะทุกแบบที่นิยมใช้)
    const clientSelectors = [
        '#concert',
        '#table-summary-section',
        '#table-layout-section',
        '#booking-section',
        '#booking-container',
        '#table-container',
        '.rules-section',
        'header',
        'nav',
        '.navbar'
    ];

    clientSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => {
            el.style.display = 'none';
        });
    });
}

// 2. ออกจากโหมดแอดมิน/พนักงาน: ล้าง token + หน้าที่จำไว้ แล้วกลับสู่หน้าแรกฝั่งลูกค้า
// (ต้องล้าง token ด้วย ไม่งั้นพอรีเฟรชระบบจะพากลับเข้าหน้าแอดมินอัตโนมัติ)
function closeAdmin() {
    if (typeof stopInspectPolling === 'function') stopInspectPolling();
    if (typeof closeScanOverlay === 'function') closeScanOverlay();
    clearToken();
    hideAllAdminPages();
    const insp = document.getElementById('inspect-section');
    if (insp) insp.style.display = 'none';
    try { deselectAdminItem(); } catch (_) { /* ไม่ได้อยู่หน้าแก้ผัง */ }
    
    // 🟢 แสดงองค์ประกอบหลักฝั่งลูกค้ากลับมา
    const clientSelectors = [
        '#concert',
        '#table-summary-section',
        '.rules-section',
        'header',
        'nav',
        '.navbar'
    ];

    clientSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => {
            el.style.display = '';
        });
    });

    // 🔴 บังคับซ่อนโซนผังโต๊ะไว้เสมอ เพื่อป้องกันไม่ให้ผังโต๊ะเด้งขึ้นมาแซกหน้าแรก
    const tableSelectors = [
        '#table-layout-section',
        '#booking-section',
        '#booking-container',
        '#table-container'
    ];
    
    tableSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => {
            el.style.display = 'none';
        });
    });

    showHomeView();
}

// 🟢 เปิดหน้าตรวจบัตรเฉพาะจาก Admin Hub
function openAdminInspect() {
    const hub = document.getElementById('admin-hub-section');
    if (hub) hub.style.display = 'none';

    if (typeof showTicketView === 'function') {
        showTicketView();
    } else {
        const inspectSec = document.getElementById('inspect-section');
        if (inspectSec) inspectSec.style.display = 'block';
    }
}

// 🟢 เปิดหน้าแก้ไขผังโต๊ะ
// 🔧 เดิมฟังก์ชันนี้เรียก renderAdminLayout() ซึ่งไม่มีอยู่จริงในไฟล์นี้ (typo ของ renderAdminCanvasLayout)
// ทำให้ canvas เปิดมาว่างเปล่าทุกครั้ง แล้วพอกด "บันทึกผัง" ระบบจะเข้าใจว่าโต๊ะ/โซนทั้งหมดถูกลบออก
// จึงลบข้อมูลจริงในฐานข้อมูลทิ้งหมด นี่คือสาเหตุที่ "รีเซ็ตแล้วข้อมูลโต๊ะหรือโซนหายตลอด"
// แก้โดยให้ใช้ path เดียวกับ openAdminSubPage('layout-editor') ซึ่งเรียก renderAdminCanvasLayout() ที่ถูกต้องอยู่แล้ว
function openLayoutEditor() {
    openAdminSubPage('layout-editor');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// endConcertWithAuth(), saveBookingRules(), renderBookingRules() ย้ายไป admin-tools.js
