const test = require('node:test');
const assert = require('node:assert');
const engine = require('../public/engine.js');
const golden = require('./fixtures/engine-golden.json');

test('engine matches the original in-page payout engine on 54 golden cases', () => {
  for (const [i, g] of golden.entries()) {
    const calc = engine.computeStandings(g.input.ch, g.input.ctx);
    for (const k of ['topScore', 'cutoffScore', 'totalEscrowPot', 'forfeitedPool', 'peekPotBonus', 'totalBonusPool', 'qualifiersCount', 'failedCount']) {
      assert.strictEqual(calc[k], g.calc[k], `case ${i} ${k}`);
    }
    assert.deepStrictEqual(calc.rows.map((r) => [r.id, r.rank, r.isSafe]), g.calc.rows.map((r) => [r.id, r.rank, r.isSafe]), `case ${i} order`);
    for (const [ri, r] of calc.rows.entries()) {
      for (const k of ['finalPayout', 'bonusWon', 'retainedBuyIn', 'slashedAmount', 'achievementSharePct', 'pctOfTop', 'netProfit']) {
        assert.ok(Math.abs(r[k] - g.calc.rows[ri][k]) < 1e-9, `case ${i} row ${ri} ${k}: ${r[k]} vs ${g.calc.rows[ri][k]}`);
      }
    }
  }
});

test('money is conserved: payouts sum to pot (excluding peek royalties/stake deducts routed outside)', () => {
  const ch = { buyIn: 50, cutoffPct: 70, slashPct: 100, distributionMode: 'proportional_total', dailyBenchmark: 10000, daysElapsed: 10,
    friends: [{ id: 'a', score: 100 }, { id: 'b', score: 80 }, { id: 'c', score: 30 }] };
  const calc = engine.computeStandings(ch, { routingMode: 'pot_boost', peek: { totalPeekPot: 4 } });
  const total = calc.rows.reduce((s, r) => s + r.finalPayout, 0);
  assert.ok(Math.abs(total - (calc.totalEscrowPot + 4)) < 1e-9);
});

test('settlement transfers net to zero', () => {
  const rows = [{ id: 'a', name: 'A', netProfit: 30 }, { id: 'b', name: 'B', netProfit: -10 }, { id: 'c', name: 'C', netProfit: -20 }];
  const t = engine.settlementTransfers(rows);
  assert.strictEqual(t.reduce((s, x) => s + x.amount, 0), 30);
  assert.ok(t.every((x) => x.to === 'a'));
});

test('ingest parser: native + Health Auto Export formats, units, dedupe across devices, rejects', () => {
  const { parsePayload } = require('../lib/ingest.js');
  const a = parsePayload({ samples: [{ date: '2026-10-27', steps: '8,123', calories: 410, distance_m: 5200, minutes: 30 }] });
  assert.deepStrictEqual(a.samples.map((s) => [s.metric, s.value]).sort(), [['calories', 410], ['distance', 5.2], ['minutes', 30], ['steps', 8123]]);

  const hae = parsePayload({ data: { metrics: [
    { name: 'step_count', units: 'count', data: [{ date: '2026-10-27 00:00:00 -0500', qty: 5000, source: 'iPhone' }, { date: '2026-10-27 00:00:00 -0500', qty: 5200, source: 'Watch' }] },
    { name: 'active_energy', units: 'kJ', data: [{ date: '2026-10-27 00:00:00 -0500', qty: 418.4 }] },
    { name: 'walking_running_distance', units: 'mi', data: [{ date: '2026-10-27 00:00:00 -0500', qty: 1 }] }
  ] } });
  const byMetric = Object.fromEntries(hae.samples.map((s) => [s.metric, s.value]));
  assert.strictEqual(byMetric.steps, 5200, 'two devices: max, never the sum');
  assert.strictEqual(byMetric.calories, 100, 'kJ converted to kcal');
  assert.strictEqual(byMetric.distance, 1.609, 'miles converted to km');

  assert.strictEqual(parsePayload({ date: '2026-10-27', steps: -4 }).rejected.length, 1);
  assert.strictEqual(parsePayload({ date: '2026-10-27', steps: 100, userEntered: true }).rejected.length, 1);
  assert.strictEqual(parsePayload({ date: 'garbage', steps: 100 }).rejected.length, 1);
  assert.strictEqual(parsePayload({ date: '10/27/2026', steps: 7 }).samples[0].day, '2026-10-27');
});

test('auth: password hashing and signed sessions', async () => {
  process.env.AUTH_SECRET = 'unit-test-secret-unit-test-secret';
  const A = require('../lib/auth.js');
  const h = await A.hashPassword('correct horse');
  assert.ok(await A.verifyPassword('correct horse', h));
  assert.ok(!(await A.verifyPassword('wrong', h)));
  const tok = A.signSession('user-1');
  assert.strictEqual(A.verifySession(tok), 'user-1');
  assert.strictEqual(A.verifySession(tok.slice(0, -2) + 'xx'), null, 'tampered token rejected');
});
