-- ผู้ใช้แอดมิน/พนักงาน (รหัสผ่านเก็บเป็น bcrypt hash เท่านั้น ห้ามเก็บ plaintext)
-- role: 'admin' = ทำได้ทุกอย่าง, 'staff' = พนักงานหน้างาน (เช็กอิน/สแกน/walk-in/ย้ายโต๊ะ เท่านั้น)
CREATE TABLE IF NOT EXISTS admin_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ผังงาน: เวที / โซน / โต๊ะ ทั้งหมดอยู่ในตารางเดียว แยกด้วย kind
CREATE TABLE IF NOT EXISTS layout_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL CHECK (kind IN ('stage','zone','table')),
    table_code  TEXT,              -- เช่น 'VIP-01' ใช้เฉพาะ kind='table'
    zone_type   TEXT,              -- 'vip' | 'normal' | 'general' ใช้เฉพาะ kind='table'
    label       TEXT,              -- ข้อความที่แสดง (สำหรับ stage/zone)
    price       TEXT,              -- ราคาปัจจุบันของโต๊ะ เช่น '2,500฿'
    pos_left    TEXT NOT NULL DEFAULT '0px',
    pos_top     TEXT NOT NULL DEFAULT '0px',
    width       TEXT,
    height      TEXT,
    color       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_layout_table_code
    ON layout_items(table_code) WHERE kind = 'table';

-- การจอง 1 รายการ = 1 ลูกค้า อาจจองได้หลายโต๊ะพร้อมกัน (ดูตาราง booking_tables)
-- slip_filename: เก็บ public_id ของสลิปบน Cloudinary (การจองเก่าอาจเป็น URL เต็ม) 'staff_approved' = walk-in ไม่มีสลิป
CREATE TABLE IF NOT EXISTS bookings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_code   TEXT UNIQUE NOT NULL,
    first_name     TEXT NOT NULL,
    last_name      TEXT NOT NULL,
    phone          TEXT NOT NULL,
    slip_filename  TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    checked_in     INTEGER NOT NULL DEFAULT 0,   -- 1 = ลูกค้าเช็กอินเข้างานแล้ว (หน้าตรวจบัตร)
    checked_in_at  TEXT,                          -- เวลาที่เช็กอิน
    ticket_token   TEXT,                          -- รหัสลับในบัตร/QR (สุ่ม 128 บิต เดาไม่ได้)
    total_amount   INTEGER NOT NULL DEFAULT 0,    -- ยอดรวมที่ server คำนวณตอนจอง (บาท)
    payment_method TEXT NOT NULL DEFAULT 'transfer', -- transfer | cash | promptpay
    payment_status TEXT NOT NULL DEFAULT 'unpaid',   -- unpaid | paid (สถานะชำระเงิน แยกจากสถานะอนุมัติ)
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ตารางเชื่อม booking <-> โต๊ะ (many-to-many) พร้อมราคา ณ วันที่จอง
CREATE TABLE IF NOT EXISTS booking_tables (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id      INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    layout_item_id  INTEGER NOT NULL REFERENCES layout_items(id) ON DELETE RESTRICT,
    price           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_booking_tables_booking ON booking_tables(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_tables_layout ON booking_tables(layout_item_id);

-- ประวัติการย้ายโต๊ะ
CREATE TABLE IF NOT EXISTS booking_moves (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id  INTEGER NOT NULL,
    from_code   TEXT NOT NULL,
    to_code     TEXT NOT NULL,
    old_total   INTEGER NOT NULL DEFAULT 0,
    new_total   INTEGER NOT NULL DEFAULT 0,
    price_adjusted INTEGER NOT NULL DEFAULT 0,
    moved_by    TEXT,
    moved_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ใบเสร็จ (เก็บ snapshot ข้อมูล ไม่ผูก FK เพื่อให้คงอยู่แม้ล้างรายการจองหลังจบงาน)
CREATE TABLE IF NOT EXISTS receipts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_no     TEXT UNIQUE NOT NULL,
    booking_id     INTEGER,
    booking_code   TEXT,
    customer_name  TEXT NOT NULL,
    phone          TEXT,
    tables         TEXT,
    amount         INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'transfer',
    note           TEXT,
    status         TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
    issued_by      TEXT,
    issued_at      TEXT NOT NULL DEFAULT (datetime('now')),
    void_reason    TEXT,
    voided_by      TEXT,
    voided_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_booking ON receipts(booking_id);

-- ตัวนับเลขที่ (ใช้รันเลขใบเสร็จต่อเนื่อง)
CREATE TABLE IF NOT EXISTS counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);

-- ตัวนับ rate limit เก็บใน DB (ใช้ได้จริงบน serverless ที่แต่ละ instance ไม่แชร์ memory)
CREATE TABLE IF NOT EXISTS rate_limits (
    key      TEXT PRIMARY KEY,
    count    INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
);

-- สำรองข้อมูลการจองทั้งหมดก่อนกด "สิ้นสุดคอนเสิร์ต" (ลบไม่ได้จาก UI)
CREATE TABLE IF NOT EXISTS archives (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ended_at      TEXT NOT NULL DEFAULT (datetime('now')),
    ended_by      TEXT,
    concert_title TEXT,
    booking_count INTEGER NOT NULL DEFAULT 0,
    data          TEXT NOT NULL
);

-- ค่าคอนฟิกทั่วไป (ชื่องาน, วันที่, ราคาแต่ละโซน ฯลฯ) เก็บแบบ key/value
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'food',
    price REAL NOT NULL,
    is_available INTEGER DEFAULT 1,
    image_url TEXT
);

CREATE TABLE IF NOT EXISTS site_contact (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phone TEXT, line_id TEXT, facebook TEXT, open_hours TEXT, address TEXT, google_maps_url TEXT
);
