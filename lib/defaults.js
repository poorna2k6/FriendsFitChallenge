const DEFAULT_PEEK = {
  blindMode: true, feeType: 'fixed', peekOneCost: 0.25, peekAllCost: 1, peekAllMode: 'sum_others',
  billingWindow: 'weekly', routingMode: 'direct_to_target'
};

const DEFAULT_MODULES = [
  { id: 'mod_grace', icon: '🛡️', title: 'Injury / Sick-Day Grace Freeze', category: 'Retention Critic Fix', desc: 'Allows 1 verified recovery day per challenge (-5% personal cutoff relief) so sick members never rage-quit.', enabled: true },
  { id: 'mod_antisandbag', icon: '🚫', title: 'Anti-Sandbagging Minimum Floor', category: 'Game-Theory Critic Fix', desc: 'Enforces a minimum 50% daily benchmark floor on the #1 leader so groups cannot collude to walk 0 steps.', enabled: true },
  { id: 'mod_prorate', icon: '⚖️', title: 'Fair Late-Join Pace Normalization', category: 'Business Analyst Fix', desc: 'Normalizes mid-challenge invitees to the group pace instead of arbitrary starting scores.', enabled: true },
  { id: 'mod_peekcap', icon: '🛑', title: 'Zero-Negative Escrow Protection', category: 'Fintech Risk Fix', desc: 'Caps Stake-Handicap peek deductions at 100% of retained buy-in so a member never owes negative balance.', enabled: true },
  { id: 'mod_weekend2x', icon: '⚡', title: 'Weekend 2x Sweat Surge', category: 'Expansion Plug-In', desc: 'Saturday & Sunday workouts earn 1.25x bonus weight toward the survival cutoff.', enabled: false },
  { id: 'mod_relay', icon: '🤝', title: '2v2 Buddy Accountability Shield', category: 'Expansion Plug-In', desc: 'Pairs each top leader with a trailing buddy for shared streak nudges.', enabled: false }
];

const HABIT_BOOSTERS = [
  { id: 'h1', title: '💧 3L Hydration Goal Hit', bonusPctOfDaily: 0.25 },
  { id: 'h2', title: '😴 7.5+ Hours Recovery Sleep', bonusPctOfDaily: 0.30 },
  { id: 'h3', title: '🥗 Zero Ultra-Processed Sugar', bonusPctOfDaily: 0.35 },
  { id: 'h4', title: '🧘 20-Min Mobility / Cold Plunge', bonusPctOfDaily: 0.20 },
  { id: 'h5', title: '🔥 5-Day Unbroken Streak Bonus', bonusPctOfDaily: 0.50 }
];
// Habit boosters are honour-system, so the total they can add per member per day is capped.
const HABIT_DAILY_CAP_PCT = 0.5;

const PALETTE = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#f97316', '#ef4444'];

const PROVIDERS = {
  apple_health: { name: 'Apple Health (iPhone)', icon: '⌚', method: 'iOS Shortcut or Health Auto Export app → secure webhook', priority: 10 },
  health_connect: { name: 'Google Health Connect (Android)', icon: '📱', method: 'Health Connect → webhook bridge app', priority: 20 },
  webhook: { name: 'Any other app / device (JSON webhook)', icon: '🔗', method: 'POST JSON from Garmin/Whoop/Oura bridges, Tasker, scripts', priority: 30 }
};

module.exports = { DEFAULT_PEEK, DEFAULT_MODULES, HABIT_BOOSTERS, HABIT_DAILY_CAP_PCT, PALETTE, PROVIDERS };
