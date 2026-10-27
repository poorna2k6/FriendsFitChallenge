// Versioned, forward-only migrations. Applies every db/migrations/*.sql not yet recorded in schema_migrations.
// Runs on every Vercel build (npm run build), so adding a new numbered file is all it takes to change the schema.
//   Usage: DATABASE_URL=... node db/migrate.js [--if-configured]
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 727001; // advisory lock so two simultaneous builds can't race

async function migrate(pool = require('../lib/db').pool()) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [f]);
        await client.query('commit');
        applied.push(f);
      } catch (e) {
        await client.query('rollback').catch(() => {});
        e.message = `Migration ${f} failed: ${e.message}`;
        throw e;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

module.exports = { migrate };

if (require.main === module) {
  const hasDb = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (process.argv.includes('--if-configured')) {
    if (!hasDb) {
      console.warn('DATABASE_URL not set - skipping migrations. Add a Postgres database (npm run setup:vercel), then redeploy.');
      process.exit(0);
    }
    // Preview deployments often share the production database; don't alter it from a preview build unless asked.
    if (process.env.VERCEL_ENV === 'preview' && !process.env.MIGRATE_ON_PREVIEW) {
      console.log('Preview build: skipping migrations (set MIGRATE_ON_PREVIEW=1 to enable).');
      process.exit(0);
    }
  }
  const { pool } = require('../lib/db');
  migrate()
    .then((a) => console.log(a.length ? `Applied migrations: ${a.join(', ')}` : 'Database schema is up to date.'))
    .then(() => pool().end())
    .catch((e) => { console.error(e.message); process.exit(1); });
}
