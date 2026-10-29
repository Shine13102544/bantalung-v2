// สคริปต์สำหรับสร้าง/เปลี่ยนรหัสผ่านแอดมิน หรือพนักงานหน้างาน
//   npm run seed:admin   → บัญชีแอดมิน (ทำได้ทุกอย่าง)
//   npm run seed:staff   → บัญชีพนักงานหน้างาน (เช็กอิน/สแกน/walk-in/ย้ายโต๊ะ เท่านั้น เห็นเบอร์โทรแบบปิดบัง)
// จะถามชื่อผู้ใช้และรหัสผ่าน แล้วเก็บเป็น bcrypt hash ลง DB เท่านั้น (ไม่มี plaintext ในโค้ดเลย)

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { dbGet, dbRun, initDatabase } = require('./db/database');

const ROLE = process.argv.includes('--role=staff') ? 'staff' : 'admin';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

// ซ่อนตัวอักษรรหัสผ่านตอนพิมพ์
function askHidden(query) {
    return new Promise((resolve) => {
        process.stdout.write(query);
        const stdin = process.stdin;
        stdin.resume();
        stdin.setRawMode(true);
        let input = '';
        const onData = (char) => {
            char = char.toString('utf8');
            if (char === '\n' || char === '\r' || char === '\u0004') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                process.stdout.write('\n');
                resolve(input);
            } else if (char === '\u0003') {
                process.exit(1);
            } else if (char === '\u007f') {
                input = input.slice(0, -1);
            } else {
                input += char;
            }
        };
        stdin.on('data', onData);
    });
}

(async () => {
    console.log('⏳ กำลังเชื่อมต่อฐานข้อมูล Turso...');
    await initDatabase(); // เผื่อรันครั้งแรกสุด ยังไม่เคยมีตาราง admin_users มาก่อน

    const defaultName = ROLE === 'staff' ? 'staff' : 'admin';
    const username = (await ask(`ชื่อผู้ใช้${ROLE === 'staff' ? 'พนักงาน' : 'แอดมิน'} (default: ${defaultName}): `)) || defaultName;
    let password = await askHidden('ตั้งรหัสผ่าน (อย่างน้อย 10 ตัวอักษร): ');

    if (password.length < 10) {
        console.error('❌ รหัสผ่านสั้นเกินไป ต้องอย่างน้อย 10 ตัวอักษร');
        process.exit(1);
    }

    const hash = await bcrypt.hash(password, 12);

    const existing = await dbGet('SELECT id FROM admin_users WHERE username = ?', [username]);
    if (existing) {
        await dbRun('UPDATE admin_users SET password_hash = ?, role = ? WHERE username = ?', [hash, ROLE, username]);
        console.log(`✅ อัปเดตรหัสผ่านของผู้ใช้ "${username}" (สิทธิ์: ${ROLE}) เรียบร้อยแล้ว`);
    } else {
        await dbRun('INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, ROLE]);
        console.log(`✅ สร้างผู้ใช้ "${username}" (สิทธิ์: ${ROLE}) เรียบร้อยแล้ว`);
    }

    password = null; // เคลียร์ตัวแปรออกจากหน่วยความจำ
    rl.close();
    process.exit(0);
})();
