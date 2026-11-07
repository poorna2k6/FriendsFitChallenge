const { Pool, types } = require('pg');

// Keep DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting).
types.setTypeParser(1082, (v) => v);

let _pool;
const URL_VARS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'];
function connectionString() {
  const name = URL_VARS.find((n) => process.env[n]);
  return name ? process.env[name] : '';
}

/** Safe description of the configured database (never the password) for diagnostics. */
function describeConnection() {
  const name = URL_VARS.find((n) => process.env[n]) || null;
  if (!name) return { envVar: null };
  try {
    const u = new URL(process.env[name]);
    return { envVar: name, host: u.hostname, database: u.pathname.replace(/^\//, ''), user: u.username, hasPassword: Boolean(u.password) };
  } catch (e) {
    return { envVar: name, invalid: 'not a valid postgres:// URL' };
  }
}

function pool() {
  if (!_pool) {
    const cs = connectionString();
    if (!cs) throw new Error('DATABASE_URL is not set');
    const local = /@(localhost|127\.0\.0\.1)/.test(cs) || process.env.DATABASE_SSL === 'off';
    _pool = new Pool({
      connectionString: cs,
      max: Number(process.env.PG_POOL_MAX || 3),
      idleTimeoutMillis: 10000,
      ssl: local ? false : { rejectUnauthorized: false }
    });
  }
  return _pool;
}

const query = (text, params) => pool().query(text, params);

async function tx(fn) {
  const client = await pool().connect();
  try {
    await client.query('begin');
    const out = await fn((text, params) => client.query(text, params));
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx, describeConnection };
