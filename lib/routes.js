const crypto = require('crypto');
const { query, tx } = require('./db');
const E = require('../public/engine.js');
const A = require('./auth');
const { HttpError, bad, isUuid, compile } = require('./http');
const { buildState, loadBundles, visibility, modEnabled, activePass } = require('./state');
const { todayStr, addDays } = require('./scoring');
const P = require('./peek');
const D = require('./defaults');
const { ingest } = require('./ingest');

// User-visible strings end up in innerHTML templates, so characters that can open tags/attributes are removed up front.
const clean = (s, max) => String(s === undefined || s === null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').replace(/[<>"`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const initials = (name) => {
  const parts = name.split(/\s+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
};
const money = (n) => `$${Number(n).toFixed(2)}`;
const fmtUnits = (n, metric) => `${Number(n).toLocaleString('en-US')} ${E.METRICS[metric].shortUnit}`;
const inviteCode = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from(crypto.randomBytes(8), (b) => a[b % a.length]).join(''); };

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
}

async function limit(key, max, windowSec) {
  const { rows } = await query(
    `insert into rate_limits (key, window_start, hits) values ($1, now(), 1)
     on conflict (key) do update set
       hits = case when rate_limits.window_start < now() - ($2 || ' seconds')::interval then 1 else rate_limits.hits + 1 end,
       window_start = case when rate_limits.window_start < now() - ($2 || ' seconds')::interval then now() else rate_limits.window_start end
     returning hits`, [key, String(windowSec)]);
  if (rows[0].hits > max) throw new HttpError(429, 'Too many attempts, please wait a bit');
}

function setSession(ctx, userId) {
  const secure = (ctx.req.headers['x-forwarded-proto'] || '').includes('https');
  ctx.setCookie = A.sessionCookie(userId, secure);
}

function requireUser(ctx) {
  if (!ctx.userId) throw new HttpError(401, 'Please sign in');
  return ctx.userId;
}

async function memberBundle(ctx, id) {
  const userId = requireUser(ctx);
  if (!isUuid(id)) throw new HttpError(404, 'Challenge not found');
  const m = (await query('select 1 from memberships where challenge_id = $1 and user_id = $2', [id, userId])).rows[0];
  if (!m) throw new HttpError(404, 'Challenge not found');
  const b = (await loadBundles([id], query, ctx.today))[id];
  return { userId, b, vis: visibility(b, userId) };
}

async function adminBundle(ctx, id) {
  const r = await memberBundle(ctx, id);
  if (!r.vis.admin) throw new HttpError(403, 'Only the challenge admin can do this');
  return r;
}

async function addEvent(q, challengeId, userId, kind, text, extra = {}) {
  await q('insert into events (challenge_id, user_id, kind, text, amount, unit, source) values ($1,$2,$3,$4,$5,$6,$7)',
    [challengeId, userId, kind, text, extra.amount ?? null, extra.unit ?? null, extra.source ?? null]);
}

const routes = [];
const route = (method, path, handler) => routes.push([method, path, handler]);

// ---------- auth ----------
route('POST', '/auth/signup', async (ctx) => {
  A.signSession('config-check'); // fail fast (before creating a user) if AUTH_SECRET is missing
  const email = clean(ctx.body.email, 200).toLowerCase();
  const name = clean(ctx.body.name, 60);
  const password = String(ctx.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email address');
  if (!name) throw bad('Enter your name');
  if (password.length < 8) throw bad('Password must be at least 8 characters');
  await limit(`signup:${clientIp(ctx.req)}`, 20, 3600);
  const exists = (await query('select 1 from users where lower(email) = $1', [email])).rows[0];
  if (exists) throw new HttpError(409, 'An account with that email already exists - sign in instead');
  const count = Number((await query('select count(*) from users')).rows[0].count);
  const u = (await query(
    'insert into users (email, name, avatar, color, password_hash) values ($1,$2,$3,$4,$5) returning id',
    [email, name, initials(name), D.PALETTE[count % D.PALETTE.length], await A.hashPassword(password)])).rows[0];
  setSession(ctx, u.id);
  ctx.userId = u.id;
  let joined = null;
  if (ctx.body.joinCode) joined = await joinByCode(ctx, ctx.body.joinCode, ctx.body.invitationId).catch(() => null);
  return { ok: true, joined };
});

route('POST', '/auth/login', async (ctx) => {
  A.signSession('config-check');
  const email = clean(ctx.body.email, 200).toLowerCase();
  await limit(`login:${clientIp(ctx.req)}:${email}`, 10, 900);
  const u = (await query('select * from users where lower(email) = $1', [email])).rows[0];
  const ok = u && await A.verifyPassword(String(ctx.body.password || ''), u.password_hash);
  if (!ok) throw new HttpError(401, 'Email or password is incorrect');
  setSession(ctx, u.id);
  ctx.userId = u.id;
  let joined = null;
  if (ctx.body.joinCode) joined = await joinByCode(ctx, ctx.body.joinCode, ctx.body.invitationId).catch(() => null);
  return { ok: true, joined };
});

route('POST', '/auth/logout', async (ctx) => {
  ctx.setCookie = A.clearCookie((ctx.req.headers['x-forwarded-proto'] || '').includes('https'));
  return { ok: true };
});

route('GET', '/state', async (ctx) => {
  requireUser(ctx);
  const s = await buildState(ctx.userId, ctx.today);
  if (!s) throw new HttpError(401, 'Please sign in');
  return s;
});

route('PATCH', '/me', async (ctx) => {
  const userId = requireUser(ctx);
  const name = clean(ctx.body.name, 60);
  const color = /^#[0-9a-f]{6}$/i.test(ctx.body.color || '') ? ctx.body.color : null;
  if (name) await query('update users set name = $2, avatar = $3 where id = $1', [userId, name, initials(name)]);
  if (color) await query('update users set color = $2 where id = $1', [userId, color]);
  return { ok: true };
});

// ---------- challenges ----------
const RULE_FIELDS = ['metric', 'buyIn', 'cutoffPct', 'slashPct', 'distributionMode', 'durationKey'];

function validateRules(b, partial) {
  const out = {};
  if (!partial || b.title !== undefined) { out.title = clean(b.title, 80); if (!out.title) throw bad('Give the challenge a title'); }
  if (!partial || b.metric !== undefined) { if (!E.METRICS[b.metric]) throw bad('Unknown metric'); out.metric = b.metric; }
  if (!partial || b.durationKey !== undefined) { if (!E.DURATIONS[b.durationKey]) throw bad('Unknown duration'); out.durationKey = b.durationKey; }
  if (!partial || b.buyIn !== undefined) { const v = Number(b.buyIn); if (!(v >= 0.5 && v <= 5000)) throw bad('Buy-in must be between $0.50 and $5,000'); out.buyIn = v; }
  if (!partial || b.cutoffPct !== undefined) { const v = Number(b.cutoffPct); if (!(v >= 10 && v <= 99)) throw bad('Cutoff must be 10-99% of #1'); out.cutoffPct = v; }
  if (!partial || b.slashPct !== undefined) { const v = Number(b.slashPct); if (!(v >= 0 && v <= 100)) throw bad('Penalty must be 0-100%'); out.slashPct = v; }
  if (b.distributionMode !== undefined) {
    if (!['proportional_total', 'proportional_surplus', 'all_in_pot'].includes(b.distributionMode)) throw bad('Unknown distribution mode');
    out.distributionMode = b.distributionMode;
  }
  if (b.dailyBenchmark !== undefined) { const v = Number(b.dailyBenchmark); if (!(v >= 1)) throw bad('Daily target must be at least 1'); out.dailyBenchmark = v; }
  return out;
}

function cleanPeek(p, base) {
  const out = { ...base };
  const src = p || {};
  if (src.blindMode !== undefined) out.blindMode = Boolean(src.blindMode);
  if (['fixed', 'percent'].includes(src.feeType)) out.feeType = src.feeType;
  for (const k of ['peekOneCost', 'peekAllCost']) {
    if (src[k] !== undefined) { const v = Number(src[k]); out[k] = Number.isFinite(v) && v > 0 ? Math.round(Math.min(1000, Math.max(0.01, v)) * 100) / 100 : 0.01; }
  }
  if (['sum_others', 'custom_flat'].includes(src.peekAllMode)) out.peekAllMode = src.peekAllMode;
  if (['weekly', 'daily', 'challenge', 'click'].includes(src.billingWindow)) out.billingWindow = src.billingWindow;
  if (['direct_to_target', 'pot_boost', 'spy_royalty', 'stake_deduct'].includes(src.routingMode)) out.routingMode = src.routingMode;
  return out;
}

route('POST', '/challenges', async (ctx) => {
  const userId = requireUser(ctx);
  const v = validateRules(ctx.body, false);
  const count = Number((await query('select count(*) from challenges where admin_id = $1', [userId])).rows[0].count);
  if (count >= 25) throw bad('You have reached the limit of 25 challenges');
  const id = await tx(async (q) => {
    const c = (await q(
      `insert into challenges (admin_id, title, metric, duration_key, start_date, buy_in_cents, cutoff_pct, slash_pct,
         distribution_mode, daily_benchmark, invite_code, peek, modules)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [userId, v.title, v.metric, v.durationKey, ctx.today, Math.round(v.buyIn * 100), v.cutoffPct, v.slashPct,
        v.distributionMode || 'proportional_total', v.dailyBenchmark || E.METRICS[v.metric].defaultDaily, inviteCode(),
        JSON.stringify(cleanPeek(ctx.body.peek, D.DEFAULT_PEEK)), JSON.stringify(D.DEFAULT_MODULES)])).rows[0];
    await q('insert into memberships (challenge_id, user_id) values ($1,$2)', [c.id, userId]);
    await addEvent(q, c.id, userId, 'system', `Created "${v.title}" and became Group Admin`);
    return c.id;
  });
  return { ok: true, id, message: `Created "${v.title}"! You are the Group Admin - share the invite link to bring friends in.` };
});

route('PATCH', '/challenges/:id', async (ctx) => {
  const { b } = await adminBundle(ctx, ctx.params.id);
  const body = ctx.body;
  const sets = []; const vals = [ctx.params.id];
  const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

  if (body.governanceLocked !== undefined) push('governance_locked', Boolean(body.governanceLocked));
  const touchesRules = RULE_FIELDS.some((k) => body[k] !== undefined);
  if (touchesRules && b.ch.governance_locked && body.governanceLocked !== false) throw new HttpError(403, 'Rules are locked (immutable mid-challenge). Unlock governance first.');

  const v = validateRules(body, true);
  if (v.title !== undefined) push('title', v.title);
  if (v.metric !== undefined) { push('metric', v.metric); if (body.dailyBenchmark === undefined) push('daily_benchmark', E.METRICS[v.metric].defaultDaily); }
  if (v.durationKey !== undefined) push('duration_key', v.durationKey);
  if (v.buyIn !== undefined) push('buy_in_cents', Math.round(v.buyIn * 100));
  if (v.cutoffPct !== undefined) push('cutoff_pct', v.cutoffPct);
  if (v.slashPct !== undefined) push('slash_pct', v.slashPct);
  if (v.distributionMode !== undefined) push('distribution_mode', v.distributionMode);
  if (v.dailyBenchmark !== undefined) push('daily_benchmark', v.dailyBenchmark);
  if (body.daysElapsed !== undefined) {
    const total = E.DURATIONS[v.durationKey || b.ch.duration_key].totalDays;
    const d = Math.max(1, Math.min(total, Math.round(Number(body.daysElapsed) || 1)));
    push('start_date', addDays(ctx.today, -(d - 1)));
  }
  if (body.peek) push('peek', JSON.stringify(cleanPeek(body.peek, b.ch.peek)));
  if (!sets.length) return { ok: true };
  await query(`update challenges set ${sets.join(', ')} where id = $1`, vals);
  return { ok: true };
});

async function joinByCode(ctx, code, invitationId) {
  const userId = requireUser(ctx);
  const ch = (await query('select id, title from challenges where invite_code = $1', [clean(code, 20).toUpperCase()])).rows[0];
  if (!ch) throw new HttpError(404, 'That invite code is not valid');
  const b0 = (await loadBundles([ch.id], query, ctx.today))[ch.id];
  const already = b0.members.some((m) => m.user_id === userId);
  if (!already) {
    if (b0.members.length >= 50) throw bad('This challenge is full');
    const me = (await query('select name from users where id = $1', [userId])).rows[0];
    await tx(async (q) => {
      await q('insert into memberships (challenge_id, user_id) values ($1,$2)', [ch.id, userId]);
      if (modEnabled(b0.ch, 'mod_prorate') && b0.day.daysElapsed > 1 && b0.members.length) {
        const avg = b0.friends.reduce((s, f) => s + f.score, 0) / b0.friends.length;
        const start = Math.round(avg * 0.88);
        if (start > 0) {
          await q(`insert into adjustments (challenge_id, user_id, day, amount, kind, note) values ($1,$2,$3,$4,'prorate',$5)`,
            [ch.id, userId, ctx.today, start, 'Late-join pace normalization (88% of group average)']);
        }
      }
      if (invitationId && isUuid(invitationId)) {
        await q(`update invitations set status = 'accepted', accepted_user_id = $3 where id = $1 and challenge_id = $2`, [invitationId, ch.id, userId]);
      }
      await addEvent(q, ch.id, userId, 'join', `${me.name} joined the challenge`);
    });
  }
  return { id: ch.id, title: ch.title, already };
}

route('POST', '/challenges/join', async (ctx) => {
  const r = await joinByCode(ctx, ctx.body.code, ctx.body.invitationId);
  return { ok: true, ...r, message: r.already ? 'You are already in this challenge' : `You joined "${r.title}"! Connect your phone health app so your steps count.` };
});

route('GET', '/challenges/preview', async (ctx) => {
  const code = clean(ctx.query.code, 20).toUpperCase();
  await limit(`preview:${clientIp(ctx.req)}`, 60, 3600);
  const ch = (await query(
    `select c.title, c.metric, c.duration_key, c.buy_in_cents, u.name as admin_name,
            (select count(*) from memberships m where m.challenge_id = c.id) as members
     from challenges c join users u on u.id = c.admin_id where c.invite_code = $1`, [code])).rows[0];
  if (!ch) throw new HttpError(404, 'That invite code is not valid');
  return { title: ch.title, metric: ch.metric, durationKey: ch.duration_key, buyIn: ch.buy_in_cents / 100, adminName: ch.admin_name, members: Number(ch.members) };
});

route('POST', '/challenges/:id/members/:uid/paid', async (ctx) => {
  await adminBundle(ctx, ctx.params.id);
  if (!isUuid(ctx.params.uid)) throw new HttpError(404, 'Member not found');
  const paid = ctx.body.paid !== false;
  const r = await query('update memberships set paid = $3, paid_at = case when $3 then now() else null end where challenge_id = $1 and user_id = $2', [ctx.params.id, ctx.params.uid, paid]);
  if (!r.rowCount) throw new HttpError(404, 'Member not found');
  return { ok: true, message: `Buy-in marked as ${paid ? 'Paid ✓' : 'Pending ⏳'}` };
});

route('POST', '/challenges/:id/habit', async (ctx) => {
  const { userId, b } = await memberBundle(ctx, ctx.params.id);
  const booster = D.HABIT_BOOSTERS.find((h) => h.id === ctx.body.boosterId);
  if (!booster) throw bad('Unknown habit booster');
  if (b.day.ended) throw bad('This challenge has ended');
  const cfg = E.METRICS[b.ch.metric];
  const bonus = Math.max(5, Math.round(cfg.defaultDaily * booster.bonusPctOfDaily));
  const cap = Math.round(cfg.defaultDaily * D.HABIT_DAILY_CAP_PCT);
  const rows = (await query(`select ref, amount from adjustments where challenge_id = $1 and user_id = $2 and kind = 'habit' and day = $3`, [b.ch.id, userId, ctx.today])).rows;
  if (rows.some((r) => r.ref === booster.id)) throw bad(`You already claimed "${booster.title}" today`);
  const used = rows.reduce((s, r) => s + Number(r.amount), 0);
  if (used + bonus > cap) throw bad(`Daily habit-bonus cap reached (${fmtUnits(cap, b.ch.metric)}/day) - habits are honour-system, so they are capped`);
  const me = (await query('select name from users where id = $1', [userId])).rows[0];
  await tx(async (q) => {
    await q(`insert into adjustments (challenge_id, user_id, day, amount, kind, ref, note, created_by) values ($1,$2,$3,$4,'habit',$5,$6,$2)`,
      [b.ch.id, userId, ctx.today, bonus, booster.id, booster.title]);
    await addEvent(q, b.ch.id, userId, 'habit', booster.title, { amount: bonus, unit: cfg.shortUnit, source: 'Habit Booster (unverified)' });
  });
  return { ok: true, message: `${booster.title}: +${fmtUnits(bonus, b.ch.metric)} added to your score!`, ticker: `${me.name} claimed ${booster.title} (+${bonus.toLocaleString()} ${cfg.shortUnit})` };
});

route('POST', '/challenges/:id/grace', async (ctx) => {
  const { userId, b } = await memberBundle(ctx, ctx.params.id);
  if (!modEnabled(b.ch, 'mod_grace')) throw bad('The Grace Freeze plug-in is switched off for this challenge');
  const mine = b.members.find((m) => m.user_id === userId);
  const next = !mine.grace_active;
  await query('update memberships set grace_active = $3 where challenge_id = $1 and user_id = $2', [b.ch.id, userId, next]);
  await addEvent(query, b.ch.id, userId, 'system', next ? `🛡️ ${mine.name} activated an Injury/Sick-Day Grace Freeze (-5% cutoff relief)` : `${mine.name} deactivated Grace Freeze`);
  return { ok: true, message: next ? `Grace Freeze activated! Your personal survival cutoff is ${Math.max(10, Number(b.ch.cutoff_pct) - 5)}% of #1.` : 'Grace Freeze returned to inventory.' };
});

route('POST', '/challenges/:id/nudge', async (ctx) => {
  const { userId, b } = await memberBundle(ctx, ctx.params.id);
  const emoji = ['🔥', '👀', '⚡'].includes(ctx.body.emoji) ? ctx.body.emoji : '🔥';
  const verbs = { '🔥': 'hyped up', '👀': 'poked', '⚡': 'taunted' };
  const me = b.members.find((m) => m.user_id === userId);
  const target = ctx.body.targetId ? b.members.find((m) => m.user_id === ctx.body.targetId) : null;
  await limit(`nudge:${userId}`, 60, 3600);
  const text = target ? `${emoji} ${me.name} ${verbs[emoji]} ${target.name} to keep moving!` : `${emoji} ${me.name} sent a ${verbs[emoji]} wave to the whole ${b.ch.title} squad!`;
  await addEvent(query, b.ch.id, userId, 'nudge', text);
  return { ok: true, message: text, ticker: text };
});

route('POST', '/challenges/:id/peek', async (ctx) => {
  const { userId, b, vis } = await memberBundle(ctx, ctx.params.id);
  const cfg = b.ch.peek;
  if (vis.admin) throw bad('Admins already see every score');
  if (!cfg.blindMode) throw bad('Blind mode is off - everything is already visible');
  const me = b.members.find((m) => m.user_id === userId);
  const others = b.members.filter((m) => m.user_id !== userId);
  const expiresDay = b.day.daysElapsed + Math.max(1, P.passDays(cfg));
  const isAll = ctx.body.target === 'all';

  if (!isAll) {
    if (!isUuid(ctx.body.target) || !others.some((m) => m.user_id === ctx.body.target)) throw bad('Pick a member to peek at');
    if (vis.unlockedAll || vis.unlocked.has(ctx.body.target)) return { ok: true, free: true, message: 'No extra charge - your pass is still active.' };
    const target = others.find((m) => m.user_id === ctx.body.target);
    const fee = P.singleCostCents(b.ch, cfg);
    const parts = P.route(cfg, fee, [target.user_id]);
    await tx(async (q) => {
      const pass = (await q('insert into peek_passes (challenge_id, viewer_id, target_id, fee_cents, expires_day) values ($1,$2,$3,$4,$5) returning id', [b.ch.id, userId, target.user_id, fee, expiresDay])).rows[0];
      for (const p of parts) await q('insert into peek_payments (pass_id, challenge_id, to_user, amount_cents) values ($1,$2,$3,$4)', [pass.id, b.ch.id, p.to, p.cents]);
      await addEvent(q, b.ch.id, userId, 'peek', `${me.name} paid ${money(fee / 100)} to peek at ${target.name}'s stats (${describeRoute(cfg, parts, [target])})`);
    });
    return { ok: true, charged: fee / 100, message: `Unlocked ${target.name} (-${money(fee / 100)}). Pass active through day ${expiresDay - 1}.` };
  }

  if (vis.unlockedAll) return { ok: true, free: true, message: 'All members already unlocked under your active pass.' };
  const unpeeked = others.filter((m) => !vis.unlocked.has(m.user_id));
  const targets = unpeeked.length ? unpeeked : others;
  if (!targets.length) throw bad('There is nobody else in this challenge yet');
  const fee = P.allCostCents(b.ch, cfg, targets.length);
  const parts = P.route(cfg, fee, targets.map((t) => t.user_id));
  await tx(async (q) => {
    const pass = (await q('insert into peek_passes (challenge_id, viewer_id, target_id, fee_cents, expires_day) values ($1,$2,null,$3,$4) returning id', [b.ch.id, userId, fee, expiresDay])).rows[0];
    for (const p of parts) await q('insert into peek_payments (pass_id, challenge_id, to_user, amount_cents) values ($1,$2,$3,$4)', [pass.id, b.ch.id, p.to, p.cents]);
    await addEvent(q, b.ch.id, userId, 'peek', `🔮 ${me.name} paid ${money(fee / 100)} (sum of ${targets.length} others) to unlock all & reveal the 100% bar (${describeRoute(cfg, parts, targets)})`);
  });
  return { ok: true, charged: fee / 100, message: `Unlocked all ${targets.length} members (-${money(fee / 100)}).` };
});

function describeRoute(cfg, parts, targets) {
  const mode = cfg.routingMode;
  const toPot = parts.filter((p) => !p.to).reduce((s, p) => s + p.cents, 0) / 100;
  const toPeople = parts.filter((p) => p.to).reduce((s, p) => s + p.cents, 0) / 100;
  if (mode === 'direct_to_target') return targets.length === 1 ? `100% (${money(toPeople)}) sent directly to ${targets[0].name}` : `${money(toPeople)} split directly among ${targets.length} members`;
  if (mode === 'spy_royalty') return `80% (${money(toPeople)}) to ${targets.length === 1 ? targets[0].name : targets.length + ' members'} + ${money(toPot)} to Pot`;
  if (mode === 'stake_deduct') return `Deducted ${money(toPot)} from their buy-in stake into Winners Pot`;
  return `Added +${money(toPot)} to Winners Bonus Pot`;
}

route('POST', '/challenges/:id/override', async (ctx) => {
  const { userId, b } = await adminBundle(ctx, ctx.params.id);
  const targetId = ctx.body.memberId;
  const target = b.friends.find((f) => f.id === targetId);
  if (!target) throw bad('Pick a member');
  const mode = ['add', 'set', 'subtract'].includes(ctx.body.mode) ? ctx.body.mode : 'add';
  const amount = Math.max(0, Number(ctx.body.amount) || 0);
  if (!(amount > 0) && mode !== 'set') throw bad('Enter an amount');
  const reason = clean(ctx.body.reason, 120) || 'Technical Sync Glitch';
  const prev = target.score;
  let next = mode === 'set' ? amount : mode === 'subtract' ? Math.max(0, prev - amount) : prev + amount;
  const delta = next - prev;
  if (delta === 0) throw bad('That would not change the score');
  const unit = E.METRICS[b.ch.metric].shortUnit;
  await tx(async (q) => {
    await q(`insert into adjustments (challenge_id, user_id, day, amount, kind, note, created_by) values ($1,$2,$3,$4,'admin_override',$5,$6)`, [b.ch.id, targetId, ctx.today, delta, reason, userId]);
    await addEvent(q, b.ch.id, targetId, 'admin_override', `${reason} (${prev.toLocaleString()} → ${next.toLocaleString()} ${unit})`, { amount: Math.abs(delta), unit, source: 'Admin Glitch Override' });
    await q(`insert into audit_log (user_id, verdict, source_label, detail, delta) values ($1,'VERIFIED','👑 Admin Manual Override',$2,$3)`, [targetId, `Prev ${prev.toLocaleString()} → New ${next.toLocaleString()}: ${reason}`, `${delta >= 0 ? '+' : ''}${delta.toLocaleString()} ${unit}`]);
  });
  const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toLocaleString()} ${unit}`;
  return { ok: true, message: `Admin override applied for ${target.name}: ${deltaStr}`, ticker: `👑 Admin adjusted ${target.name}'s score (${deltaStr}) due to: ${reason}` };
});

route('POST', '/challenges/:id/glitch', async (ctx) => {
  const { userId, b } = await memberBundle(ctx, ctx.params.id);
  const delta = Number(ctx.body.delta);
  const reason = clean(ctx.body.reason, 160);
  if (!(delta > 0) || !reason) throw bad('Enter the missing amount and a reason');
  if (delta > E.METRICS[b.ch.metric].maxPlausibleDaily * 2) throw bad('That amount is higher than any plausible two days of activity');
  await limit(`glitch:${userId}`, 20, 86400);
  await query('insert into glitch_requests (challenge_id, user_id, delta, reason) values ($1,$2,$3,$4)', [b.ch.id, userId, delta, reason]);
  return { ok: true, message: 'Request sent to the challenge admin for 1-tap approval.' };
});

route('POST', '/challenges/:id/glitch/:rid/:action', async (ctx) => {
  const { userId, b } = await adminBundle(ctx, ctx.params.id);
  if (!isUuid(ctx.params.rid) || !['approve', 'reject'].includes(ctx.params.action)) throw new HttpError(404, 'Not found');
  const g = (await query(`select * from glitch_requests where id = $1 and challenge_id = $2 and status = 'pending'`, [ctx.params.rid, b.ch.id])).rows[0];
  if (!g) throw new HttpError(404, 'Request not found or already handled');
  const unit = E.METRICS[b.ch.metric].shortUnit;
  await tx(async (q) => {
    await q(`update glitch_requests set status = $2, resolved_at = now(), resolved_by = $3 where id = $1`, [g.id, ctx.params.action === 'approve' ? 'approved' : 'rejected', userId]);
    if (ctx.params.action === 'approve') {
      await q(`insert into adjustments (challenge_id, user_id, day, amount, kind, note, created_by) values ($1,$2,$3,$4,'glitch_fix',$5,$6)`, [b.ch.id, g.user_id, ctx.today, g.delta, g.reason, userId]);
      await addEvent(q, b.ch.id, g.user_id, 'glitch_fix', `Admin approved: ${g.reason}`, { amount: Number(g.delta), unit, source: 'Approved Glitch Fix' });
      await q(`insert into audit_log (user_id, verdict, source_label, detail, delta) values ($1,'VERIFIED','👑 Admin-approved fix request',$2,$3)`, [g.user_id, g.reason, `+${Number(g.delta).toLocaleString()} ${unit}`]);
    }
  });
  return { ok: true, message: ctx.params.action === 'approve' ? `Approved +${fmtUnits(g.delta, b.ch.metric)}` : 'Request declined.' };
});

route('POST', '/challenges/:id/invites', async (ctx) => {
  const { userId, b } = await adminBundle(ctx, ctx.params.id);
  const name = clean(ctx.body.name, 60);
  const contact = clean(ctx.body.contact, 120);
  if (!name || !contact) throw bad('Enter a name and contact');
  const channel = ['WhatsApp', 'SMS Text', 'Email'].includes(ctx.body.channel) ? ctx.body.channel : 'WhatsApp';
  const device = clean(ctx.body.device, 40) || 'Apple Health';
  const inv = (await query('insert into invitations (challenge_id, name, contact, channel, device, created_by) values ($1,$2,$3,$4,$5,$6) returning id', [b.ch.id, name, contact, channel, device, userId])).rows[0];
  return { ok: true, id: inv.id, code: b.ch.invite_code, message: `Invite created for ${name}. Send them the link (copied to your clipboard).` };
});

route('DELETE', '/challenges/:id/invites/:iid', async (ctx) => {
  const { b } = await adminBundle(ctx, ctx.params.id);
  if (!isUuid(ctx.params.iid)) throw new HttpError(404, 'Not found');
  await query(`update invitations set status = 'cancelled' where id = $1 and challenge_id = $2`, [ctx.params.iid, b.ch.id]);
  return { ok: true, message: 'Removed pending invitation.' };
});

route('POST', '/challenges/:id/modules/:modId/toggle', async (ctx) => {
  const { b } = await adminBundle(ctx, ctx.params.id);
  const mods = b.ch.modules.map((m) => (m.id === ctx.params.modId ? { ...m, enabled: !m.enabled } : m));
  const mod = mods.find((m) => m.id === ctx.params.modId);
  if (!mod) throw new HttpError(404, 'Module not found');
  await query('update challenges set modules = $2 where id = $1', [b.ch.id, JSON.stringify(mods)]);
  return { ok: true, message: `${mod.icon} ${mod.title}: ${mod.enabled ? 'ENABLED ✓' : 'DISABLED'}` };
});

route('POST', '/challenges/:id/modules', async (ctx) => {
  const { b } = await adminBundle(ctx, ctx.params.id);
  const title = clean(ctx.body.title, 80);
  if (!title) throw bad('Name your module');
  const mods = [{ id: `mod_custom_${Date.now()}`, icon: '✨', title, category: 'Custom User Plug-In', desc: 'User-created modular extension active for this challenge group.', enabled: true }, ...b.ch.modules].slice(0, 30);
  await query('update challenges set modules = $2 where id = $1', [b.ch.id, JSON.stringify(mods)]);
  return { ok: true, message: `Installed & enabled custom module: "${title}"` };
});

// ---------- health sync ----------
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

route('POST', '/health/connections', async (ctx) => {
  const userId = requireUser(ctx);
  const provider = ctx.body.provider;
  if (!D.PROVIDERS[provider]) throw bad('Choose Apple Health, Health Connect or Webhook');
  const token = A.newToken('sf');
  const label = D.PROVIDERS[provider].name;
  await query(
    `insert into health_connections (user_id, provider, label, token_hash, token_hint, priority)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (user_id, provider) do update set token_hash = excluded.token_hash, token_hint = excluded.token_hint, enabled = true`,
    [userId, provider, label, A.sha256(token), token.slice(-4), D.PROVIDERS[provider].priority]);
  return { ok: true, provider, token, ingestUrl: `${baseUrl(ctx.req)}/api/ingest/${token}`, message: 'Connection ready - copy the sync URL now, it is only shown once.' };
});

route('PATCH', '/health/connections/:id', async (ctx) => {
  const userId = requireUser(ctx);
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'Not found');
  const sets = []; const vals = [ctx.params.id, userId];
  if (ctx.body.priority !== undefined) { vals.push(Math.max(1, Math.min(99, Math.round(Number(ctx.body.priority) || 10)))); sets.push(`priority = $${vals.length}`); }
  if (ctx.body.enabled !== undefined) { vals.push(Boolean(ctx.body.enabled)); sets.push(`enabled = $${vals.length}`); }
  if (!sets.length) return { ok: true };
  const r = await query(`update health_connections set ${sets.join(', ')} where id = $1 and user_id = $2`, vals);
  if (!r.rowCount) throw new HttpError(404, 'Not found');
  return { ok: true };
});

route('DELETE', '/health/connections/:id', async (ctx) => {
  const userId = requireUser(ctx);
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'Not found');
  const r = await query('delete from health_connections where id = $1 and user_id = $2', [ctx.params.id, userId]);
  if (!r.rowCount) throw new HttpError(404, 'Not found');
  return { ok: true, message: 'Disconnected. Already-synced days stay in your history.' };
});

route('GET', '/health/daily', async (ctx) => {
  const userId = requireUser(ctx);
  const days = Math.min(60, Math.max(1, Number(ctx.query.days) || 14));
  const { rows } = await query(
    `select day::text, metric, provider, value::float8 as value from daily_metrics
     where user_id = $1 and day >= $2 order by day desc, metric`, [userId, addDays(ctx.today, -days)]);
  return { rows };
});

// Public: token-authenticated phone ingest
route('POST', '/ingest/:token', async (ctx) => ingest(ctx.params.token, ctx.body, { today: ctx.today }));
route('GET', '/ingest/:token', async (ctx) => {
  const c = (await query('select provider, enabled, last_sync_at from health_connections where token_hash = $1', [A.sha256(ctx.params.token)])).rows[0];
  if (!c || !c.enabled) throw new HttpError(401, 'Unknown or disabled sync token');
  return { ok: true, provider: c.provider, lastSyncAt: c.last_sync_at };
});

// Diagnostics: reports what is configured (never the values).
route('GET', '/healthz', async () => {
  const out = { ok: false, authSecret: Boolean(process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 16), databaseUrl: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL), database: false, schema: false };
  if (out.databaseUrl) {
    try {
      out.database = (await query('select 1 as ok')).rows[0].ok === 1;
      out.schema = Boolean((await query("select to_regclass('public.users') as t")).rows[0].t);
    } catch (e) { out.error = e.code || 'db_error'; }
  }
  out.ok = out.authSecret && out.database && out.schema;
  return out;
});

const compiled = compile(routes);
module.exports = { compiled, routes };
