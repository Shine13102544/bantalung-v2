const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

// ----- เชื่อมต่อฐานข้อมูล Turso (Cloud) -----
// ต้องตั้งค่า TURSO_DATABASE_URL และ TURSO_AUTH_TOKEN ใน .env (ดูวิธีได้ที่ turso.tech)
// ตอนทดสอบในเครื่องใช้ TURSO_DATABASE_URL=file:./data/dev.db ได้ (ไม่ต้องมี token)
if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('ไม่พบ TURSO_DATABASE_URL ใน .env กรุณาตั้งค่าก่อนรันเซิร์ฟเวอร์ (ดูวิธีได้ที่ turso.tech)');
}

const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});

// ----- Helper functions: .get/.all/.run แบบ async -----
async function dbGet(sql, params = []) {
    const result = await client.execute({ sql, args: params });
    return result.rows[0] || undefined;
}

async function dbAll(sql, params = []) {
    const result = await client.execute({ sql, args: params });
    return result.rows;
}

async function dbRun(sql, params = []) {
    const result = await client.execute({ sql, args: params });
    return {
        lastInsertRowid: Number(result.lastInsertRowid ?? 0),
        changes: result.rowsAffected
    };
}

// รันหลายคำสั่งแบบ atomic (ทั้งหมดสำเร็จ หรือไม่มีอะไรถูกบันทึกเลย)
// statements: array ของ { sql, args }
async function dbBatch(statements) {
    return client.batch(
        statements.map(s => ({ sql: s.sql, args: s.args || [] })),
        'write'
    );
}

// รัน raw SQL หลายคำสั่งรวด (ใช้ตอนสร้าง schema เท่านั้น ไม่มี parameter)
async function dbExec(sql) {
    await client.executeMultiple(sql);
}

// รัน transaction แบบโต้ตอบได้ (อ่านค่าระหว่างทางแล้วตัดสินใจต่อได้)
// transaction แบบ 'write' จะล็อกการเขียนตั้งแต่เริ่ม จึงกันโต๊ะซ้ำตอนมีคนจองพร้อมกันได้
async function dbTransaction(fn) {
    const tx = await client.transaction('write');
    try {
        const txHelpers = {
            get: async (sql, params = []) => {
                const result = await tx.execute({ sql, args: params });
                return result.rows[0] || undefined;
            },
            all: async (sql, params = []) => {
                const result = await tx.execute({ sql, args: params });
                return result.rows;
            },
            run: async (sql, params = []) => {
                const result = await tx.execute({ sql, args: params });
                return { lastInsertRowid: Number(result.lastInsertRowid ?? 0), changes: result.rowsAffected };
            }
        };
        const returnValue = await fn(txHelpers);
        await tx.commit();
        return returnValue;
    } catch (err) {
        try { await tx.rollback(); } catch (_) { /* ignore */ }
        throw err;
    }
}

// ----- Migration แบบมีเวอร์ชัน -----
// เดิม initDatabase() ยิงคำสั่งไป Turso 15-20 ครั้งทุก cold start ตอนนี้เช็กเลขเวอร์ชันครั้งเดียว
// ถ้าเท่ากับ SCHEMA_VERSION แล้วจะข้ามทั้งหมด (เพิ่มเลขนี้ทุกครั้งที่แก้ schema)
const SCHEMA_VERSION = 4;

async function ensureColumn(table, column, ddl) {
    const cols = (await dbAll(`PRAGMA table_info(${table})`)).map(c => c.name);
    if (cols.includes(column)) return false;
    try {
        await dbExec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
        return true;
    } catch (err) {
        // อีก instance อาจเพิ่งเพิ่มคอลัมน์ไปพร้อมกัน
        if (/duplicate column/i.test(String(err.message))) return false;
        throw err;
    }
}

const DEFAULT_SETTINGS = {
    concert_title: 'บ้านตะลุง Ban Ta-lung - คอนเสิร์ตสด',
    concert_date: '',
    price_vip: '2,500฿',
    price_normal: '1,200฿',
    price_general: '800฿',
    sales_status: 'open',
    max_tables_per_booking: '8',
    pending_expire_hours: '0'
};

const SEED_LAYOUT = [
    { kind: 'stage', table_code: null, zone_type: null, label: '🎤 เวทีคอนเสิร์ต (STAGE)', price: null, pos_left: '150px', pos_top: '15px', width: '400px', height: '55px', color: '#e74c3c', sort_order: 0 },
    { kind: 'zone', table_code: null, zone_type: null, label: 'โซน VIP (ติดขอบเวที)', price: null, pos_left: '80px', pos_top: '90px', width: '540px', height: '110px', color: '#f1c40f', sort_order: 1 },
    { kind: 'table', table_code: 'VIP-01', zone_type: 'vip', label: null, price: '2,500฿', pos_left: '110px', pos_top: '120px', width: '85px', height: '55px', color: '#e74c3c', sort_order: 2 },
    { kind: 'table', table_code: 'VIP-02', zone_type: 'vip', label: null, price: '2,500฿', pos_left: '230px', pos_top: '120px', width: '85px', height: '55px', color: '#e74c3c', sort_order: 3 },
    { kind: 'table', table_code: 'VIP-03', zone_type: 'vip', label: null, price: '2,500฿', pos_left: '350px', pos_top: '120px', width: '85px', height: '55px', color: '#e74c3c', sort_order: 4 },
    { kind: 'table', table_code: 'VIP-04', zone_type: 'vip', label: null, price: '2,500฿', pos_left: '470px', pos_top: '120px', width: '85px', height: '55px', color: '#e74c3c', sort_order: 5 },
    { kind: 'zone', table_code: null, zone_type: null, label: 'โซนธรรมดา (Standard)', price: null, pos_left: '40px', pos_top: '230px', width: '620px', height: '110px', color: '#3498db', sort_order: 6 },
    { kind: 'table', table_code: 'A-01', zone_type: 'normal', label: null, price: '1,200฿', pos_left: '70px', pos_top: '260px', width: '85px', height: '55px', color: '#3498db', sort_order: 7 },
    { kind: 'table', table_code: 'A-02', zone_type: 'normal', label: null, price: '1,200฿', pos_left: '190px', pos_top: '260px', width: '85px', height: '55px', color: '#3498db', sort_order: 8 },
    { kind: 'table', table_code: 'A-03', zone_type: 'normal', label: null, price: '1,200฿', pos_left: '310px', pos_top: '260px', width: '85px', height: '55px', color: '#3498db', sort_order: 9 },
    { kind: 'table', table_code: 'A-04', zone_type: 'normal', label: null, price: '1,200฿', pos_left: '430px', pos_top: '260px', width: '85px', height: '55px', color: '#3498db', sort_order: 10 }
];

async function runMigrations(isFirstInit) {
    // 1) สร้างตารางทั้งหมด (IF NOT EXISTS ทั้งหมด จึงปลอดภัยรันซ้ำได้)
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await dbExec(schema);

    // 2) เพิ่มคอลัมน์ให้ฐานข้อมูลเก่าที่สร้างไว้ก่อนหน้านี้
    await ensureColumn('bookings', 'checked_in', 'checked_in INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('bookings', 'checked_in_at', 'checked_in_at TEXT');
    await ensureColumn('bookings', 'ticket_token', 'ticket_token TEXT');
    await ensureColumn('bookings', 'total_amount', 'total_amount INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('bookings', 'payment_method', "payment_method TEXT NOT NULL DEFAULT 'transfer'");
    // สถานะชำระเงิน: คอลัมน์ใหม่ (v4) การจองเดิมที่อนุมัติไปแล้วถือว่าจ่ายแล้ว (เดิมอนุมัติหลังตรวจสลิปเท่านั้น)
    // backfill เฉพาะตอนเพิ่งเพิ่มคอลัมน์ ไม่ทำซ้ำ เพื่อไม่ให้รายการ "ยังไม่จ่าย" ที่แอดมินตั้งใจไว้ถูกเปลี่ยนเป็นจ่ายแล้ว
    if (await ensureColumn('bookings', 'payment_status', "payment_status TEXT NOT NULL DEFAULT 'unpaid'")) {
        await dbRun("UPDATE bookings SET payment_status = 'paid' WHERE status = 'approved'");
    }
    await ensureColumn('booking_tables', 'price', 'price INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('admin_users', 'role', "role TEXT NOT NULL DEFAULT 'admin'");

    await dbExec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_ticket_token ON bookings(ticket_token) WHERE ticket_token IS NOT NULL');
    await dbExec('CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)');
    await dbExec('CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(phone)');

    // 3) Backfill ข้อมูลเก่า (ทุกคำสั่ง idempotent รันซ้ำได้)
    await dbRun("UPDATE bookings SET ticket_token = lower(hex(randomblob(16))) WHERE ticket_token IS NULL");
    await dbRun(`
        UPDATE booking_tables
        SET price = COALESCE((
            SELECT CAST(REPLACE(REPLACE(li.price, ',', ''), ' ', '') AS INTEGER)
            FROM layout_items li WHERE li.id = booking_tables.layout_item_id
        ), 0)
        WHERE price = 0
    `);
    await dbRun(`
        UPDATE bookings
        SET total_amount = COALESCE((SELECT SUM(price) FROM booking_tables WHERE booking_id = bookings.id), 0)
        WHERE total_amount = 0
    `);

    // 4) กู้คืนแถวเวที (stage) ถ้าหายไป — คำสั่งเดียว atomic ไม่ซ้ำแม้หลาย instance เริ่มพร้อมกัน
    await dbRun(`
        INSERT INTO layout_items (kind, table_code, zone_type, label, price, pos_left, pos_top, width, height, color, sort_order)
        SELECT 'stage', NULL, NULL, '🎤 เวทีคอนเสิร์ต (STAGE)', NULL, '150px', '15px', '400px', '55px', '#e74c3c', -1
        WHERE NOT EXISTS (SELECT 1 FROM layout_items WHERE kind = 'stage')
    `);

    // 5) Seed ผังโต๊ะตัวอย่าง เฉพาะการสร้างฐานข้อมูลครั้งแรกและยังไม่มีผังเลย
    //    ทำใน write transaction เพื่อไม่ให้หลาย instance seed ซ้ำ
    if (isFirstInit) {
        await dbTransaction(async (tx) => {
            const c = await tx.get("SELECT COUNT(*) AS c FROM layout_items WHERE kind != 'stage'");
            if (Number(c.c) === 0) {
                for (const item of SEED_LAYOUT.filter(i => i.kind !== 'stage')) {
                    await tx.run(
                        `INSERT INTO layout_items (kind, table_code, zone_type, label, price, pos_left, pos_top, width, height, color, sort_order)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [item.kind, item.table_code, item.zone_type, item.label, item.price, item.pos_left, item.pos_top, item.width, item.height, item.color, item.sort_order]
                    );
                }
            }
        });
    }

    // 6) ค่า settings เริ่มต้น (ไม่ทับค่าที่มีอยู่แล้ว)
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        await dbRun('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
    await dbRun('INSERT OR IGNORE INTO site_contact (id) VALUES (1)');

    // 7) บันทึกเลขเวอร์ชัน (ทำเป็นขั้นสุดท้าย ถ้าล้มเหลวกลางทางครั้งหน้าจะรันใหม่)
    await dbRun(
        `INSERT INTO settings (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [String(SCHEMA_VERSION)]
    );
}

// เรียกตอนสตาร์ทเซิร์ฟเวอร์ (server.js) — ปกติเป็นแค่ SELECT เดียว
async function initDatabase() {
    let currentVersion = null;
    try {
        const row = await dbGet("SELECT value FROM settings WHERE key = 'schema_version'");
        if (row) currentVersion = Number(row.value);
    } catch (_) {
        currentVersion = null; // ยังไม่มีตาราง settings = ฐานข้อมูลใหม่
    }

    if (currentVersion !== null && currentVersion >= SCHEMA_VERSION) return;
    await runMigrations(currentVersion === null);
}

module.exports = { client, dbGet, dbAll, dbRun, dbBatch, dbExec, dbTransaction, initDatabase, SCHEMA_VERSION };
