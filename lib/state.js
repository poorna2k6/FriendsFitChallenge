const { query } = require('./db');
const E = require('../public/engine.js');
const { challengeDay, scoreMembers, todayStr, addDays } = require('./scoring');
const { relTime } = require('./http');
const { DEFAULT_PEEK, PROVIDERS } = require('./defaults');

const modEnabled = (ch, id) => (ch.modules || []).some((m) => m.id === id && m.enabled);
const dollars = (c) => Math.round(Number(c)) / 100;

/** Daily rows resolved to one provider per (user, day, metric): lowest priority number wins. */
async function resolvedDaily(userIds, from, to, q = query) {
  if (!userIds.length) return [];
  const { rows } = await q(
    `select user_id, day::text as day, metric, value from (
       select dm.user_id, dm.day, dm.metric, dm.value,
              row_number() over (partition by dm.user_id, dm.day, dm.metric
                                 order by coalesce(hc.priority, 100), dm.provider) rn
       from daily_metrics dm
       left join health_connections hc on hc.user_id = dm.user_id and hc.provider = dm.provider
       where dm.user_id = any($1) and dm.day between $2 and $3 and coalesce(hc.enabled, true)
     ) t where rn = 1`, [userIds, from, to]);
  return rows;
}

/** Loads everything needed to evaluate a set of challenges (true, unredacted numbers). */
async function loadBundles(challengeIds, q = query, today = todayStr()) {
  if (!challengeIds.length) return {};
  const [chs, mems, adjs, passes, pays] = await Promise.all([
    q('select * from challenges where id = any($1)', [challengeIds]),
    q(`select m.*, u.name, u.avatar, u.color, u.email from memberships m join users u on u.id = m.user_id
       where m.challenge_id = any($1) order by m.joined_at, u.name`, [challengeIds]),
    q(`select challenge_id, user_id, day::text as day, amount from adjustments where challenge_id = any($1)`, [challengeIds]),
    q('select * from peek_passes where challenge_id = any($1) order by created_at', [challengeIds]),
    q('select * from peek_payments where challenge_id = any($1)', [challengeIds])
  ]);
  const allUsers = [...new Set(mems.rows.map((m) => m.user_id))];
  const conns = allUsers.length
    ? (await q('select user_id, provider, enabled, priority, last_sync_at from health_connections where user_id = any($1) order by priority', [allUsers])).rows
    : [];

  const out = {};
  for (const ch of chs.rows) {
    ch.peek = { ...DEFAULT_PEEK, ...(ch.peek || {}) };
    const day = challengeDay(ch.start_date, ch.duration_key, today);
    const members = mems.rows.filter((m) => m.challenge_id === ch.id);
    const ids = members.map((m) => m.user_id);
    const first = String(ch.start_date).slice(0, 10);
    const daily = await resolvedDaily(ids, first, addDays(first, day.daysElapsed - 1), q);
    const myAdj = adjs.rows.filter((a) => a.challenge_id === ch.id);
    const scores = scoreMembers(ch, ids, daily, myAdj, { today, weekend2x: modEnabled(ch, 'mod_weekend2x') });
    const chPasses = passes.rows.filter((p) => p.challenge_id === ch.id);
    const chPays = pays.rows.filter((p) => p.challenge_id === ch.id);

    const peek = { totalPeekPot: 0, spyRoyaltiesByMember: {}, peekFeesByMember: {} };
    for (const p of chPasses) peek.peekFeesByMember[p.viewer_id] = (peek.peekFeesByMember[p.viewer_id] || 0) + p.fee_cents / 100;
    for (const p of chPays) {
      if (p.to_user) peek.spyRoyaltiesByMember[p.to_user] = (peek.spyRoyaltiesByMember[p.to_user] || 0) + p.amount_cents / 100;
      else peek.totalPeekPot += p.amount_cents / 100;
    }
    peek.totalPeekPot = Math.round(peek.totalPeekPot * 100) / 100;

    const graceMap = {};
    if (modEnabled(ch, 'mod_grace')) members.forEach((m) => { if (m.grace_active) graceMap[m.user_id] = true; });

    const friends = members.map((m) => {
      const mc = conns.filter((c) => c.user_id === m.user_id && c.enabled);
      return {
        id: m.user_id, name: m.name, avatar: m.avatar, color: m.color, paid: m.paid,
        score: scores[m.user_id].score, streak: scores[m.user_id].streak,
        device: mc.length ? (PROVIDERS[mc[0].provider] || {}).name.replace(/ \(.*\)/, '') : 'Not synced yet'
      };
    });
    const legacy = { buyIn: ch.buy_in_cents / 100, cutoffPct: Number(ch.cutoff_pct), slashPct: Number(ch.slash_pct),
      distributionMode: ch.distribution_mode, dailyBenchmark: Number(ch.daily_benchmark), daysElapsed: day.daysElapsed, friends };
    const calc = E.computeStandings(legacy, {
      peek, antiSandbag: modEnabled(ch, 'mod_antisandbag'), graceMap,
      routingMode: ch.peek.routingMode, peekCap: modEnabled(ch, 'mod_peekcap')
    });
    out[ch.id] = { ch, day, members, friends, scores, calc, peek, passes: chPasses, payments: chPays, graceMap, legacy };
  }
  return out;
}

const activePass = (p, daysElapsed) => p.expires_day > daysElapsed;

/** What `viewerId` may know about a bundle: { admin, full, unlockedAll, unlocked:Set } */
function visibility(b, viewerId) {
  const admin = b.ch.admin_id === viewerId;
  const blind = b.ch.peek.blindMode !== false;
  const mine = b.passes.filter((p) => p.viewer_id === viewerId && activePass(p, b.day.daysElapsed));
  const unlockedAll = mine.some((p) => !p.target_id);
  const unlocked = new Set(mine.filter((p) => p.target_id).map((p) => p.target_id));
  return { admin, blind, unlockedAll, unlocked, full: admin || !blind || unlockedAll, mine };
}

function redactCalc(b, viewerId, vis) {
  const c = b.calc;
  if (vis.full) return { ...c, redacted: false };
  const rows = c.rows.map((r) => {
    const self = r.id === viewerId;
    const seeScore = self || vis.unlocked.has(r.id);
    const base = { id: r.id, name: r.name, avatar: r.avatar, color: r.color, device: r.device, streak: r.streak, paid: r.paid };
    return {
      ...base, hidden: !seeScore, hiddenMath: true,
      score: seeScore ? r.score : 0, rank: 0, pctOfTop: 0, isTopLeader: false, isSafe: self ? r.isSafe : true,
      gapToCutoff: 0, bufferAboveCutoff: 0, slashedAmount: 0, retainedBuyIn: c.buyIn, achievementSharePct: 0, bonusWon: 0,
      spyRoyaltyEarned: self ? r.spyRoyaltyEarned : 0, peekSpent: self ? r.peekSpent : 0, stakeDeductedByPeeks: 0,
      finalPayout: 0, netProfit: 0, roiPct: 0
    };
  });
  return { ...c, rows, topLeader: null, topScore: 0, cutoffScore: 0, forfeitedPool: 0, totalBonusPool: c.peekPotBonus,
    qualifiersCount: 0, failedCount: 0, sumQualifierScores: 0, redacted: true };
}

async function buildState(userId, today = todayStr()) {
  const me = (await query('select id, email, name, avatar, color, created_at from users where id = $1', [userId])).rows[0];
  if (!me) return null;
  const mine = (await query(
    `select m.challenge_id from memberships m join challenges c on c.id = m.challenge_id
     where m.user_id = $1 order by c.created_at desc`, [userId])).rows.map((r) => r.challenge_id);
  const bundles = await loadBundles(mine, query, today);

  const [events, glitch, invites, conns, audit] = await Promise.all([
    mine.length ? query(
      `select * from (select e.*, u.name as uname, row_number() over (partition by e.challenge_id order by e.created_at desc) rn
        from events e left join users u on u.id = e.user_id where e.challenge_id = any($1)) t where rn <= 40 order by created_at desc`, [mine]) : { rows: [] },
    mine.length ? query(
      `select g.*, u.name from glitch_requests g join users u on u.id = g.user_id
       where g.challenge_id = any($1) and g.status = 'pending' order by g.created_at desc`, [mine]) : { rows: [] },
    mine.length ? query(`select * from invitations where challenge_id = any($1) and status = 'sent' order by created_at desc`, [mine]) : { rows: [] },
    query('select id, provider, label, token_hint, priority, enabled, last_sync_at, samples_received, created_at from health_connections where user_id = $1 order by priority', [userId]),
    query('select * from audit_log where user_id = $1 order by created_at desc limit 30', [userId])
  ]);

  const challenges = mine.filter((id) => bundles[id]).map((id) => {
    const b = bundles[id];
    const ch = b.ch;
    const vis = visibility(b, userId);
    const calc = redactCalc(b, userId, vis);
    const admin = b.members.find((m) => m.user_id === ch.admin_id);
    const friends = b.friends.map((f) => {
      const row = calc.rows.find((r) => r.id === f.id);
      return { ...f, score: row ? row.score : 0, hidden: Boolean(row && row.hidden) };
    });

    const myPeekMap = {};
    const unlockedUntil = {};
    let allUntil = 0;
    vis.mine.forEach((p) => {
      if (p.target_id) unlockedUntil[p.target_id] = Math.max(unlockedUntil[p.target_id] || 0, p.expires_day);
      else allUntil = Math.max(allUntil, p.expires_day);
    });
    myPeekMap.unlockedByMember = { [userId]: [...vis.unlocked] };
    myPeekMap.unlockedAllByMember = { [userId]: vis.full }; // admins / non-blind challenges already see everything
    myPeekMap.unlockedUntilByMember = { [userId]: unlockedUntil };
    myPeekMap.unlockedAllUntilByMember = { [userId]: allUntil };
    const evs = events.rows.filter((e) => e.challenge_id === id);
    const peekEvents = evs.filter((e) => e.kind === 'peek' || e.kind === 'nudge').map((e) => ({ time: relTime(e.created_at), text: e.text }));

    const dCfg = E.DURATIONS[ch.duration_key];
    return {
      id, title: ch.title, durationKey: ch.duration_key, daysElapsed: b.day.daysElapsed, totalDays: dCfg.totalDays, ended: b.day.ended,
      startDate: String(ch.start_date).slice(0, 10), metric: ch.metric, buyIn: ch.buy_in_cents / 100,
      cutoffPct: Number(ch.cutoff_pct), slashPct: Number(ch.slash_pct), distributionMode: ch.distribution_mode,
      dailyBenchmark: Number(ch.daily_benchmark), governanceLocked: ch.governance_locked, inviteCode: ch.invite_code,
      adminId: ch.admin_id, adminName: admin ? admin.name : 'Host', isAdmin: vis.admin, isNewlyCreated: vis.admin && (Date.now() - new Date(ch.created_at).getTime() < 7 * 86400000),
      friends, calc,
      peekConfig: ch.peek, modules: ch.modules,
      graceActive: Object.fromEntries(b.members.filter((m) => m.user_id === userId || vis.admin).map((m) => [m.user_id, Boolean(b.graceMap[m.user_id])])),
      peekData: {
        ...myPeekMap,
        peekFeesByMember: vis.admin ? b.peek.peekFeesByMember : { [userId]: b.peek.peekFeesByMember[userId] || 0 },
        spyRoyaltiesByMember: vis.admin ? b.peek.spyRoyaltiesByMember : { [userId]: b.peek.spyRoyaltiesByMember[userId] || 0 },
        totalPeekPot: b.peek.totalPeekPot, peekEvents
      },
      logs: evs.filter((e) => !['peek', 'nudge'].includes(e.kind)).map((e) => {
        // Blind mode: never leak another member's amounts through the activity feed.
        const canSee = vis.full || e.user_id === userId || (e.user_id && vis.unlocked.has(e.user_id)) || e.amount === null;
        return {
          time: relTime(e.created_at), at: e.created_at, friend: e.uname || 'System', hidden: !canSee,
          amount: canSee && e.amount !== null ? Number(e.amount) : 0, unit: e.unit || '', source: e.source || e.kind,
          note: canSee ? e.text : 'Progress hidden in Blind Mode (pay to peek)'
        };
      }),
      glitchRequests: glitch.rows.filter((g) => g.challenge_id === id && (vis.admin || g.user_id === userId)).map((g) => ({
        id: g.id, friendId: g.user_id, friendName: g.name, delta: Number(g.delta), reason: g.reason, time: relTime(g.created_at), status: g.status
      })),
      invitations: vis.admin ? invites.rows.filter((i) => i.challenge_id === id).map((i) => ({
        id: i.id, name: i.name, contact: i.contact, channel: i.channel, device: i.device,
        status: `Invite Sent • Awaiting $${ch.buy_in_cents / 100} Buy-In`, sentAt: relTime(i.created_at)
      })) : [],
      streakMe: (b.friends.find((f) => f.id === userId) || {}).streak || 0
    };
  });

  const verified = audit.rows.filter((a) => a.verdict === 'VERIFIED').length;
  return {
    me, today, serverTime: new Date().toISOString(), challenges,
    connections: conns.rows.map((c) => ({ ...c, ...PROVIDERS[c.provider], providerKey: c.provider })),
    providers: Object.entries(PROVIDERS).map(([key, p]) => ({ key, ...p })),
    auditLedger: audit.rows.map((a) => ({
      time: relTime(a.created_at), member: me.name, source: a.source_label, biometrics: a.detail || '—',
      hash: a.payload_hash ? `0x${a.payload_hash.slice(0, 6)}...${a.payload_hash.slice(-4)}` : '—', delta: a.delta || '—', verdict: a.verdict, note: a.detail || ''
    })),
    securityMetrics: {
      verifiedPackets: verified, blockedSpoofs: audit.rows.filter((a) => a.verdict === 'QUARANTINED').length,
      dedupedWorkouts: audit.rows.filter((a) => a.verdict === 'DEDUPED').length
    }
  };
}

module.exports = { buildState, loadBundles, visibility, modEnabled, activePass, resolvedDaily, dollars };
