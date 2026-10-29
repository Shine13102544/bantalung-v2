// ทดสอบการอัปเกรดฐานข้อมูลเก่า (ก่อนมี ticket_token/total_amount/role) ให้เป็น schema ใหม่โดยข้อมูลไม่หาย
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createClient } = require('@libsql/client');

const OLD_SCHEMA = `
CREATE TABLE admin_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE layout_items (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, table_code TEXT, zone_type TEXT, label TEXT, price TEXT, pos_left TEXT NOT NULL DEFAULT '0px', pos_top TEXT NOT NULL DEFAULT '0px', width TEXT, height TEXT, color TEXT, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX idx_layout_table_code ON layout_items(table_code) WHERE kind = 'table';
CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_code TEXT UNIQUE NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, phone TEXT NOT NULL, slip_filename TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE booking_tables (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE, layout_item_id INTEGER NOT NULL REFERENCES layout_items(id) ON DELETE RESTRICT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE menu_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT DEFAULT 'food', price REAL NOT NULL, is_available INTEGER DEFAULT 1, image_url TEXT);
CREATE TABLE site_contact (id INTEGER PRIMARY KEY CHECK (id = 1), phone TEXT, line_id TEXT, facebook TEXT, open_hours TEXT, address TEXT, google_maps_url TEXT);
`;

test('อัปเกรดฐานข้อมูลเก่า: เติมคอลัมน์ใหม่, สร้าง token ไม่ซ้ำ, ย้อนเก็บราคา/ยอดรวม, ไม่ seed ผังซ้ำ', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bantalung-mig-'));
    const url = 'file:' + path.join(dir, 'old.db');
    const c = createClient({ url });
    await c.executeMultiple(OLD_SCHEMA);
    await c.execute("INSERT INTO admin_users (username, password_hash) VALUES ('oldadmin', 'x')");
    await c.execute("INSERT INTO layout_items (kind, table_code, zone_type, price) VALUES ('table','VIP-01','vip','2,500฿'),('table','A-01','normal','1,200฿'),('table','Z-09','general','800 บาท')");
    await c.execute("INSERT INTO bookings (booking_code, first_name, last_name, phone, slip_filename, status) VALUES ('BK-1111-AAAA','เก่า','มาก','081-000-0001','https://res.cloudinary.com/x/image/upload/v1/bantalung/slips/old1.jpg','approved'),('BK-2222-BBBB','สอง','คน','0820000002','slip_old.jpg','pending')");
    await c.execute('INSERT INTO booking_tables (booking_id, layout_item_id) VALUES (1,1),(1,2),(2,3)');
    c.close();

    const script = `
        const { initDatabase, dbAll, dbGet } = require(${JSON.stringify(path.resolve(__dirname, '../db/database'))});
        (async () => {
            await initDatabase();
            await initDatabase(); // รันซ้ำต้องปลอดภัย
            const out = {
                bookings: await dbAll('SELECT booking_code, ticket_token, total_amount, payment_method, payment_status FROM bookings ORDER BY id'),
                prices: await dbAll('SELECT booking_id, price FROM booking_tables ORDER BY id'),
                admin: await dbGet("SELECT role FROM admin_users WHERE username = 'oldadmin'"),
                version: await dbGet("SELECT value FROM settings WHERE key = 'schema_version'"),
                layout: await dbAll("SELECT kind, COUNT(*) AS c FROM layout_items GROUP BY kind"),
                settings: await dbAll("SELECT key FROM settings WHERE key IN ('sales_status','max_tables_per_booking')")
            };
            console.log('RESULT:' + JSON.stringify(out));
            process.exit(0);
        })().catch(e => { console.error(e); process.exit(1); });
    `;
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TURSO_DATABASE_URL: url }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.split('RESULT:')[1]);

    assert.equal(out.bookings.length, 2);
    assert.ok(out.bookings.every(b => /^[0-9a-f]{32}$/.test(b.ticket_token)), 'ทุกการจองเก่าต้องมี token');
    assert.notEqual(out.bookings[0].ticket_token, out.bookings[1].ticket_token);
    assert.deepEqual(out.bookings.map(b => Number(b.total_amount)), [3700, 800]);
    assert.deepEqual(out.prices.map(p => Number(p.price)), [2500, 1200, 800]);
    assert.equal(out.admin.role, 'admin');
    assert.equal(Number(out.version.value), 4);
    // การจองเดิมที่อนุมัติแล้วถือว่าจ่ายแล้ว ส่วนที่ยังรอตรวจเป็นยังไม่จ่าย
    assert.deepEqual(out.bookings.map(b => b.payment_status), ['paid', 'unpaid']);
    const kinds = Object.fromEntries(out.layout.map(l => [l.kind, Number(l.c)]));
    assert.equal(kinds.table, 3, 'ห้าม seed ผังตัวอย่างทับของเดิม');
    assert.equal(kinds.stage, 1);
    assert.equal(out.settings.length, 2);
});
