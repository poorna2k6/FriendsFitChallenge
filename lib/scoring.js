const E = require('../public/engine.js');

const todayStr = (d = new Date()) => d.toISOString().slice(0, 10);
const dayMs = 86400000;
const toMs = (s) => Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`);
const addDays = (s, n) => new Date(toMs(s) + n * dayMs).toISOString().slice(0, 10);

function challengeDay(startDate, durationKey, today = todayStr()) {
  const total = E.DURATIONS[durationKey].totalDays;
  const n = Math.floor((toMs(today) - toMs(startDate)) / dayMs) + 1;
  return { daysElapsed: Math.max(1, Math.min(total, n)), totalDays: total, ended: n > total, notStarted: n < 1 };
}

const isWeekend = (day) => { const g = new Date(toMs(day)).getUTCDay(); return g === 0 || g === 6; };

function roundFor(metric, v) {
  return metric === 'distance' ? Math.round(v * 100) / 100 : Math.round(v);
}

/**
 * dailyRows: [{user_id, day, metric, value}] already resolved to one provider per (user,day,metric).
 * adjRows:   [{user_id, day, amount, kind}]
 * Returns { [userId]: { score, streak, byDay: {day: value} } }
 */
function scoreMembers(ch, userIds, dailyRows, adjRows, opts = {}) {
  const { daysElapsed } = challengeDay(ch.start_date, ch.duration_key, opts.today);
  const first = String(ch.start_date).slice(0, 10);
  const last = addDays(first, daysElapsed - 1);
  const weekend2x = Boolean(opts.weekend2x);
  const target = Number(ch.daily_benchmark) || 1;

  const byUser = {};
  userIds.forEach((u) => { byUser[u] = { comps: {}, adj: {} }; });
  for (const r of dailyRows) {
    const day = String(r.day).slice(0, 10);
    if (day < first || day > last || !byUser[r.user_id]) continue;
    (byUser[r.user_id].comps[day] = byUser[r.user_id].comps[day] || {})[r.metric] = Number(r.value);
  }
  for (const a of adjRows) {
    if (!byUser[a.user_id]) continue;
    const day = String(a.day).slice(0, 10);
    byUser[a.user_id].adj[day] = (byUser[a.user_id].adj[day] || 0) + Number(a.amount);
  }

  const out = {};
  for (const u of userIds) {
    const { comps, adj } = byUser[u];
    const byDay = {};
    const days = new Set([...Object.keys(comps), ...Object.keys(adj)]);
    for (const day of days) {
      const c = comps[day] || {};
      let health = 0;
      if (ch.metric === 'hybrid') health = E.hybridScore(c.steps, c.calories, c.minutes);
      else if (ch.metric !== 'habits') health = c[ch.metric] || 0;
      if (weekend2x && isWeekend(day)) health *= 1.25;
      byDay[day] = health + (adj[day] || 0);
    }
    const score = Math.max(0, roundFor(ch.metric, Object.values(byDay).reduce((s, v) => s + v, 0)));

    // streak = consecutive days (ending today, or yesterday if today's goal isn't hit yet) at/above the daily target
    let streak = 0;
    let cursor = last;
    if ((byDay[cursor] || 0) < target) cursor = addDays(cursor, -1);
    while (cursor >= first && (byDay[cursor] || 0) >= target) { streak += 1; cursor = addDays(cursor, -1); }
    out[u] = { score, streak, byDay };
  }
  return out;
}

module.exports = { todayStr, addDays, challengeDay, scoreMembers, toMs };
