// โหลด .env เฉพาะเมื่อรันในเครื่อง (Local)
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '../backend/.env') });
}

const app = require('../backend/server.js');

module.exports = app;