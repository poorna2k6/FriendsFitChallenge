// End-to-end API test against a real Postgres. Set DATABASE_URL (a scratch database!) to run; skipped otherwise.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const HAS_DB = Boolean(process.env.DATABASE_URL);
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-test-secret-123';
process.env.STAKEFIT_TODAY = '2026-10-20';

test('API end-to-end: auth, challenge, health ingest, blind mode, peeks, admin tools', { skip: !HAS_DB }, async (t) => {
  const { handle } = require('../lib/handler');
  const { pool, query } = require('../lib/db');
  const fs = require('fs');
  const server = http.createServer(handle);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool().end(); });

  const { migrate } = require('../db/migrate');
  await migrate();
  assert.deepStrictEqual(await migrate(), [], 'migrations are idempotent: second run applies nothing');
  await query('truncate users, rate_limits cascade');

  const jar = {};
  async function call(who, method, path, body, extraHeaders) {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-sf-client': '1', ...(who && jar[who] ? { cookie: jar[who] } : {}), ...(extraHeaders || {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const sc = res.headers.get('set-cookie');
    if (sc && who) jar[who] = sc.split(';')[0];
    const json = await res.json();
    return { status: res.status, ...json };
  }
  const ok = async (...a) => { const r = await call(...a); assert.strictEqual(r.status, 200, `${a[1]} ${a[2]} -> ${r.status} ${r.error}`); return r; };
  const stateOf = async (who) => (await ok(who, 'GET', '/state'));

  // --- auth ---
  assert.strictEqual((await call(null, 'GET', '/state')).status, 401);
  for (const [k, name] of [['a', 'Ada Admin'], ['b', 'Ben Member'], ['c', 'Cy Slacker']]) {
    await ok(k, 'POST', '/auth/signup', { email: `${k}@x.com`, name, password: 'password123' });
  }
  assert.strictEqual((await call(null, 'POST', '/auth/signup', { email: 'a@x.com', name: 'Dup', password: 'password123' })).status, 409);
  assert.strictEqual((await call(null, 'POST', '/auth/login', { email: 'a@x.com', password: 'wrong-password' })).status, 401);
  assert.strictEqual((await call('a', 'POST', '/auth/signup', { email: 'z@x.com', name: 'Z', password: 'password123' }, { 'x-sf-client': '' })).status, 403, 'CSRF header required');

  // --- challenge + join ---
  const created = await ok('a', 'POST', '/challenges', { title: 'Test Showdown', metric: 'steps', durationKey: '1M', buyIn: 50, cutoffPct: 70, slashPct: 100 });
  let sa = await stateOf('a');
  const chId = created.id;
  const code = sa.challenges[0].inviteCode;
  assert.strictEqual(sa.challenges[0].isAdmin, true);
  assert.strictEqual((await call('b', 'GET', '/challenges/preview?code=' + code)).title, 'Test Showdown');
  await ok('b', 'POST', '/challenges/join', { code });
  await ok('c', 'POST', '/challenges/join', { code });
  assert.strictEqual((await call('b', 'PATCH', `/challenges/${chId}`, { buyIn: 1 })).status, 403, 'members cannot edit rules');

  // --- health connections + ingest ---
  const conn = {};
  for (const k of ['a', 'b', 'c']) conn[k] = await ok(k, 'POST', '/health/connections', { provider: 'apple_health' });
  assert.match(conn.a.ingestUrl, /\/api\/ingest\/sf_/);
  assert.strictEqual((await call(null, 'POST', '/ingest/sf_bogus', { steps: 1, date: '2026-10-20' })).status, 401);
  const post = (k, body) => call(null, 'POST', `/ingest/${conn[k].token}`, body);

  let r = await post('a', { samples: [{ date: '2026-10-20', steps: 12000 }, { date: '2026-10-19', steps: 9000 }] });
  assert.strictEqual(r.accepted, 2);
  assert.strictEqual((await post('a', { samples: [{ date: '2026-10-20', steps: 12000 }, { date: '2026-10-19', steps: 9000 }] })).deduped, true, 'identical payload deduped');
  await post('b', { data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date: '2026-10-20 00:00:00 -0500', qty: 8000, source: 'iPhone' }] }] } });
  await post('c', { date: '2026-10-20', steps: 1000 });
  const spike = await post('b', { date: '2026-10-19', steps: 500000 });
  assert.strictEqual(spike.quarantined, 1, 'implausible total quarantined');
  assert.strictEqual((await post('b', { date: '2026-10-20', steps: 8000, userEntered: true })).rejected, 1, 'manual entries rejected');
  assert.strictEqual((await post('b', { date: '2025-01-01', steps: 100 })).rejected, 1, 'ancient dates rejected');

  // upsert not sum: re-post a newer total for the same day
  await post('b', { date: '2026-10-20', steps: 8500 });

  // --- blind mode privacy ---
  let sb = await stateOf('b');
  let cb = sb.challenges[0];
  const rowOf = (c, name) => c.calc.rows.find((x) => x.name === name);
  assert.strictEqual(cb.calc.redacted, true);
  assert.strictEqual(rowOf(cb, 'Ben Member').score, 8500, 'own score visible');
  assert.strictEqual(rowOf(cb, 'Ada Admin').score, 0, "Ada's score hidden");
  assert.strictEqual(cb.calc.topScore, 0, '#1 bar hidden');
  assert.ok(!JSON.stringify(sb).includes('12000') && !JSON.stringify(sb).includes('12,000'), "no leak of Ada's 21,000 anywhere in the payload");
  sa = await stateOf('a');
  assert.strictEqual(rowOf(sa.challenges[0], 'Ada Admin').score, 12000);
  assert.strictEqual(sa.challenges[0].calc.redacted, false, 'admin sees everything');
  assert.ok(sa.challenges[0].logs.some((l) => l.source.includes('Apple Health')), 'sync events in feed');
  assert.ok(sb.auditLedger.some((x) => x.verdict === 'QUARANTINED') && sb.auditLedger.some((x) => x.verdict === 'VERIFIED'));

  // --- pay to peek (direct_to_target, weekly pass) ---
  const adaId = sa.me.id;
  const peek1 = await ok('b', 'POST', `/challenges/${chId}/peek`, { target: adaId });
  assert.strictEqual(peek1.charged, 0.25);
  assert.strictEqual((await ok('b', 'POST', `/challenges/${chId}/peek`, { target: adaId })).free, true, 'no repeat charge');
  sb = await stateOf('b'); cb = sb.challenges[0];
  assert.strictEqual(rowOf(cb, 'Ada Admin').score, 12000, 'peeked score visible');
  assert.strictEqual(cb.calc.topScore, 0, 'but the 100% bar stays hidden');
  assert.strictEqual(cb.peekData.peekFeesByMember[sb.me.id], 0.25);
  sa = await stateOf('a');
  assert.strictEqual(sa.challenges[0].peekData.spyRoyaltiesByMember[adaId], 0.25, 'fee paid straight to Ada');
  assert.strictEqual((await call('a', 'POST', `/challenges/${chId}/peek`, { target: sb.me.id })).status, 400, 'admin cannot peek');

  const peekAll = await ok('b', 'POST', `/challenges/${chId}/peek`, { target: 'all' });
  assert.strictEqual(peekAll.charged, 0.25, 'only one other member not yet unlocked (Cy)');
  sb = await stateOf('b'); cb = sb.challenges[0];
  assert.strictEqual(cb.calc.redacted, false);
  assert.strictEqual(cb.calc.topScore, 12000);
  assert.strictEqual(rowOf(cb, 'Cy Slacker').isSafe, false, 'Cy is far below 70% of #1');
  const total = cb.calc.rows.reduce((s, x) => s + x.finalPayout, 0);
  assert.ok(Math.abs(total - (150 + cb.calc.peekPotBonus)) < 0.01 + 0.5, 'payouts ~ pot (royalties settle outside the pot)');

  // --- habits (honour system, capped) ---
  await ok('b', 'POST', `/challenges/${chId}/habit`, { boosterId: 'h1' });
  assert.strictEqual((await call('b', 'POST', `/challenges/${chId}/habit`, { boosterId: 'h1' })).status, 400, 'once per booster per day');
  await ok('b', 'POST', `/challenges/${chId}/habit`, { boosterId: 'h4' });
  assert.strictEqual((await call('b', 'POST', `/challenges/${chId}/habit`, { boosterId: 'h2' })).status, 400, 'daily cap reached');

  // --- glitch request / admin tools ---
  const cyId = (await stateOf('c')).me.id;
  await ok('c', 'POST', `/challenges/${chId}/glitch`, { delta: 6000, reason: 'Watch battery died on the trail' });
  sa = await stateOf('a');
  const gr = sa.challenges[0].glitchRequests[0];
  assert.strictEqual(gr.friendId, cyId);
  assert.strictEqual((await call('b', 'POST', `/challenges/${chId}/glitch/${gr.id}/approve`)).status, 403, 'members cannot approve');
  await ok('a', 'POST', `/challenges/${chId}/glitch/${gr.id}/approve`);
  await ok('a', 'POST', `/challenges/${chId}/override`, { memberId: cyId, mode: 'add', amount: 1000, reason: 'Duplicate / Wrong Data Correction by Admin' });
  sa = await stateOf('a');
  assert.strictEqual(rowOf(sa.challenges[0], 'Cy Slacker').score, 8000, '1000 synced + 6000 approved + 1000 override');
  await ok('a', 'POST', `/challenges/${chId}/members/${cyId}/paid`, { paid: true });

  // --- governance lock ---
  await ok('a', 'PATCH', `/challenges/${chId}`, { governanceLocked: true });
  assert.strictEqual((await call('a', 'PATCH', `/challenges/${chId}`, { cutoffPct: 50 })).status, 403, 'rules immutable when locked');
  await ok('a', 'PATCH', `/challenges/${chId}`, { governanceLocked: false });
  await ok('a', 'PATCH', `/challenges/${chId}`, { cutoffPct: 50 });

  // --- days move on: pass expires after 7 days, late joiner gets pace-normalised ---
  process.env.STAKEFIT_TODAY = '2026-10-29';
  sb = await stateOf('b'); cb = sb.challenges[0];
  assert.strictEqual(cb.daysElapsed, 10);
  assert.strictEqual(cb.calc.redacted, true, 'peek-all pass (7 days) has expired');
  await ok('d', 'POST', '/auth/signup', { email: 'dd@x.com', name: 'Dee Late', password: 'password123' });
  await ok('d', 'POST', '/challenges/join', { code });
  sa = await stateOf('a');
  const dee = sa.challenges[0].calc.rows.find((x) => x.name === 'Dee Late');
  assert.ok(dee.score > 0, 'late joiner starts at ~88% of group average, not zero');

  // --- invitations ---
  const inv = await ok('a', 'POST', `/challenges/${chId}/invites`, { name: 'Eve', contact: 'eve@x.com', channel: 'Email', device: 'Apple Health' });
  sa = await stateOf('a');
  assert.strictEqual(sa.challenges[0].invitations.length, 1);
  await ok('a', 'DELETE', `/challenges/${chId}/invites/${inv.id}`);
  assert.strictEqual((await stateOf('a')).challenges[0].invitations.length, 0);

  // --- connections ---
  const list = (await stateOf('a')).connections;
  assert.strictEqual(list[0].provider, 'apple_health');
  assert.ok(!JSON.stringify(list).includes(conn.a.token), 'token never returned again');
  await ok('a', 'DELETE', `/health/connections/${list[0].id}`);
  assert.strictEqual((await post('a', { date: '2026-10-29', steps: 5 })).status, 401, 'revoked token stops working');

  // --- HTML can never be stored in user-visible strings (the UI renders them via innerHTML templates) ---
  const evil = await ok('a', 'POST', '/challenges', { title: '<img src=x onerror=alert(1)>Evil', metric: 'steps', durationKey: '1W', buyIn: 5, cutoffPct: 70, slashPct: 100 });
  const titles = (await stateOf('a')).challenges.map((c) => c.title).join('|');
  assert.ok(evil.id && !/[<>"]/.test(titles), 'tags stripped from titles');
});
