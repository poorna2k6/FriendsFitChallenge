// Pay-to-peek pricing & routing (server-side, so the client can never set its own price).
const toCents = (d) => Math.round(Number(d) * 100);

function singleCostCents(ch, cfg) {
  const raw = Number(cfg.peekOneCost);
  const v = Number.isFinite(raw) && raw >= 0.01 ? raw : 0.01;
  if (cfg.feeType === 'percent') return Math.max(1, Math.round((Number(ch.buy_in_cents) * v) / 100));
  return Math.max(1, toCents(v));
}

function allCostCents(ch, cfg, unpeekedCount) {
  const one = singleCostCents(ch, cfg);
  if ((cfg.peekAllMode || 'sum_others') === 'sum_others') return Math.max(1, one * Math.max(1, unpeekedCount));
  const raw = Number(cfg.peekAllCost);
  const v = Number.isFinite(raw) && raw >= 0.01 ? raw : 0.05;
  if (cfg.feeType === 'percent') return Math.max(1, Math.round((Number(ch.buy_in_cents) * v) / 100));
  return Math.max(1, toCents(v));
}

function passDays(cfg) {
  switch (cfg.billingWindow || 'weekly') {
    case 'daily': return 1;
    case 'challenge': return 3650;
    case 'click': return 1;
    default: return 7;
  }
}

/** Split `cents` evenly across n people; the first person absorbs the remainder (matches the UI). */
function splitCents(cents, n) {
  const base = Math.floor(cents / n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? cents - base * (n - 1) : base));
}

/** Returns [{to: userId|null, cents}] describing where a fee goes. */
function route(cfg, feeCents, targets) {
  const mode = cfg.routingMode || 'direct_to_target';
  if (mode === 'direct_to_target' && targets.length) {
    return splitCents(feeCents, targets.length).map((c, i) => ({ to: targets[i], cents: c }));
  }
  if (mode === 'spy_royalty' && targets.length) {
    const royalty = Math.round(feeCents * 0.8);
    const parts = splitCents(royalty, targets.length).map((c, i) => ({ to: targets[i], cents: c }));
    const rest = feeCents - royalty;
    return rest > 0 ? parts.concat([{ to: null, cents: rest }]) : parts;
  }
  return [{ to: null, cents: feeCents }]; // pot_boost + stake_deduct
}

module.exports = { singleCostCents, allCostCents, passDays, route, splitCents };
