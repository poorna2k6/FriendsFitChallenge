const { query, tx } = require('./db');
const E = require('../public/engine.js');
const { sha256 } = require('./auth');
const { HttpError } = require('./http');
const { todayStr, addDays } = require('./scoring');
const { loadBundles } = require('./state');
const { PROVIDERS } = require('./defaults');

const METRIC_KEYS = ['steps', 'calories', 'minutes', 'distance'];
const HAE_NAMES = {
  step_count: 'steps', steps: 'steps',
  active_energy: 'calories', active_energy_burned: 'calories', activeenergy: 'calories',
  apple_exercise_time: 'minutes', exercise_time: 'minutes', workout_minutes: 'minutes',
  walking_running_distance: 'distance', distance_walking_running: 'distance'
};
const num = (v) => {
  if (v === null || v === undefined || v === '') return NaN;
  return typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
};

function parseDay(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function convert(metric, value, units) {
  const u = String(units || '').toLowerCase();
  if (metric === 'calories' && (u === 'kj' || u === 'kilojoule' || u === 'kilojoules')) return value / 4.184;
  if (metric === 'distance') {
    if (u === 'mi' || u === 'mile' || u === 'miles') return value * 1.609344;
    if (u === 'm' || u === 'meter' || u === 'meters' || u === 'metre' || u === 'metres') return value / 1000;
  }
  if (metric === 'minutes' && (u === 'hr' || u === 'h' || u === 'hours')) return value * 60;
  return value;
}

/** Accepts the StakeFit native format and the Health Auto Export metrics format. Returns { samples, rejected }. */
function parsePayload(body) {
  const samples = [];
  const rejected = [];
  const acc = new Map(); // `${day}|${metric}|${source}` -> sum

  const add = (day, metric, value, source) => {
    if (!day) return rejected.push({ reason: 'unreadable date' });
    if (!Number.isFinite(value)) return rejected.push({ reason: `${metric}: not a number`, day });
    if (value < 0) return rejected.push({ reason: `${metric}: negative`, day });
    const k = `${day}|${metric}|${source || ''}`;
    acc.set(k, (acc.get(k) || 0) + value);
  };

  const metrics = body && body.data && Array.isArray(body.data.metrics) ? body.data.metrics : null;
  if (metrics) {
    for (const m of metrics) {
      const metric = HAE_NAMES[String(m.name || '').toLowerCase()];
      if (!metric) continue;
      for (const d of m.data || []) {
        const raw = d.qty !== undefined ? d.qty : (d.sum !== undefined ? d.sum : d.Sum);
        add(parseDay(d.date), metric, convert(metric, num(raw), m.units), d.source || '');
      }
    }
  } else {
    const list = Array.isArray(body) ? body : (Array.isArray(body && body.samples) ? body.samples : (body ? [body] : []));
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      const day = parseDay(s.date || s.day);
      const src = s.source || '';
      if (s.userEntered === true || s.wasUserEntered === true) { rejected.push({ reason: 'manually entered data is not accepted', day }); continue; }
      const pick = (...keys) => { for (const k of keys) if (s[k] !== undefined && s[k] !== null && s[k] !== '') return num(s[k]); return undefined; };
      const steps = pick('steps', 'step_count');
      const cal = pick('calories', 'active_calories', 'active_energy_kcal', 'active_energy');
      const mins = pick('minutes', 'exercise_minutes', 'workout_minutes');
      let dist = pick('distance_km', 'distance');
      if (dist === undefined) { const m = pick('distance_m'); if (m !== undefined) dist = m / 1000; }
      if (dist === undefined) { const mi = pick('distance_mi'); if (mi !== undefined) dist = mi * 1.609344; }
      if (steps !== undefined) add(day, 'steps', steps, src);
      if (cal !== undefined) add(day, 'calories', cal, src);
      if (mins !== undefined) add(day, 'minutes', mins, src);
      if (dist !== undefined) add(day, 'distance', dist, src);
    }
  }

  // One phone can report the same metric from several devices (iPhone + Watch): take the max, never the sum.
  const best = new Map();
  for (const [k, v] of acc) {
    const [day, metric, source] = k.split('|');
    const key = `${day}|${metric}`;
    if (!best.has(key) || v > best.get(key).value) best.set(key, { day, metric, value: v, source });
  }
  for (const s of best.values()) samples.push({ ...s, value: s.metric === 'distance' ? Math.round(s.value * 1000) / 1000 : Math.round(s.value) });
  return { samples, rejected };
}

async function rateLimit(key, max, windowSec) {
  const { rows } = await query(
    `insert into rate_limits (key, window_start, hits) values ($1, now(), 1)
     on conflict (key) do update set
       hits = case when rate_limits.window_start < now() - ($2 || ' seconds')::interval then 1 else rate_limits.hits + 1 end,
       window_start = case when rate_limits.window_start < now() - ($2 || ' seconds')::interval then now() else rate_limits.window_start end
     returning hits`, [key, String(windowSec)]);
  if (rows[0].hits > max) throw new HttpError(429, 'Too many requests, slow down');
}

const fmt = (metric, v) => `${Number(v).toLocaleString('en-US')} ${E.METRICS[metric].shortUnit}`;

async function ingest(token, body, { today = todayStr() } = {}) {
  const conn = (await query(
    'select * from health_connections where token_hash = $1', [sha256(token)])).rows[0];
  if (!conn || !conn.enabled) throw new HttpError(401, 'Unknown or disabled sync token');
  await rateLimit(`ingest:${conn.id}`, 240, 3600);

  const label = PROVIDERS[conn.provider].name;
  const hash = sha256(JSON.stringify(body));
  const dup = (await query(
    `select 1 from audit_log where user_id = $1 and payload_hash = $2 and verdict = 'VERIFIED' and created_at > now() - interval '24 hours' limit 1`,
    [conn.user_id, hash])).rows[0];
  if (dup) {
    await query(`insert into audit_log (user_id, provider, verdict, source_label, detail, delta, payload_hash)
                 values ($1,$2,'DEDUPED',$3,'Identical payload already ingested in the last 24h','0 (ignored)',$4)`, [conn.user_id, conn.provider, label, hash]);
    return { ok: true, deduped: true, accepted: 0, quarantined: 0 };
  }

  const { samples, rejected } = parsePayload(body);
  const oldest = addDays(today, -45);
  const newest = addDays(today, 1);
  const accepted = [];
  const quarantined = [];
  for (const s of samples) {
    if (s.day < oldest || s.day > newest) { rejected.push({ reason: `date ${s.day} outside the accepted window`, day: s.day }); continue; }
    if (s.value > E.METRICS[s.metric].maxPlausibleDaily) { quarantined.push(s); continue; }
    accepted.push(s);
  }

  const userChallenges = (await query('select challenge_id from memberships where user_id = $1', [conn.user_id])).rows.map((r) => r.challenge_id);
  const before = await loadBundles(userChallenges, query, today);

  await tx(async (q) => {
    for (const s of accepted) {
      await q(`insert into daily_metrics (user_id, day, metric, provider, value, source_name)
               values ($1,$2,$3,$4,$5,$6)
               on conflict (user_id, day, metric, provider) do update set value = excluded.value, source_name = excluded.source_name, updated_at = now()`,
        [conn.user_id, s.day, s.metric, conn.provider, s.value, s.source || null]);
    }
    await q('update health_connections set last_sync_at = now(), samples_received = samples_received + $2 where id = $1', [conn.id, accepted.length]);
  });

  // Overlap between two sources for the same day/metric: priority rule picks one, log it for transparency.
  let overlaps = 0;
  if (accepted.length) {
    const days = [...new Set(accepted.map((s) => s.day))];
    const { rows } = await query(
      `select day::text, metric, count(distinct provider) n from daily_metrics
       where user_id = $1 and day = any($2::date[]) group by day, metric having count(distinct provider) > 1`, [conn.user_id, days]);
    overlaps = rows.length;
  }

  const after = await loadBundles(userChallenges, query, today);
  for (const id of userChallenges) {
    const b0 = before[id]; const b1 = after[id];
    if (!b0 || !b1) continue;
    const delta = b1.scores[conn.user_id].score - b0.scores[conn.user_id].score;
    if (delta === 0) continue;
    const unit = E.METRICS[b1.ch.metric].shortUnit;
    await query(`insert into events (challenge_id, user_id, kind, text, amount, unit, source)
                 values ($1,$2,'sync',$3,$4,$5,$6)`,
      [id, conn.user_id, `Auto-synced from phone health data (wasUserEntered: false)`, delta, unit, label]);
  }

  const detail = accepted.length
    ? `${accepted.length} daily total${accepted.length === 1 ? '' : 's'}: ${accepted.slice(0, 4).map((s) => `${s.day.slice(5)} ${fmt(s.metric, s.value)}`).join(' • ')}`
    : 'No new data';
  if (accepted.length || (!quarantined.length && !rejected.length)) {
    await query(`insert into audit_log (user_id, provider, verdict, source_label, detail, delta, payload_hash)
                 values ($1,$2,'VERIFIED',$3,$4,$5,$6)`, [conn.user_id, conn.provider, label, detail, `+${accepted.length} day-metrics`, hash]);
  }
  for (const s of quarantined) {
    await query(`insert into audit_log (user_id, provider, verdict, source_label, detail, delta, payload_hash)
                 values ($1,$2,'QUARANTINED',$3,$4,$5,$6)`,
      [conn.user_id, conn.provider, label, `Implausible ${s.metric} total for ${s.day} (above ${fmt(s.metric, E.METRICS[s.metric].maxPlausibleDaily)}/day ceiling) - ask your admin to review`, `${fmt(s.metric, s.value)} (blocked)`, hash]);
  }
  for (const r of rejected) {
    await query(`insert into audit_log (user_id, provider, verdict, source_label, detail, delta, payload_hash)
                 values ($1,$2,'QUARANTINED',$3,$4,'rejected',$5)`, [conn.user_id, conn.provider, label, `Rejected: ${r.reason}`, hash]);
  }
  if (overlaps) {
    await query(`insert into audit_log (user_id, provider, verdict, source_label, detail, delta, payload_hash)
                 values ($1,$2,'DEDUPED',$3,$4,'0 (merged)',$5)`,
      [conn.user_id, conn.provider, label, `${overlaps} day-metric(s) reported by 2+ sources; your highest-priority source is used so nothing is double-counted`, hash]);
  }
  return { ok: true, accepted: accepted.length, quarantined: quarantined.length, rejected: rejected.length, days: [...new Set(accepted.map((s) => s.day))].sort() };
}

module.exports = { parsePayload, ingest, parseDay };
