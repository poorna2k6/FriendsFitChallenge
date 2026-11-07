// Personal history + achievements, computed from the user's own synced daily totals.
// Nothing here exposes other members' data, so it is safe in blind mode.
const { query } = require('./db');
const { resolvedDaily } = require('./state');
const { addDays } = require('./scoring');

const STEP_GOAL = 10000;
const METRICS = ['steps', 'calories', 'minutes', 'distance'];
const LOOKBACK = 730; // days of history scanned for lifetime badges

const BADGES = [
  { id: 'first_sync', icon: '📲', title: 'First Sync', desc: 'Your phone sent its first health data' },
  { id: 'squad_up', icon: '🤝', title: 'Squad Up', desc: 'Joined a challenge' },
  { id: 'host', icon: '👑', title: 'Host', desc: 'Created a challenge for your friends' },
  { id: 'goal_day', icon: '👟', title: '10K Day', desc: 'Walked 10,000 steps in one day', target: 10000, kind: 'best' },
  { id: 'big_day', icon: '🚀', title: '15K Day', desc: 'Walked 15,000 steps in one day', target: 15000, kind: 'best' },
  { id: 'epic_day', icon: '🏔️', title: '20K Day', desc: 'Walked 20,000 steps in one day', target: 20000, kind: 'best' },
  { id: 'streak_3', icon: '🔥', title: '3-Day Streak', desc: '10K steps 3 days in a row', target: 3, kind: 'streak' },
  { id: 'streak_7', icon: '⚡', title: '7-Day Streak', desc: '10K steps 7 days in a row', target: 7, kind: 'streak' },
  { id: 'streak_30', icon: '🏆', title: '30-Day Streak', desc: '10K steps 30 days in a row', target: 30, kind: 'streak' },
  { id: 'total_100k', icon: '💯', title: '100K Club', desc: '100,000 total steps', target: 100000, kind: 'total' },
  { id: 'total_1m', icon: '🌍', title: 'Million Stepper', desc: '1,000,000 total steps', target: 1000000, kind: 'total' },
  { id: 'active_week', icon: '⏱️', title: 'Active Week', desc: '150+ workout minutes within 7 days', target: 150, kind: 'week_minutes' },
  { id: 'comeback', icon: '💪', title: 'Comeback', desc: 'Hit 10K again after 3+ days below it' }
];

/** Fill every calendar day in [from, to] with resolved totals (0 when nothing synced). */
function calendar(rows, from, to) {
  const byDay = {};
  for (const r of rows) (byDay[r.day] = byDay[r.day] || {})[r.metric] = Number(r.value);
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = byDay[d] || {};
    out.push({ day: d, steps: v.steps || 0, calories: v.calories || 0, minutes: v.minutes || 0, distance: v.distance || 0, synced: Boolean(byDay[d]) });
  }
  return out;
}

function streaks(days) {
  let best = 0, run = 0, bestEnd = null;
  for (const d of days) {
    run = d.steps >= STEP_GOAL ? run + 1 : 0;
    if (run > best) { best = run; bestEnd = d.day; }
  }
  // current streak: ending today, or yesterday if today's goal isn't reached yet
  let current = 0;
  let i = days.length - 1;
  if (i >= 0 && days[i].steps < STEP_GOAL) i -= 1;
  while (i >= 0 && days[i].steps >= STEP_GOAL) { current += 1; i -= 1; }
  return { best, bestEnd, current };
}

function computeBadges(days, extra) {
  const synced = days.filter((d) => d.synced);
  const st = streaks(days);
  const bestDay = days.reduce((b, d) => (d.steps > b.steps ? d : b), { steps: 0, day: null });
  const totalSteps = days.reduce((s, d) => s + d.steps, 0);
  let bestWeekMinutes = 0;
  for (let i = 0; i < days.length; i++) {
    let s = 0;
    for (let j = Math.max(0, i - 6); j <= i; j++) s += days[j].minutes;
    bestWeekMinutes = Math.max(bestWeekMinutes, s);
  }
  const firstOver = (n) => (days.find((d) => d.steps >= n) || {}).day || null;
  let comebackDay = null;
  let below = 0;
  for (const d of days) {
    if (d.steps >= STEP_GOAL) { if (below >= 3 && synced.length && d.day > synced[0].day && !comebackDay) comebackDay = d.day; below = 0; } else below += 1;
  }

  return BADGES.map((b) => {
    let earned = false, progress = 0, label = '', earnedOn = null;
    switch (b.kind) {
      case 'best': earned = bestDay.steps >= b.target; progress = bestDay.steps / b.target; label = `Best day ${bestDay.steps.toLocaleString('en-US')} / ${b.target.toLocaleString('en-US')}`; earnedOn = firstOver(b.target); break;
      case 'streak': earned = st.best >= b.target; progress = st.best / b.target; label = `Best streak ${st.best} / ${b.target} days`; break;
      case 'total': earned = totalSteps >= b.target; progress = totalSteps / b.target; label = `${Math.round(totalSteps).toLocaleString('en-US')} / ${b.target.toLocaleString('en-US')} steps`; break;
      case 'week_minutes': earned = bestWeekMinutes >= b.target; progress = bestWeekMinutes / b.target; label = `Best 7 days: ${Math.round(bestWeekMinutes)} / ${b.target} min`; break;
      default:
        if (b.id === 'first_sync') { earned = synced.length > 0; earnedOn = synced.length ? synced[0].day : null; label = earned ? '' : 'Connect your health app'; }
        if (b.id === 'squad_up') { earned = extra.challenges > 0; label = earned ? '' : 'Join or create a challenge'; }
        if (b.id === 'host') { earned = extra.hosted > 0; label = earned ? '' : 'Create a challenge'; }
        if (b.id === 'comeback') { earned = Boolean(comebackDay); earnedOn = comebackDay; label = earned ? '' : 'Bounce back after a quiet patch'; }
        progress = earned ? 1 : 0;
    }
    return { ...b, earned, earnedOn, progress: Math.max(0, Math.min(1, progress)), label: earned ? '' : label };
  });
}

function stats(days) {
  const out = {};
  for (const m of METRICS) {
    const vals = days.map((d) => d[m]);
    const total = vals.reduce((s, v) => s + v, 0);
    const best = days.reduce((b, d) => (d[m] > b.value ? { day: d.day, value: d[m] } : b), { day: null, value: 0 });
    const active = days.filter((d) => d.synced).length;
    out[m] = { total, avg: active ? total / active : 0, best };
  }
  out.goalDays = days.filter((d) => d.steps >= STEP_GOAL).length;
  out.syncedDays = days.filter((d) => d.synced).length;
  return out;
}

async function history(userId, today, windowDays) {
  const n = Math.max(7, Math.min(365, Math.round(Number(windowDays) || 30)));
  const from = addDays(today, -(LOOKBACK - 1));
  const [rows, counts] = await Promise.all([
    resolvedDaily([userId], from, today),
    query(`select count(*)::int as challenges, count(*) filter (where c.admin_id = $1)::int as hosted
           from memberships m join challenges c on c.id = m.challenge_id where m.user_id = $1`, [userId])
  ]);
  const all = calendar(rows, from, today);
  const days = all.slice(-n);
  const st = streaks(all);
  return {
    goal: STEP_GOAL, window: n, days, stats: stats(days),
    streak: { current: st.current, best: st.best },
    badges: computeBadges(all, counts.rows[0])
  };
}

module.exports = { history, computeBadges, streaks, calendar, BADGES, STEP_GOAL };
