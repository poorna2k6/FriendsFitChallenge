const { HttpError, readBody, send, match } = require('./http');
const { compiled } = require('./routes');
const A = require('./auth');
const { todayStr } = require('./scoring');
const { migrate } = require('../db/migrate');

let migrating = null;
const ensureSchema = () => (migrating = migrating || migrate().finally(() => { migrating = null; }));

const PUBLIC = [/^\/auth\/(login|signup|logout)$/, /^\/ingest\//, /^\/challenges\/preview$/, /^\/healthz$/];

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/api/, '') || '/';
    const found = match(compiled, req.method, path);
    if (!found) throw new HttpError(404, 'Not found');

    const ctx = {
      req, params: found.params, query: Object.fromEntries(url.searchParams), body: {},
      today: process.env.STAKEFIT_TODAY || todayStr(), userId: null, setCookie: null
    };
    const isIngest = path.startsWith('/ingest/');
    ctx.userId = A.verifySession(A.parseCookies(req.headers.cookie)[A.COOKIE]);

    // CSRF: cookie-authenticated writes must come from our own JS (custom header can't be set cross-site without CORS).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isIngest && !req.headers['x-sf-client']) {
      throw new HttpError(403, 'Missing client header');
    }
    if (req.method !== 'GET' && req.method !== 'DELETE') ctx.body = await readBody(req);
    if (!ctx.userId && !PUBLIC.some((re) => re.test(path))) throw new HttpError(401, 'Please sign in');

    let out;
    try {
      out = await found.handler(ctx);
    } catch (e) {
      // 42P01 = relation does not exist: the database is connected but migrations haven't run (e.g. preview build). Create the schema once and retry.
      if (e && e.code === '42P01') { await ensureSchema(); out = await found.handler(ctx); } else throw e;
    }
    send(res, 200, out, ctx.setCookie ? { 'Set-Cookie': ctx.setCookie } : undefined);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    const m = String((e && e.message) || '');
    if (/AUTH_SECRET/.test(m)) return send(res, 500, { error: 'Server setup incomplete: AUTH_SECRET is not set in Vercel environment variables.' });
    if (/DATABASE_URL/.test(m) || (e && ['ENOTFOUND', 'ECONNREFUSED', '28P01', '3D000'].includes(e.code))) return send(res, 500, { error: 'Server setup incomplete: the database is not connected. Check DATABASE_URL in Vercel environment variables.' });
    send(res, 500, { error: 'Something went wrong on our side' });
  }
}

module.exports = { handle };
