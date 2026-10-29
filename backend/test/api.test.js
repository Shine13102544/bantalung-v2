const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const { setupEnv, stubCloudinary, fakeJpeg } = require('./helpers');

setupEnv();
const cloud = stubCloudinary();
const { initDatabase, dbRun, dbGet, dbAll, SCHEMA_VERSION } = require('../db/database');
const app = require('../server');

let server, base;
const tokens = {};

async function api(method, url, { token, json, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const res = await fetch(base + url, { method, headers, body });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
}

function bookingForm({ first = 'สมชาย', last = 'ใจดี', phone = '081-234-5678', tables = ['VIP-01'], file = fakeJpeg(), type = 'image/jpeg' } = {}) {
    const f = new FormData();
    f.set('firstName', first); f.set('lastName', last); f.set('phone', phone);
    f.set('tableIds', JSON.stringify(tables));
    if (file) f.set('slip', new Blob([file], { type }), 'slip.jpg');
    return f;
}

before(async () => {
    await initDatabase();
    await dbRun('INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)', ['boss', bcrypt.hashSync('correct-horse-123', 4), 'admin']);
    await dbRun('INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)', ['door', bcrypt.hashSync('door-password-123', 4), 'staff']);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('migration: บันทึกเวอร์ชัน schema และรันซ้ำได้โดยไม่ทำอะไรเพิ่ม', async () => {
    const v = await dbGet("SELECT value FROM settings WHERE key = 'schema_version'");
    assert.equal(Number(v.value), SCHEMA_VERSION);
    const before = await dbGet('SELECT COUNT(*) AS c FROM layout_items');
    await initDatabase();
    const after = await dbGet('SELECT COUNT(*) AS c FROM layout_items');
    assert.equal(Number(before.c), Number(after.c));
    assert.ok(Number(before.c) >= 8, 'ต้องมีผังตัวอย่างและเวที');
});

test('auth: login ผิด/ถูก, role, /me, และ token ปลอมถูกปฏิเสธ', async () => {
    let r = await api('POST', '/api/auth/login', { json: { username: 'boss', password: 'wrong' } });
    assert.equal(r.status, 401);
    r = await api('POST', '/api/auth/login', { json: { username: 'nobody', password: 'x' } });
    assert.equal(r.status, 401);
    assert.equal(r.data.error, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');

    r = await api('POST', '/api/auth/login', { json: { username: 'boss', password: 'correct-horse-123' } });
    assert.equal(r.status, 200); assert.equal(r.data.role, 'admin'); tokens.admin = r.data.token;
    r = await api('POST', '/api/auth/login', { json: { username: 'door', password: 'door-password-123' } });
    assert.equal(r.data.role, 'staff'); tokens.staff = r.data.token;

    r = await api('GET', '/api/auth/me', { token: tokens.staff });
    assert.equal(r.status, 200); assert.equal(r.data.role, 'staff');
    r = await api('GET', '/api/auth/me', { token: 'abc.def.ghi' });
    assert.equal(r.status, 401);
});

test('auth: ล็อกการเดารหัสผ่านต่อชื่อผู้ใช้ (ตัวนับใน DB) หลังผิด 8 ครั้ง', async () => {
    let last;
    for (let i = 0; i < 10; i++) last = await api('POST', '/api/auth/login', { json: { username: 'victim', password: 'x' + i } });
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
});

test('สิทธิ์: พนักงานทำรายการของแอดมินไม่ได้', async () => {
    assert.equal((await api('GET', '/api/settings/admin', { token: tokens.staff })).status, 403);
    assert.equal((await api('POST', '/api/bookings/end-concert', { token: tokens.staff, json: { password: 'x' } })).status, 403);
    assert.equal((await api('PATCH', '/api/bookings/admin/1/status', { token: tokens.staff, json: { status: 'approved' } })).status, 403);
    assert.equal((await api('GET', '/api/bookings/admin')).status, 401);
});

test('settings: สาธารณะไม่เห็น google_sheet_url, แอดมินเห็น, ตรวจค่าที่ผิด', async () => {
    let r = await api('PUT', '/api/settings', { token: tokens.admin, json: { google_sheet_url: 'https://script.google.com/macros/s/abc/exec', concert_title: '<b>คอนเสิร์ต</b>' } });
    assert.equal(r.status, 200);
    r = await api('GET', '/api/settings');
    assert.equal(r.data.google_sheet_url, undefined);
    assert.equal(r.data.concert_title, 'คอนเสิร์ต');
    r = await api('GET', '/api/settings/admin', { token: tokens.admin });
    assert.ok(r.data.google_sheet_url.startsWith('https://script.google.com'));

    assert.equal((await api('PUT', '/api/settings', { token: tokens.admin, json: { google_sheet_url: 'javascript:alert(1)' } })).status, 400);
    assert.equal((await api('PUT', '/api/settings', { token: tokens.admin, json: { sales_status: 'weird' } })).status, 400);
    assert.equal((await api('PUT', '/api/settings', { token: tokens.admin, json: { max_tables_per_booking: '0' } })).status, 400);

    r = await api('PUT', '/api/settings', { token: tokens.admin, json: { booking_rules: JSON.stringify(['กฎข้อ 1 <script>x</script>', 'กฎข้อ 2']) } });
    assert.equal(r.status, 200);
    r = await api('GET', '/api/settings');
    assert.deepEqual(JSON.parse(r.data.booking_rules), ['กฎข้อ 1', 'กฎข้อ 2']);
});

test('booking: จองสำเร็จ คำนวณยอดที่ server และเก็บราคา ณ วันจอง', async () => {
    const r = await api('POST', '/api/bookings', { form: bookingForm({ tables: ['VIP-01', 'A-01'] }) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.totalAmount, 2500 + 1200);
    assert.match(r.data.bookingCode, /^BK-\d{4}-[0-9A-F]{4}$/);
    assert.equal(cloud.calls?.length, undefined);
    assert.equal(cloud.uploaded.at(-1).private, true, 'สลิปต้องอัปโหลดแบบ private');

    const b = await dbGet('SELECT * FROM bookings WHERE booking_code = ?', [r.data.bookingCode]);
    assert.equal(b.phone, '0812345678', 'เบอร์ถูกแปลงเป็นตัวเลขล้วน');
    assert.equal(b.status, 'pending');
    assert.match(b.ticket_token, /^[0-9a-f]{32}$/);
    const prices = await dbAll('SELECT price FROM booking_tables WHERE booking_id = ? ORDER BY id', [b.id]);
    assert.deepEqual(prices.map(p => Number(p.price)), [2500, 1200]);
});

test('booking: โต๊ะซ้ำ → 409 และไม่ทิ้งสลิปค้าง', async () => {
    const uploadedBefore = cloud.uploaded.length;
    const destroyedBefore = cloud.destroyed.length;
    const r = await api('POST', '/api/bookings', { form: bookingForm({ first: 'คนอื่น', phone: '0899999999', tables: ['VIP-01'] }) });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'TABLE_TAKEN');
    // ตรวจเจอตั้งแต่ก่อนอัปโหลด จึงไม่ควรมีการอัปโหลดเพิ่ม
    assert.equal(cloud.uploaded.length, uploadedBefore);
    assert.equal(cloud.destroyed.length, destroyedBefore);
});

test('booking: ตรวจข้อมูลไม่ผ่านต้องไม่อัปโหลดสลิป', async () => {
    const up = cloud.uploaded.length;
    assert.equal((await api('POST', '/api/bookings', { form: bookingForm({ tables: ['A-02'], file: Buffer.from('not an image at all, plain text!!') }) })).status, 400);
    assert.equal((await api('POST', '/api/bookings', { form: bookingForm({ tables: ['A-02'], type: 'text/plain' }) })).status, 400);
    assert.equal((await api('POST', '/api/bookings', { form: bookingForm({ tables: ['A-02'], phone: '12' }) })).status, 400);
    assert.equal((await api('POST', '/api/bookings', { form: bookingForm({ tables: ['A-02', 'A-02'] }) })).status, 400);
    assert.equal((await api('POST', '/api/bookings', { form: bookingForm({ tables: ['NOPE-99'] }) })).status, 400);
    assert.equal((await api('POST', '/api/bookings', { form: bookingForm({ tables: ['A-02'], file: null }) })).status, 400);
    assert.equal(cloud.uploaded.length, up);
});

test('booking: จำกัดจำนวนโต๊ะต่อการจอง และจำกัดรายการรอตรวจต่อเบอร์', async () => {
    await api('PUT', '/api/settings', { token: tokens.admin, json: { max_tables_per_booking: '1' } });
    let r = await api('POST', '/api/bookings', { form: bookingForm({ phone: '0811111111', tables: ['A-02', 'A-03'] }) });
    assert.equal(r.status, 400); assert.match(r.data.error, /สูงสุด 1 โต๊ะ/);
    await api('PUT', '/api/settings', { token: tokens.admin, json: { max_tables_per_booking: '8' } });

    r = await api('POST', '/api/bookings', { form: bookingForm({ phone: '0822222222', tables: ['A-02'] }) });
    assert.equal(r.status, 201);
    r = await api('POST', '/api/bookings', { form: bookingForm({ phone: '082-222-2222', tables: ['A-03'] }) });
    assert.equal(r.status, 201);
    r = await api('POST', '/api/bookings', { form: bookingForm({ phone: '+66822222222', tables: ['A-04'] }) });
    assert.equal(r.status, 429); assert.equal(r.data.code, 'TOO_MANY_PENDING');
});

test('ปิดการขาย/ขายหมด: บังคับที่ server', async () => {
    await api('PUT', '/api/settings', { token: tokens.admin, json: { sales_status: 'closed' } });
    let r = await api('POST', '/api/bookings', { form: bookingForm({ phone: '0833333333', tables: ['A-04'] }) });
    assert.equal(r.status, 403); assert.equal(r.data.code, 'SALES_CLOSED');
    r = await api('GET', '/api/settings/sales'); assert.equal(r.data.open, false);

    await api('PUT', '/api/settings', { token: tokens.admin, json: { sales_status: 'soldout' } });
    r = await api('POST', '/api/bookings', { form: bookingForm({ phone: '0833333333', tables: ['A-04'] }) });
    assert.equal(r.data.code, 'SOLD_OUT');

    // เวลาปิดขายอัตโนมัติ (เวลาไทย)
    await api('PUT', '/api/settings', { token: tokens.admin, json: { sales_status: 'open', sales_close_at: '2000-01-01T00:00' } });
    r = await api('GET', '/api/settings/sales'); assert.equal(r.data.open, false);
    await api('PUT', '/api/settings', { token: tokens.admin, json: { sales_close_at: '' } });
    r = await api('GET', '/api/settings/sales'); assert.equal(r.data.open, true);
});

test('admin list: พนักงานเห็นเบอร์แบบปิดบัง ไม่เห็นสลิป/token, แอดมินเห็นครบ', async () => {
    let r = await api('GET', '/api/bookings/admin', { token: tokens.admin });
    assert.equal(r.status, 200);
    const first = r.data.find(b => b.tableList.includes('VIP-01'));
    assert.deepEqual(first.tableList, ['VIP-01', 'A-01']);
    assert.equal(first.tables, 'VIP-01, A-01');
    assert.equal(first.phone, '0812345678');
    assert.equal(first.total_amount, 3700);
    assert.ok(first.slipUrl.startsWith('https://signed.example/'));
    assert.match(first.ticket_token, /^[0-9a-f]{32}$/);
    tokens.firstId = first.id; tokens.firstToken = first.ticket_token;

    r = await api('GET', '/api/bookings/admin', { token: tokens.staff });
    const s = r.data.find(b => b.id === tokens.firstId);
    assert.equal(s.phone, '08x-xxx-5678');
    assert.equal(s.slipUrl, null);
    assert.equal(s.ticket_token, undefined);
});

test('สแกนบัตร: ยังไม่อนุมัติ → NOT_APPROVED, อนุมัติแล้ว → OK ครั้งเดียว แล้ว ALREADY', async () => {
    const tk = tokens.firstToken;
    let r = await api('POST', '/api/bookings/staff/scan', { token: tokens.staff, json: { token: 'BT1:' + tk } });
    assert.equal(r.data.result, 'NOT_APPROVED');
    assert.equal(r.data.name, 'สมชาย ใจดี');

    // พนักงานเช็กอินรายการที่ยังไม่อนุมัติไม่ได้
    r = await api('PATCH', `/api/bookings/admin/${tokens.firstId}/checkin`, { token: tokens.staff, json: { checked_in: true } });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'NOT_APPROVED');

    assert.equal((await api('PATCH', `/api/bookings/admin/${tokens.firstId}/status`, { token: tokens.admin, json: { status: 'approved', paymentStatus: 'unpaid' } })).status, 200);

    r = await api('POST', '/api/bookings/staff/scan', { token: tokens.staff, json: { token: tk } });
    assert.equal(r.data.result, 'OK'); assert.deepEqual(r.data.tables, ['VIP-01', 'A-01']);

    // สแกนพร้อมกัน 5 เครื่อง ต้องผ่านได้แค่ 1
    const results = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/api/bookings/staff/scan', { token: tokens.staff, json: { token: tk } })));
    assert.ok(results.every(x => x.data.result === 'ALREADY'));

    r = await api('POST', '/api/bookings/staff/scan', { token: tokens.staff, json: { token: 'f'.repeat(32) } });
    assert.equal(r.data.result, 'NOT_FOUND');
    r = await api('POST', '/api/bookings/staff/scan', { token: tokens.staff, json: { token: 'zzz' } });
    assert.equal(r.data.result, 'NOT_FOUND');
});

test('สแกนพร้อมกัน: ผู้ชนะมีแค่คนเดียว', async () => {
    const r = await api('POST', '/api/bookings', { form: bookingForm({ first: 'แข่ง', phone: '0877777777', tables: ['VIP-04'] }) });
    const b = await dbGet('SELECT id, ticket_token FROM bookings WHERE booking_code = ?', [r.data.bookingCode]);
    await api('PATCH', `/api/bookings/admin/${b.id}/status`, { token: tokens.admin, json: { status: 'approved', paymentStatus: 'unpaid' } });
    const results = await Promise.all(Array.from({ length: 8 }, () => api('POST', '/api/bookings/staff/scan', { token: tokens.staff, json: { token: b.ticket_token } })));
    assert.equal(results.filter(x => x.data.result === 'OK').length, 1);
    assert.equal(results.filter(x => x.data.result === 'ALREADY').length, 7);
});

test('ดูบัตรของฉัน: ต้องตรงทั้งชื่อ นามสกุล เบอร์ (รับเบอร์หลายรูปแบบ) และล็อกเมื่อเดาผิดหลายครั้ง', async () => {
    let r = await api('POST', '/api/tickets/lookup', { json: { firstName: 'สมชาย', lastName: 'ใจดี', phone: '+66 81 234 5678' } });
    assert.equal(r.status, 200);
    const t = r.data.bookings[0];
    assert.equal(t.status, 'approved'); assert.equal(t.ticketToken, tokens.firstToken); assert.equal(t.checkedIn, true);
    assert.deepEqual(t.tables, ['VIP-01', 'A-01']);

    // การจองที่ยังไม่อนุมัติ: เห็นสถานะแต่ไม่ได้ QR
    r = await api('POST', '/api/tickets/lookup', { json: { firstName: 'สมชาย', lastName: 'ใจดี', phone: '0822222222' } });
    assert.equal(r.status, 200);
    assert.ok(r.data.bookings.every(b => b.status === 'pending' && b.ticketToken === null));
    // ชื่อตรงแต่เบอร์ไม่ตรง → ไม่พบ
    r = await api('POST', '/api/tickets/lookup', { json: { firstName: 'สมชาย', lastName: 'ใจดี', phone: '0899990000' } });
    assert.equal(r.status, 404);
    r = await api('POST', '/api/tickets/lookup', { json: { firstName: 'สมชาย', lastName: 'ใจดี', phone: '0812345678' } });
    assert.equal(r.status, 200);

    // เดาผิดซ้ำๆ ที่เบอร์เดียวกัน
    let last;
    for (let i = 0; i < 7; i++) last = await api('POST', '/api/tickets/lookup', { json: { firstName: 'ผิด' + i, lastName: 'ผิด', phone: '0812345678' } });
    assert.equal(last.status, 429);
    // ล็อกแล้ว แม้กรอกถูกก็ต้องรอ
    r = await api('POST', '/api/tickets/lookup', { json: { firstName: 'สมชาย', lastName: 'ใจดี', phone: '0812345678' } });
    assert.equal(r.status, 429);

    // เปิดจากลิงก์ token
    r = await api('GET', '/api/tickets/' + tokens.firstToken);
    assert.equal(r.status, 200);
    assert.equal((await api('GET', '/api/tickets/' + 'a'.repeat(32))).status, 404);
    assert.equal((await api('GET', '/api/tickets/short')).status, 404);
});

test('ย้ายโต๊ะ: ย้ายไปโต๊ะว่าง, ชนกัน 409, เก็บประวัติ, ปรับยอดตามราคาใหม่ได้', async () => {
    const id = tokens.firstId;
    // ไปโต๊ะที่มีคนจองอยู่
    let r = await api('POST', `/api/bookings/admin/${id}/move`, { token: tokens.staff, json: { fromCode: 'A-01', toCode: 'VIP-04' } });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'TABLE_TAKEN');
    // ต้นทางไม่ใช่ของการจองนี้
    r = await api('POST', `/api/bookings/admin/${id}/move`, { token: tokens.staff, json: { fromCode: 'A-02', toCode: 'VIP-02' } });
    assert.equal(r.status, 400);

    // ย้ายข้ามโซน คงยอดเดิม (ค่าเริ่มต้น)
    r = await api('POST', `/api/bookings/admin/${id}/move`, { token: tokens.staff, json: { fromCode: 'A-01', toCode: 'VIP-02' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.priceDiff, 1300); assert.equal(r.data.adjusted, false); assert.equal(r.data.totalAmount, 3700);

    let list = (await api('GET', '/api/bookings/admin', { token: tokens.admin })).data.find(b => b.id === id);
    assert.deepEqual(list.tableList, ['VIP-01', 'VIP-02']);
    assert.equal(list.status, 'approved'); assert.equal(list.checked_in, 1); assert.equal(list.ticket_token, tokens.firstToken);
    // โต๊ะเดิมกลับเป็นว่าง
    const layout = (await api('GET', '/api/layout')).data;
    assert.equal(layout.find(i => i.table_code === 'A-01').booking_status, 'available');
    assert.equal(layout.find(i => i.table_code === 'VIP-02').booking_status, 'approved');

    // ย้ายต่อพร้อมปรับยอดตามราคาโต๊ะใหม่: ยอดอิงราคาที่ชำระไว้เดิม (1,200) → ราคาโต๊ะ VIP (2,500)
    r = await api('POST', `/api/bookings/admin/${id}/move`, { token: tokens.admin, json: { fromCode: 'VIP-02', toCode: 'VIP-03', adjustPrice: true } });
    assert.equal(r.status, 200); assert.equal(r.data.priceDiff, 1300); assert.equal(r.data.adjusted, true); assert.equal(r.data.totalAmount, 5000);
    const snap = await dbAll('SELECT price FROM booking_tables WHERE booking_id = ? ORDER BY id', [id]);
    assert.deepEqual(snap.map(x => Number(x.price)), [2500, 2500]);

    // ย้ายกลับไป A-01 พร้อมปรับยอดลง
    r = await api('POST', `/api/bookings/admin/${id}/move`, { token: tokens.admin, json: { fromCode: 'VIP-03', toCode: 'A-01', adjustPrice: true } });
    assert.equal(r.status, 200); assert.equal(r.data.priceDiff, -1300); assert.equal(r.data.totalAmount, 3700);
    const moves = await dbAll('SELECT * FROM booking_moves WHERE booking_id = ? ORDER BY id', [id]);
    assert.equal(moves.length, 3); assert.equal(moves[2].moved_by, 'boss');

    // การจองที่ถูกปฏิเสธย้ายไม่ได้
    const rej = await dbGet("SELECT id FROM bookings WHERE phone = '0822222222' ORDER BY id LIMIT 1");
    await api('PATCH', `/api/bookings/admin/${rej.id}/status`, { token: tokens.admin, json: { status: 'rejected' } });
    r = await api('POST', `/api/bookings/admin/${rej.id}/move`, { token: tokens.staff, json: { fromCode: 'A-02', toCode: 'B-99' } });
    assert.equal(r.status, 409);
});

test('walk-in: รหัสไม่ชนกัน, เก็บยอดและวิธีชำระ, โต๊ะซ้ำ 409', async () => {
    let r = await api('POST', '/api/bookings/admin/walkin', { token: tokens.staff, json: { tableCode: 'A-02', paymentMethod: 'cash', firstName: 'หน้างาน' } });
    assert.equal(r.status, 201); assert.match(r.data.bookingCode, /^WALK-[0-9A-F]{6}$/);
    assert.equal(r.data.totalAmount, 1200); assert.equal(r.data.paymentMethod, 'cash');
    r = await api('POST', '/api/bookings/admin/walkin', { token: tokens.staff, json: { tableCode: 'A-02' } });
    assert.equal(r.status, 409);
    r = await api('POST', '/api/bookings/admin/walkin', { token: tokens.staff, json: { tableCode: 'A-03', phone: 'abc' } });
    assert.equal(r.status, 400);
    const codes = new Set();
    for (let i = 0; i < 30; i++) {
        const g = require('../utils/bookings').genWalkinCode(); assert.ok(!codes.has(g)); codes.add(g);
    }
});

test('ยกเลิก Walk-in: เฉพาะ WALK-, พนักงานยกเลิกได้ภายใน 30 นาที, โต๊ะกลับเป็นว่าง', async () => {
    let r = await api('POST', '/api/bookings/admin/walkin', { token: tokens.staff, json: { tableCode: 'VIP-03', firstName: 'ผิดโต๊ะ' } });
    assert.equal(r.status, 201);
    const wid = r.data.bookingId;
    let layout = (await api('GET', '/api/layout')).data;
    assert.equal(layout.find(i => i.table_code === 'VIP-03').booking_status, 'approved');

    // การจองปกติ (ไม่ใช่ WALK-) ยกเลิกด้วยวิธีนี้ไม่ได้
    assert.equal((await api('POST', `/api/bookings/admin/${tokens.firstId}/cancel-walkin`, { token: tokens.staff })).status, 400);

    // รายการเก่าเกิน 30 นาที: พนักงานยกเลิกไม่ได้ แอดมินยกเลิกได้
    await dbRun("UPDATE bookings SET created_at = datetime('now', '-2 hours') WHERE id = ?", [wid]);
    r = await api('POST', `/api/bookings/admin/${wid}/cancel-walkin`, { token: tokens.staff });
    assert.equal(r.status, 403); assert.equal(r.data.code, 'TOO_OLD');
    await dbRun("UPDATE bookings SET created_at = datetime('now') WHERE id = ?", [wid]);

    r = await api('POST', `/api/bookings/admin/${wid}/cancel-walkin`, { token: tokens.staff });
    assert.equal(r.status, 200);
    layout = (await api('GET', '/api/layout')).data;
    assert.equal(layout.find(i => i.table_code === 'VIP-03').booking_status, 'available');
    assert.equal((await api('POST', `/api/bookings/admin/${wid}/cancel-walkin`, { token: tokens.staff })).status, 409);
});

test('ใบเสร็จ: ออกได้เฉพาะที่อนุมัติ, ไม่ซ้ำ, เลขต่อเนื่อง, void แล้วออกใหม่ได้', async () => {
    const pending = await dbGet("SELECT id FROM bookings WHERE status = 'pending' LIMIT 1");
    if (pending) assert.equal((await api('POST', '/api/receipts', { token: tokens.admin, json: { bookingId: pending.id } })).status, 409);

    let r = await api('POST', '/api/receipts', { token: tokens.admin, json: { bookingId: tokens.firstId, note: 'ชำระแล้ว' } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const year = new Date(Date.now() + 7 * 3600e3).getUTCFullYear();
    assert.equal(r.data.receipt_no, `R${year}-0001`);
    assert.equal(r.data.amount, 3700); assert.equal(r.data.tables, 'VIP-01, A-01');
    const rid = r.data.id;

    assert.equal((await api('POST', '/api/receipts', { token: tokens.admin, json: { bookingId: tokens.firstId } })).data.code, 'ALREADY_ISSUED');
    assert.equal((await api('POST', `/api/receipts/${rid}/void`, { token: tokens.admin, json: { reason: '' } })).status, 400);
    assert.equal((await api('POST', `/api/receipts/${rid}/void`, { token: tokens.admin, json: { reason: 'ยอดผิด' } })).status, 200);
    assert.equal((await api('POST', `/api/receipts/${rid}/void`, { token: tokens.admin, json: { reason: 'ซ้ำ' } })).status, 404);

    r = await api('POST', '/api/receipts', { token: tokens.admin, json: { bookingId: tokens.firstId, amount: 2000 } });
    assert.equal(r.status, 201); assert.equal(r.data.receipt_no, `R${year}-0002`); assert.equal(r.data.amount, 2000);
    assert.equal((await api('GET', '/api/receipts', { token: tokens.staff })).status, 403);
});

test('layout: ตรวจค่าที่ผิด/อันตราย, ลบโต๊ะที่มีการจองไม่ได้', async () => {
    const layout = (await api('GET', '/api/layout')).data;
    const ok = layout.map(({ booking_status, checked_in, ...rest }) => rest);
    assert.equal((await api('PUT', '/api/layout', { token: tokens.admin, json: { items: ok } })).status, 200);

    const bad = (patch) => ok.map((i, idx) => idx === 3 ? { ...i, ...patch } : i);
    assert.equal((await api('PUT', '/api/layout', { token: tokens.admin, json: { items: bad({ color: 'red;background:url(//evil)' }) } })).status, 400);
    assert.equal((await api('PUT', '/api/layout', { token: tokens.admin, json: { items: bad({ pos_left: '10px;position:fixed' }) } })).status, 400);
    assert.equal((await api('PUT', '/api/layout', { token: tokens.admin, json: { items: bad({ table_code: 'A,B' }) } })).status, 400);
    // ลบโต๊ะที่ไม่มีการจอง (A-04) ได้
    const noA04 = ok.filter(i => i.table_code !== 'A-04');
    assert.equal((await api('PUT', '/api/layout', { token: tokens.admin, json: { items: noA04 } })).status, 200);
    assert.ok(!(await api('GET', '/api/layout')).data.some(i => i.table_code === 'A-04'));
});

test('layout: ลบโต๊ะที่มีการจองค้างอยู่ → 409', async () => {
    const layout = (await api('GET', '/api/layout')).data;
    const withoutBooked = layout.filter(i => i.table_code !== 'VIP-01').map(({ booking_status, checked_in, ...rest }) => rest);
    const r = await api('PUT', '/api/layout', { token: tokens.admin, json: { items: withoutBooked } });
    assert.equal(r.status, 409);
});

test('contact: ลิงก์ต้องเป็น http/https', async () => {
    assert.equal((await api('POST', '/api/content/contact/save', { token: tokens.admin, json: { facebook: 'javascript:alert(1)' } })).status, 400);
    assert.equal((await api('POST', '/api/content/contact/save', { token: tokens.admin, json: { facebook: 'facebook.com/bantalung', google_maps_url: 'https://maps.google.com/?q=1' } })).status, 200);
    const c = (await api('GET', '/api/content/contact')).data;
    assert.equal(c.facebook, 'https://facebook.com/bantalung');
});

test('end-concert: ต้องยืนยันรหัสผ่านที่ server, สำรองก่อนลบ, CSV ใช้ได้, ผังและใบเสร็จยังอยู่', async () => {
    let r = await api('POST', '/api/bookings/end-concert', { token: tokens.admin, json: {} });
    assert.equal(r.status, 400);
    r = await api('POST', '/api/bookings/end-concert', { token: tokens.admin, json: { password: 'wrong' } });
    assert.equal(r.status, 403); assert.equal(r.data.code, 'WRONG_PASSWORD'); // ไม่ใช่ 401 จะได้ไม่ถูกเด้งออกจากระบบ
    assert.ok(Number((await dbGet('SELECT COUNT(*) AS c FROM bookings')).c) > 0, 'รหัสผิดต้องไม่ลบอะไร');

    const csv = await api('GET', '/api/bookings/admin/export.csv', { token: tokens.admin });
    assert.equal(csv.status, 200); assert.match(csv.data, /VIP-01/);
    // fetch().text() ตัด BOM ทิ้ง จึงตรวจจาก byte จริง: ต้องมี BOM (EF BB BF) เพื่อให้ Excel อ่านภาษาไทยถูก
    const raw = Buffer.from(await (await fetch(base + '/api/bookings/admin/export.csv', { headers: { Authorization: 'Bearer ' + tokens.admin } })).arrayBuffer());
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

    const total = Number((await dbGet('SELECT COUNT(*) AS c FROM bookings')).c);
    r = await api('POST', '/api/bookings/end-concert', { token: tokens.admin, json: { password: 'correct-horse-123' } });
    assert.equal(r.status, 200); assert.equal(r.data.archivedBookings, total);
    assert.equal(Number((await dbGet('SELECT COUNT(*) AS c FROM bookings')).c), 0);
    assert.equal(Number((await dbGet('SELECT COUNT(*) AS c FROM booking_tables')).c), 0);
    assert.ok(Number((await dbGet('SELECT COUNT(*) AS c FROM layout_items')).c) > 5, 'ผังต้องอยู่ครบ');
    assert.ok(Number((await dbGet('SELECT COUNT(*) AS c FROM receipts')).c) >= 2, 'ใบเสร็จต้องอยู่ครบ');

    const arch = await api('GET', '/api/bookings/admin/archives', { token: tokens.admin });
    assert.equal(arch.data.length, 1); assert.equal(arch.data[0].booking_count, total);
    const acsv = await api('GET', `/api/bookings/admin/archives/${r.data.archiveId}/csv`, { token: tokens.admin });
    assert.match(acsv.data, /VIP-01/);

    // ลบรูปสลิปที่สำรองไว้ (ทำทีละชุด)
    const before = cloud.destroyed.length;
    let p = await api('POST', `/api/bookings/admin/archives/${r.data.archiveId}/purge-slips`, { token: tokens.admin });
    assert.equal(p.status, 200); assert.equal(p.data.remaining, 0);
    assert.ok(cloud.destroyed.length > before);
    assert.ok(cloud.destroyed.slice(before).every(d => d.private === true));
});

test('ข้อผิดพลาด: ไม่เปิดเผยข้อความภายใน และ JSON เสียได้ 400', async () => {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
    assert.equal(res.status, 400);
    assert.equal((await api('GET', '/api/nope')).status, 404);
});


test('สถานะชำระเงิน: อนุมัติต้องเลือก จ่ายแล้ว/ยังไม่จ่าย, จ่ายแล้วออกบิลทันที, ยังไม่จ่ายไม่ออกบิล, รับชำระทีหลังได้, void แล้วกลับเป็นยังไม่จ่าย', async () => {
    for (const code of ['B-01', 'B-02', 'B-03']) {
        await dbRun("INSERT INTO layout_items (kind, table_code, zone_type, price) VALUES ('table', ?, 'normal', '1,000฿')", [code]);
    }
    const mk = async (first, phone, tables) => {
        const r = await api('POST', '/api/bookings', { form: bookingForm({ first, phone, tables }) });
        assert.equal(r.status, 201, JSON.stringify(r.data));
        return dbGet('SELECT id, ticket_token, booking_code FROM bookings WHERE booking_code = ?', [r.data.bookingCode]);
    };
    const bk = await mk('จ่าย', '0861111111', ['B-01']);
    const bk2 = await mk('ค้าง', '0862222222', ['B-02']);

    // ไม่ส่ง paymentStatus ตอนอนุมัติ = 400 (ต้องเลือก)
    let r = await api('PATCH', `/api/bookings/admin/${bk.id}/status`, { token: tokens.admin, json: { status: 'approved' } });
    assert.equal(r.status, 400);
    r = await api('PATCH', `/api/bookings/admin/${bk.id}/status`, { token: tokens.admin, json: { status: 'approved', paymentStatus: 'maybe' } });
    assert.equal(r.status, 400);

    // จ่ายแล้ว: ออกบิลทันที วิธีชำระ = โอน
    r = await api('PATCH', `/api/bookings/admin/${bk.id}/status`, { token: tokens.admin, json: { status: 'approved', paymentStatus: 'paid' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.payment_status, 'paid'); assert.match(r.data.receipt.receipt_no, /^R\d{4}-\d{4}$/);
    assert.equal(r.data.receipt.payment_method, 'transfer');
    const rcNo = r.data.receipt.receipt_no;

    // อนุมัติซ้ำ (จ่ายแล้ว) ต้องไม่ออกบิลซ้ำ
    r = await api('PATCH', `/api/bookings/admin/${bk.id}/status`, { token: tokens.admin, json: { status: 'approved', paymentStatus: 'paid' } });
    assert.equal(r.data.receipt.receipt_no, rcNo);
    assert.equal(Number((await dbGet("SELECT COUNT(*) AS c FROM receipts WHERE booking_id = ? AND status = 'issued'", [bk.id])).c), 1);

    // หน้าลูกค้า: จ่ายแล้ว → มีบิล + QR token
    r = await api('POST', '/api/tickets/lookup', { json: { firstName: 'จ่าย', lastName: 'ใจดี', phone: '0861111111' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    let t = r.data.bookings[0];
    assert.equal(t.paymentStatus, 'paid'); assert.equal(t.receipt.receiptNo, rcNo); assert.ok(t.ticketToken);

    // ยังไม่จ่าย: ไม่ออกบิล
    r = await api('PATCH', `/api/bookings/admin/${bk2.id}/status`, { token: tokens.admin, json: { status: 'approved', paymentStatus: 'unpaid' } });
    assert.equal(r.status, 200); assert.equal(r.data.payment_status, 'unpaid'); assert.equal(r.data.receipt, null);
    assert.equal(Number((await dbGet('SELECT COUNT(*) AS c FROM receipts WHERE booking_id = ?', [bk2.id])).c), 0);
    r = await api('POST', '/api/tickets/lookup', { json: { firstName: 'ค้าง', lastName: 'ใจดี', phone: '0862222222' } });
    t = r.data.bookings[0];
    assert.equal(t.paymentStatus, 'unpaid'); assert.equal(t.receipt, null); assert.ok(t.ticketToken);

    // สแกนบัตรที่ยังไม่จ่าย: เข้างานได้ และตอบสถานะชำระเงินกลับมาให้หน้าสแกนถามต่อ
    r = await api('POST', '/api/bookings/staff/scan', { token: tokens.staff, json: { token: bk2.ticket_token } });
    assert.equal(r.data.result, 'OK'); assert.equal(r.data.paymentStatus, 'unpaid'); assert.equal(r.data.bookingId, bk2.id);

    // รับชำระทีหลัง: ต้องเลือกวิธีชำระ, พนักงานทำได้, ออกบิลให้
    assert.equal((await api('PATCH', `/api/bookings/admin/${bk2.id}/payment`, { token: tokens.staff, json: {} })).status, 400);
    assert.equal((await api('PATCH', `/api/bookings/admin/${bk2.id}/payment`, { json: { paymentMethod: 'cash' } })).status, 401);
    r = await api('PATCH', `/api/bookings/admin/${bk2.id}/payment`, { token: tokens.staff, json: { paymentMethod: 'cash' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.receipt.payment_method, 'cash'); assert.equal(r.data.receipt.issued_by, 'door');
    const row = await dbGet('SELECT payment_status, payment_method FROM bookings WHERE id = ?', [bk2.id]);
    assert.equal(row.payment_status, 'paid'); assert.equal(row.payment_method, 'cash');
    // กดซ้ำ ไม่ออกบิลซ้ำ
    const again = await api('PATCH', `/api/bookings/admin/${bk2.id}/payment`, { token: tokens.staff, json: { paymentMethod: 'transfer' } });
    assert.equal(again.data.receipt.receipt_no, r.data.receipt.receipt_no);

    // void บิล → กลับเป็นยังไม่จ่าย (หน้าลูกค้ากลับเป็น QR + ยังไม่จ่าย)
    const v = await api('POST', `/api/receipts/${r.data.receipt.id}/void`, { token: tokens.admin, json: { reason: 'ทดสอบ' } });
    assert.equal(v.status, 200);
    r = await api('POST', '/api/tickets/lookup', { json: { firstName: 'ค้าง', lastName: 'ใจดี', phone: '0862222222' } });
    t = r.data.bookings[0];
    assert.equal(t.paymentStatus, 'unpaid'); assert.equal(t.receipt, null); assert.ok(t.ticketToken);

    // ยังไม่อนุมัติ/ถูกปฏิเสธ รับชำระไม่ได้
    const bk3 = await mk('รอ', '0863333333', ['B-03']);
    r = await api('PATCH', `/api/bookings/admin/${bk3.id}/payment`, { token: tokens.staff, json: { paymentMethod: 'cash' } });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'NOT_APPROVED');
});
