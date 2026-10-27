// Applies db/schema.sql to DATABASE_URL. Usage: DATABASE_URL=... node db/migrate.js
const fs = require('fs');
const path = require('path');
const { pool } = require('../lib/db');

if (process.argv.includes('--if-configured') && !(process.env.DATABASE_URL || process.env.POSTGRES_URL)) {
  console.warn('DATABASE_URL not set - skipping migration (add a Postgres database in Vercel, then redeploy).');
  process.exit(0);
}

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool().query(sql);
  console.log('StakeFit schema applied.');
  await pool().end();
})().catch((e) => { console.error(e); process.exit(1); });
