/* StakeFit live layer.
 * Loaded after the original single-file app. Demo mode (no account) keeps the original in-browser simulation.
 * Live mode (signed in) swaps the data layer for the server: every mutation goes through /api, the server computes
 * standings, and blind-mode redaction happens server-side so hidden scores never reach the browser. */
(function () {
  'use strict';

  const LIVE = (window.LIVE = { on: false, booting: true, me: null, connections: [], providers: [], offline: false, lastState: null });
  const $ = (id) => document.getElementById(id);
  const esc = (s) => escapeHtml(s);
  const CACHE_KEY = 'stakefit_live_cache_v1';
  const PREF_KEY = 'stakefit_ui_v1';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  // ---------------------------------------------------------------- service worker + install prompt
  let deferredInstall = null;
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; updateInstallButton(); });
  window.addEventListener('appinstalled', () => { deferredInstall = null; updateInstallButton(); showToast('📲 StakeFit installed!'); });
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  async function installApp() {
    if (deferredInstall) {
      deferredInstall.prompt();
      await deferredInstall.userChoice.catch(() => {});
      deferredInstall = null;
      updateInstallButton();
    } else if (isStandalone()) {
      showToast('StakeFit is already installed on this device.');
    } else if (isIos()) {
      openInfo('📲 Install StakeFit on iPhone',
        '<ol class="list-decimal list-inside space-y-1.5"><li>Open this page in <strong>Safari</strong>.</li><li>Tap the <strong>Share</strong> button.</li><li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li></ol><p class="mt-2 text-slate-400">It then launches full-screen like a native app.</p>');
    } else {
      openInfo('📲 Install StakeFit',
        '<p>Open your browser menu and choose <strong>Install app</strong> (Chrome/Edge) or <strong>Add to Home screen</strong> (Android). It then launches full-screen like a native app.</p>');
    }
  }
  function updateInstallButton() {
    const b = $('openDeployLiveBtn');
    if (!b || !LIVE.on) return;
    b.innerHTML = isStandalone() ? '<span>✅ Installed</span>' : '<span>⬇️ Install App</span>';
  }

  // ---------------------------------------------------------------- tiny helpers
  function toast(msg) { showToast(msg); }
  function openInfo(title, html) {
    let m = $('sfInfoModal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'sfInfoModal';
      m.className = 'fixed inset-0 z-[70] hidden items-center justify-center bg-slate-950/85 backdrop-blur-sm p-4';
      m.innerHTML = '<div class="bg-slate-900 border border-slate-700 rounded-3xl max-w-md w-full p-5 space-y-3 text-sm text-slate-200"><div class="flex items-center justify-between gap-2"><h3 id="sfInfoTitle" class="font-extrabold text-white"></h3><button type="button" class="px-2.5 py-1 rounded-xl bg-slate-800 text-xs font-bold" onclick="closeModal(\'sfInfoModal\')">✕</button></div><div id="sfInfoBody"></div></div>';
      document.body.appendChild(m);
    }
    $('sfInfoTitle').textContent = title;
    $('sfInfoBody').innerHTML = html;
    openModal('sfInfoModal');
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { try { fallbackCopy(text); return true; } catch (e2) { return false; } }
  }
  const ago = (iso) => {
    if (!iso) return 'never';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  };

  // ---------------------------------------------------------------- API client
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method, cache: 'no-store', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-SF-Client': '1' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      LIVE.offline = true;
      throw Object.assign(new Error('You appear to be offline'), { offline: true });
    }
    LIVE.offline = false;
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty */ }
    if (res.status === 401 && LIVE.on) { LIVE.on = false; showAuth(); }
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
    return data;
  }

  /** Run a mutation, toast its message, refresh state. */
  async function act(method, path, body, opts = {}) {
    if (LIVE.offline) { toast('📴 You are offline - reconnect to make changes'); return null; }
    try {
      const out = await api(method, path, body);
      if (out.ticker) state.liveTickerMsg = out.ticker;
      await refresh({ keepTicker: Boolean(out.ticker) });
      if (opts.toast !== false && out.message) toast(out.message);
      return out;
    } catch (e) {
      toast(`⚠️ ${e.message}`);
      return null;
    }
  }
  const debounced = {};
  function debounce(key, fn, ms = 450) { clearTimeout(debounced[key]); debounced[key] = setTimeout(fn, ms); }

  // ---------------------------------------------------------------- state adapter
  function applyState(s, { keepTicker } = {}) {
    LIVE.me = s.me;
    LIVE.connections = s.connections || [];
    LIVE.providers = s.providers || [];
    LIVE.lastState = s;
    store.set(CACHE_KEY, JSON.stringify(s));

    const prevActive = state.activeChallengeId;
    state.challenges = s.challenges.map((c) => {
      c.friends.forEach((f) => { f.device = f.device || 'Not synced yet'; });
      c.glitchRequests = (c.glitchRequests || []).map((g) => ({ ...g, unit: (METRIC_CONFIG[c.metric] || METRIC_CONFIG.steps).shortUnit }));
      c.invitations = (c.invitations || []).map((i) => ({ ...i, link: inviteLink(c.inviteCode, i.id) }));
      state.peekState[c.id] = c.peekData;
      return c;
    });
    state.activeChallengeId = state.challenges.some((c) => c.id === prevActive) ? prevActive : (state.challenges[0] ? state.challenges[0].id : null);
    state.authenticatedFriendId = s.me.id;
    state.providers = LIVE.providers.map((p) => {
      const c = LIVE.connections.find((x) => x.provider === p.key);
      return { id: p.key, name: p.name, sdk: p.method, icon: p.icon, connected: Boolean(c && c.enabled),
        protocol: c ? `Last sync ${ago(c.last_sync_at)} • ${c.samples_received} day-totals` : 'Not connected yet' };
    });
    state.auditLedger = s.auditLedger;
    state.securityMetrics = s.securityMetrics;
    swapChallengeScopedState();
    if (!keepTicker) {
      const ch = getActiveChallenge();
      const latest = ch && ch.logs && ch.logs[0];
      state.liveTickerMsg = !latest ? 'Welcome to StakeFit - sync your phone to start scoring'
        : latest.hidden ? `${latest.friend} just synced new activity 🔒`
        : latest.amount ? `${latest.friend} synced +${Number(latest.amount).toLocaleString()} ${latest.unit} via ${latest.source}`
        : `${latest.friend}: ${latest.note}`;
    }
  }

  /** peek config / modules / invitations are per challenge on the server; the original UI reads them from `state`. */
  function swapChallengeScopedState() {
    const ch = state.challenges.find((c) => c.id === state.activeChallengeId);
    if (!ch) return;
    state.peekConfig = { ...ch.peekConfig };
    state.expansionModules = ch.modules;
    state.invitations = ch.invitations;
    state.graceFreezesByMember = { [ch.id]: ch.graceActive || {} };
  }

  async function refresh(opts = {}) {
    try {
      const s = await api('GET', '/state');
      applyState(s, opts);
      renderAll();
    } catch (e) {
      if (e.offline) {
        const cached = store.get(CACHE_KEY);
        if (cached && !LIVE.lastState) { applyState(JSON.parse(cached)); renderAll(); }
        showOfflineBanner(true);
      } else if (e.status !== 401) toast(`⚠️ ${e.message}`);
    }
  }

  function showOfflineBanner(on) {
    let b = $('sfOfflineBanner');
    if (!b && on) {
      b = document.createElement('div');
      b.id = 'sfOfflineBanner';
      b.className = 'fixed top-0 inset-x-0 z-[80] text-center text-[11px] font-bold py-1 bg-amber-500 text-slate-950';
      b.textContent = '📴 Offline - showing your last synced standings. Your phone will upload steps once you are back online.';
      document.body.appendChild(b);
    }
    if (b) b.style.display = on ? 'block' : 'none';
  }
  window.addEventListener('online', () => { showOfflineBanner(false); if (LIVE.on) refresh(); });
  window.addEventListener('offline', () => { LIVE.offline = true; if (LIVE.on) showOfflineBanner(true); });

  LIVE.refresh = refresh;

  // ---------------------------------------------------------------- links
  const inviteLink = (code, invId) => `${location.origin}/?join=${code}${invId ? `&inv=${invId}` : ''}`;

  // ---------------------------------------------------------------- overrides: reads
  const origRenderAll = window.renderAll;
  const origRenderCharts = window.renderCharts;

  window.getChallengePeekData = function (chId) {
    const ch = state.challenges.find((c) => c.id === chId);
    if (ch && ch.peekData) return ch.peekData;
    return { unlockedByMember: {}, unlockedAllByMember: {}, unlockedUntilByMember: {}, unlockedAllUntilByMember: {}, peekFeesByMember: {}, spyRoyaltiesByMember: {}, totalPeekPot: 0, peekEvents: [] };
  };
  const origCalc = window.calculateStandingsAndPayouts;
  window.calculateStandingsAndPayouts = function (ch) { return LIVE.on && ch.calc ? ch.calc : origCalc(ch); };
  const origIsAdmin = window.isSignedInUserChallengeAdmin;
  window.isSignedInUserChallengeAdmin = function (ch) { return LIVE.on ? Boolean(ch && ch.isAdmin) : origIsAdmin(ch); };
  const origAdminFriend = window.getChallengeAdminFriend;
  window.getChallengeAdminFriend = function (ch) {
    if (!LIVE.on) return origAdminFriend(ch);
    return (ch && ch.friends.find((f) => f.id === ch.adminId)) || (ch && ch.friends[0]) || null;
  };
  window.saveState = function () {
    if (LIVE.on) {
      store.set(PREF_KEY, JSON.stringify({ simpleView: state.simpleView, mobileFrameMode: state.mobileFrameMode, activeChallengeId: state.activeChallengeId }));
      return;
    }
    try { localStorage.setItem('stakefit_state_v1', JSON.stringify(state)); } catch (e) { /* ignore */ }
  };

  window.renderAll = function () {
    if (LIVE.booting) return;
    if (!LIVE.on) { origRenderAll(); decorateDemo(); return; }
    if (!state.challenges.length) { showEmptyState(true); return; }
    showEmptyState(false);
    origRenderAll();
    decorateLive();
  };

  function showEmptyState(on) {
    let el = $('sfEmpty');
    const shell = $('adaptiveAppShell');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sfEmpty';
      el.className = 'app-phone-shell w-full px-3.5 pt-6 pb-24 space-y-4';
      el.innerHTML = `
        <div class="glass-card rounded-3xl p-6 text-center space-y-3">
          <div class="text-4xl">🏁</div>
          <h2 class="text-xl font-black text-white">Welcome<span id="sfEmptyName"></span>!</h2>
          <p class="text-xs text-slate-300 leading-relaxed">You are not in a challenge yet. Start your own (you become 👑 Admin) or open an invite link from a friend. Then connect your phone health app so your steps count automatically.</p>
          <div class="flex flex-col gap-2 pt-1">
            <button type="button" onclick="openModal('newChallengeModal')" class="px-4 py-3 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950 font-black text-sm">＋ Start a Challenge</button>
            <button type="button" onclick="LIVE_UI.joinPrompt()" class="px-4 py-3 rounded-2xl bg-sky-500/20 text-sky-300 border border-sky-500/40 font-extrabold text-sm">🔑 I Have an Invite Code</button>
            <button type="button" onclick="LIVE_UI.openConnect()" class="px-4 py-3 rounded-2xl bg-slate-800 text-emerald-300 border border-emerald-500/30 font-extrabold text-sm">📲 Connect My Health App</button>
          </div>
        </div>`;
      shell.parentNode.insertBefore(el, shell);
    }
    $('sfEmptyName').textContent = LIVE.me ? `, ${LIVE.me.name.split(' ')[0]}` : '';
    el.style.display = on ? '' : 'none';
    shell.style.display = on ? 'none' : '';
    const nav = document.querySelector('nav');
    document.querySelectorAll('nav, #mobileBottomNav').forEach((n) => { n.style.display = on ? 'none' : ''; });
  }

  // post-render fixes for live mode
  function decorateLive() {
    document.body.classList.add('live-mode');
    const ch = getActiveChallenge();
    if (!ch) return;
    const calc = ch.calc;

    // identity chip replaces the demo "signed in as" profile switcher
    const wrap = $('authMemberSelect') && $('authMemberSelect').parentElement;
    if (wrap && !wrap.dataset.live) {
      wrap.dataset.live = '1';
      wrap.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span><button type="button" id="sfAccountBtn" onclick="LIVE_UI.openAccount()" class="text-emerald-300 text-xs font-bold max-w-[125px] sm:max-w-[160px] truncate"></button>';
    }
    const acct = $('sfAccountBtn');
    if (acct) acct.textContent = LIVE.me ? LIVE.me.name : 'Account';
    const pill = $('hubSignedInUserPill');
    if (pill && LIVE.me) pill.textContent = `Signed in: ${LIVE.me.name}`;

    // "Rules" view for members: explain real behaviour
    const subtitle = $('activeUserDevicePill');
    if (subtitle) {
      const mine = LIVE.connections.filter((c) => c.enabled);
      subtitle.textContent = mine.length ? `📡 Synced via ${mine.map((c) => c.label.replace(/ \(.*\)/, '')).join(' + ')} • Manual edits blocked` : '📡 No health app connected yet - tap "Connect Health App"';
    }
    const dev = $('cleanMyDevice');
    if (dev) dev.textContent = LIVE.connections.some((c) => c.enabled) ? `⌚ Auto-synced via ${LIVE.connections.filter((c) => c.enabled).map((c) => c.label.replace(/ \(.*\)/, '')).join(' + ')}` : '⌚ Not synced yet - connect your phone health app';
    const todayBadge = $('todayHealthSyncBadge');
    if (todayBadge) {
      const mCfg = METRIC_CONFIG[ch.metric] || METRIC_CONFIG.steps;
      const last = LIVE.connections.map((c) => c.last_sync_at).filter(Boolean).sort().pop();
      todayBadge.innerHTML = LIVE.connections.some((c) => c.enabled)
        ? `📲 Last sync <strong>${esc(ago(last))}</strong> • Routing <strong class="text-emerald-300">${esc(mCfg.name)}</strong> → <strong class="text-white">${esc(ch.title)}</strong> (Day ${ch.daysElapsed}/${ch.totalDays})`
        : `📲 <strong class="text-amber-300">No health app connected</strong> • Your ${esc(mCfg.name)} will not count until you connect one`;
    }

    // buttons that only make sense in the demo
    document.querySelectorAll('[onclick*="simulateNextDay"],[onclick*="resetMyPeeks"],[onclick*="triggerOneClickOtaPush"],[onclick*="copyCicdPipelineConfig"],[onclick*="toggleLiveSensorStream"],[onclick*="simulateFraudAttempt"],[onclick*="openDeployLiveModal"]:not(#openDeployLiveBtn),#deployLiveKitCard,[onclick*="simulateMultiChallengeHealthSync"],#authRoleBadge')
      .forEach((el) => el.classList.add('demo-only'));
    document.querySelectorAll('[onclick*="acceptMemberInvitation"]').forEach((b) => { b.textContent = '🔗 Copy Invite Link'; });
    document.querySelectorAll('[onclick*="triggerWebhookAutoSync"]').forEach((b) => {
      if (/Auto-Sync From Phone/.test(b.textContent)) b.innerHTML = '<span>🔄 Sync Now / Connect Health App</span>';
    });
    document.querySelectorAll('[onclick*="healthSyncRouterModal"]').forEach((b) => { if (/How Phone Sync/.test(b.textContent)) b.innerHTML = '📲 Manage Health App Connections'; });
    const g = $('govLockToggle');
    if (g) g.disabled = !ch.isAdmin;
    const peekAdminOnly = ch.isAdmin ? '' : 'none';
    document.querySelectorAll('#blindModeCheckbox,#peekFeeTypeSelect,#peekOneCostInput,#peekAllCostInput,#peekRoutingSelect').forEach((el) => { el.disabled = !ch.isAdmin; });
    void peekAdminOnly;

    // blind mode: scrub the legacy full dashboard (advanced drawer) for members who can't see the 100% bar
    const locked = calc && calc.redacted;
    const lockMsg = '<div class="p-4 text-xs text-amber-200">🔒 Hidden in Blind Mode — pay to <strong>Peek All</strong> to reveal the full standings and the 100% bar.</div>';
    if (locked) {
      const body = $('leaderboardTableBody');
      if (body) body.innerHTML = `<tr><td colspan="9">${lockMsg}</td></tr>`;
      ['payoutMathFooter', 'coachCardsContainer'].forEach((id) => { const el = $(id); if (el) el.innerHTML = lockMsg; });
      const set = (id, t) => { const el = $(id); if (el) el.textContent = t; };
      set('heroTopLeader', '🔒 Hidden'); set('heroTopScore', 'Blind Mode'); set('heroCutoffValue', 'Min: 🔒 Hidden');
      set('heroForfeitedPot', '🔒 Hidden'); set('chartCutoffPill', 'Cutoff hidden'); set('chartPotPill', 'Blind Mode');
      ['progressChart', 'payoutChart'].forEach((id) => { const c = $(id); if (c && c.parentElement) c.parentElement.style.display = 'none'; });
    } else {
      ['progressChart', 'payoutChart'].forEach((id) => { const c = $(id); if (c && c.parentElement) c.parentElement.style.display = ''; });
    }
    // rules view: day elapsed is calendar-driven
    const el = $('ruleElapsedInput');
    if (el) el.title = 'Challenge day follows the calendar. Admins can correct the start date by editing this number.';
    updateInstallButton();
  }

  function decorateDemo() {
    document.body.classList.remove('live-mode');
    if (!$('sfDemoBanner')) {
      const b = document.createElement('div');
      b.id = 'sfDemoBanner';
      b.className = 'fixed bottom-20 inset-x-0 z-40 flex justify-center pointer-events-none';
      b.innerHTML = '<button type="button" onclick="LIVE_UI.exitDemo()" class="pointer-events-auto px-4 py-2 rounded-full bg-emerald-500 text-slate-950 text-xs font-black shadow-lg">🧪 Demo mode — Sign in to sync your real health data</button>';
      document.body.appendChild(b);
    }
  }

  // ---------------------------------------------------------------- overrides: writes (live only; demo falls through to the originals)
  const wrap = (name, liveFn) => {
    const orig = window[name];
    window[name] = function (...args) { return LIVE.on ? liveFn.apply(this, args) : orig.apply(this, args); };
  };
  const chNow = () => getActiveChallenge();
  const needAdmin = () => { if (!chNow().isAdmin) { toast('👑 Only the challenge admin can change this'); return false; } return true; };

  wrap('handleChallengeSwitch', (id) => { state.activeChallengeId = id; swapChallengeScopedState(); saveState(); renderAll(); toast('Switched challenge group!'); });
  wrap('openChallengeFromHub', (id, view) => { state.activeChallengeId = id; swapChallengeScopedState(); saveState(); switchSimpleView(view || 'member'); toast(`Opened "${chNow().title}"`); });
  wrap('openChallengeAsRole', (id, role) => {
    state.activeChallengeId = id; swapChallengeScopedState(); saveState();
    const ch = chNow();
    if (role === 'admin' && !ch.isAdmin) toast('🔒 You are a regular member here — the Admin Console is read-only for you.');
    switchSimpleView(role === 'admin' ? 'admin' : 'member');
  });
  wrap('switchToChallengeAdminSession', () => toast('Ask the challenge admin to change rules — only they can.'));
  wrap('handleAuthSwitch', () => {});

  wrap('submitNewChallenge', async (e) => {
    e.preventDefault();
    const v = (id) => $(id).value;
    const out = await act('POST', '/challenges', {
      title: v('newChTitle'), metric: v('newChMetric'), durationKey: v('newChDuration'), buyIn: Number(v('newChBuyIn')),
      cutoffPct: Number(v('newChCutoff')), slashPct: Number(v('newChSlash')),
      peek: { blindMode: $('newChBlindMode').checked, peekOneCost: Number(v('newChPeekOneCost')), peekAllMode: v('newChPeekAllMode'), billingWindow: v('newChBillingWindow'), routingMode: v('newChRoutingMode') }
    });
    if (out && out.id) {
      closeModal('newChallengeModal');
      $('newChTitle').value = '';
      state.activeChallengeId = out.id; swapChallengeScopedState(); renderAll();
      switchSimpleView('admin');
    }
  });

  const RULE_SERVER = { metric: 'metric', buyIn: 'buyIn', cutoffPct: 'cutoffPct', slashPct: 'slashPct', dailyBenchmark: 'dailyBenchmark', daysElapsed: 'daysElapsed', title: 'title', distributionMode: 'distributionMode' };
  wrap('updateChallengeRule', (field, value) => {
    if (!needAdmin()) { renderAll(); return; }
    const ch = chNow();
    if (!RULE_SERVER[field]) return;
    ch[field] = value;                 // optimistic
    if (field !== 'title') renderAll();
    debounce('rule-' + field, async () => {
      const out = await act('PATCH', `/challenges/${ch.id}`, { [RULE_SERVER[field]]: value }, { toast: false });
      if (!out) await refresh();
    });
  });
  wrap('setDurationPreset', async (key) => { if (needAdmin()) await act('PATCH', `/challenges/${chNow().id}`, { durationKey: key }, { toast: false }); });
  wrap('toggleGovernanceLock', async () => { if (needAdmin()) { const ch = chNow(); await act('PATCH', `/challenges/${ch.id}`, { governanceLocked: !ch.governanceLocked }, { toast: false }); toast(!ch.governanceLocked ? '🔓 Commissioner Sandbox: rules unlocked' : '🔒 Rules locked — immutable mid-challenge'); } });
  wrap('togglePaidStatus', async (id) => {
    if (!needAdmin()) return;
    const f = chNow().friends.find((x) => x.id === id);
    await act('POST', `/challenges/${chNow().id}/members/${id}/paid`, { paid: !(f && f.paid) });
  });

  // pay-to-peek settings (admin)
  wrap('updatePeekSetting', (field, value) => {
    if (!needAdmin()) { renderAll(); return; }
    state.peekConfig[field] = value; chNow().peekConfig[field] = value;
    if (!['peekOneCost', 'peekAllCost'].includes(field)) renderAll();
    debounce('peek-' + field, () => act('PATCH', `/challenges/${chNow().id}`, { peek: { [field]: value } }, { toast: false }));
  });
  wrap('applyQuickPeekPreset', (amount) => {
    if (!needAdmin()) return;
    const ch = chNow(); const one = Math.max(0.01, Number(amount));
    act('PATCH', `/challenges/${ch.id}`, { peek: { feeType: 'fixed', peekOneCost: one, peekAllCost: Number((one * Math.max(1, ch.friends.length - 1)).toFixed(2)) } }, { toast: false })
      .then(() => toast(`🪙 Peek 1 fee set to $${one.toFixed(2)}`));
  });
  wrap('applySmartPotPeekScale', () => {
    if (!needAdmin()) return;
    const ch = chNow(); const pot = Math.max(0.1, ch.buyIn * Math.max(2, ch.friends.length));
    const one = Number(Math.max(0.01, pot * 0.02).toFixed(2));
    act('PATCH', `/challenges/${ch.id}`, { peek: { feeType: 'fixed', peekOneCost: one, peekAllMode: 'sum_others', peekAllCost: Number((one * Math.max(1, ch.friends.length - 1)).toFixed(2)) } }, { toast: false })
      .then(() => toast(`⚡ Auto-scaled to a $${pot.toFixed(2)} pot: Peek 1 = $${one.toFixed(2)}`));
  });
  wrap('peekSpecificMember', (id) => act('POST', `/challenges/${chNow().id}/peek`, { target: id }));
  wrap('peekAllMembers', () => act('POST', `/challenges/${chNow().id}/peek`, { target: 'all' }));
  wrap('resetMyPeeks', () => toast('Passes expire on their own (7-day pass by default).'));

  // progress, habits, grace, nudges
  wrap('submitActivityLog', async (e) => {
    e.preventDefault();
    const ch = chNow();
    const amount = Number($('logAmountInput').value);
    const note = $('logNoteInput').value.trim();
    const source = $('logSourceSelect').value;
    if (!(amount > 0)) return;
    const reason = `${source}: ${note || 'manual entry'}`;
    // Nobody can credit themselves. Manual entries become a request the admin approves (or an audit-logged override for the admin).
    const out = ch.isAdmin
      ? await act('POST', `/challenges/${ch.id}/override`, { memberId: LIVE.me.id, mode: 'add', amount, reason: 'Duplicate / Wrong Data Correction by Admin' })
      : await act('POST', `/challenges/${ch.id}/glitch`, { delta: amount, reason });
    if (out) { closeModal('logActivityModal'); $('logNoteInput').value = ''; }
  });
  wrap('quickLogForFriend', (id) => { if (id !== LIVE.me.id) { inspectMemberProof(id); return; } openModal('logActivityModal'); $('logFriendSelect').value = LIVE.me.id; });
  wrap('quickClaimMicroHabit', (id) => act('POST', `/challenges/${chNow().id}/habit`, { boosterId: id }));
  wrap('awardHabitBooster', (id) => {
    if ($('boosterFriendSelect').value !== LIVE.me.id) { toast('🔒 You can only claim habits for yourself'); return null; }
    return act('POST', `/challenges/${chNow().id}/habit`, { boosterId: id });
  });
  wrap('activateGraceFreeze', () => act('POST', `/challenges/${chNow().id}/grace`, {}));
  wrap('sendQuickSquadNudge', (emoji, targetId) => act('POST', `/challenges/${chNow().id}/nudge`, { emoji, targetId }));
  wrap('toggleExpansionModule', (id) => { if (needAdmin()) return act('POST', `/challenges/${chNow().id}/modules/${id}/toggle`, {}); });
  wrap('addCustomPluginModule', (e) => {
    e.preventDefault();
    if (!needAdmin()) return;
    const input = $('customPluginTitleInput');
    const title = input.value.trim();
    input.value = '';
    return act('POST', `/challenges/${chNow().id}/modules`, { title });
  });
  wrap('simulateNextDay', () => toast('📅 Days advance automatically with the calendar'));
  wrap('submitNewFriend', (e) => { e.preventDefault(); closeModal('addFriendModal'); toast('Invite friends with a link — they join with their own account.'); switchSimpleView('admin'); });

  // admin tools
  wrap('submitAdminScoreOverride', async (e) => {
    if (e) e.preventDefault();
    if (!needAdmin()) return;
    await act('POST', `/challenges/${chNow().id}/override`, {
      memberId: $('adminOverrideMemberSelect').value, mode: $('adminOverrideModeSelect').value,
      amount: Number($('adminOverrideAmountInput').value), reason: $('adminOverrideReasonSelect').value
    });
  });
  wrap('quickAdminGlitchFix', (id) => {
    if (!needAdmin()) return;
    const ch = chNow();
    return act('POST', `/challenges/${ch.id}/override`, { memberId: id, mode: 'add', amount: Math.round((METRIC_CONFIG[ch.metric] || METRIC_CONFIG.steps).defaultDaily * 0.5), reason: 'Technical Sync Glitch (Verified Screenshot)' });
  });
  wrap('submitMemberGlitchRequest', async (e) => {
    e.preventDefault();
    const out = await act('POST', `/challenges/${chNow().id}/glitch`, { delta: Number($('memberGlitchDeltaInput').value), reason: $('memberGlitchReasonInput').value });
    if (out) { $('memberGlitchDeltaInput').value = ''; $('memberGlitchReasonInput').value = ''; }
  });
  wrap('approveMemberGlitchRequest', (id) => act('POST', `/challenges/${chNow().id}/glitch/${id}/approve`, {}));
  wrap('rejectMemberGlitchRequest', (id) => act('POST', `/challenges/${chNow().id}/glitch/${id}/reject`, {}));

  // invitations: real links, WhatsApp / share sheet
  wrap('sendMemberInvitation', async (e) => {
    e.preventDefault();
    if (!needAdmin()) return;
    const ch = chNow();
    const name = $('inviteNameInput').value; const contact = $('inviteContactInput').value;
    const channel = $('inviteChannelSelect').value; const device = $('inviteDeviceSelect').value;
    const out = await act('POST', `/challenges/${ch.id}/invites`, { name, contact, channel, device }, { toast: false });
    if (!out) return;
    $('inviteNameInput').value = ''; $('inviteContactInput').value = '';
    await shareInvite(ch, name, contact, channel, inviteLink(out.code, out.id));
  });
  async function shareInvite(ch, name, contact, channel, link) {
    const msg = `🔥 ${name.split(' ')[0]}, join my StakeFit challenge "${ch.title}" — $${ch.buyIn} buy-in. Open the link, create your account and connect your phone health app: ${link}`;
    if (channel === 'WhatsApp') { window.open(`https://wa.me/${/^\+?[\d\s()-]{7,}$/.test(contact) ? contact.replace(/[^\d]/g, '') : ''}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener'); toast(`💬 Opening WhatsApp for ${name}…`); return; }
    if (channel === 'Email') { location.href = `mailto:${encodeURIComponent(contact)}?subject=${encodeURIComponent('Join my StakeFit challenge')}&body=${encodeURIComponent(msg)}`; return; }
    if (channel === 'SMS Text') { location.href = `sms:${encodeURIComponent(contact)}?&body=${encodeURIComponent(msg)}`; return; }
    if (navigator.share) { navigator.share({ text: msg }).catch(() => {}); return; }
    await copyText(msg); toast('🔗 Invite message copied');
  }
  wrap('acceptMemberInvitation', async (id) => {
    const inv = (chNow().invitations || []).find((i) => i.id === id);
    if (inv) { await copyText(inv.link); toast(`🔗 Invite link for ${inv.name} copied — they join with their own account.`); }
  });
  wrap('cancelMemberInvitation', (id) => act('DELETE', `/challenges/${chNow().id}/invites/${id}`));
  wrap('copyInviteLink', async () => {
    const ch = chNow();
    const link = inviteLink(ch.inviteCode);
    if (navigator.share) { navigator.share({ title: ch.title, text: `Join "${ch.title}" on StakeFit`, url: link }).catch(() => {}); return; }
    await copyText(link); toast(`🔗 Copied invite link (code ${ch.inviteCode})`);
  });
  wrap('copyWhatsAppInviteValidationPack', async () => {
    const ch = chNow();
    await copyText(`🔥 *You're invited: ${ch.title}* 🔥\n💰 Buy-in: $${ch.buyIn}\n🔒 Blind leaderboard: rivals' scores are hidden — peeking costs $${Number(state.peekConfig.peekOneCost).toFixed(2)}\n📲 Join & sync: ${inviteLink(ch.inviteCode)}`);
    toast('💬 Copied WhatsApp invite');
  });

  // health sync entry points -> real flow
  const goSync = () => openConnect();
  wrap('triggerWebhookAutoSync', async () => {
    if (!LIVE.connections.some((c) => c.enabled)) { openConnect(); return; }
    await refresh();
    const last = LIVE.connections.map((c) => c.last_sync_at).filter(Boolean).sort().pop();
    toast(last ? `📡 Standings refreshed. Your phone last synced ${ago(last)}.` : '📡 Connected — waiting for your phone to send its first sync.');
  });
  wrap('simulateMultiChallengeHealthSync', goSync);
  wrap('toggleProviderConnection', goSync);
  wrap('toggleLiveSensorStream', () => toast('Live streaming is a demo feature.'));
  wrap('simulateFraudAttempt', () => toast('Anti-cheat runs on the server for every real sync.'));
  wrap('openDeployLiveModal', installApp);
  wrap('triggerOneClickOtaPush', () => {});
  wrap('inspectMemberProof', (id) => {
    const ch = chNow(); const f = ch.friends.find((x) => x.id === id); if (!f) return;
    const mCfg = METRIC_CONFIG[ch.metric] || METRIC_CONFIG.steps;
    $('proofModalTitle').textContent = `${f.name} — Sync Audit`;
    $('proofModalBody').innerHTML = `
      <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
        <div class="flex items-center justify-between"><span class="text-slate-400">Profile access:</span><span class="font-bold text-rose-400">🔒 Read-only for everyone but ${esc(f.name.split(' ')[0])}</span></div>
        <div class="flex items-center justify-between"><span class="text-slate-400">Data source:</span><span class="font-bold text-emerald-400">✓ ${esc(f.device)}</span></div>
        <div class="flex items-center justify-between"><span class="text-slate-400">Verified total:</span><span class="font-mono font-bold text-white">${f.hidden ? '🔒 hidden' : Number(f.score).toLocaleString() + ' ' + mCfg.shortUnit}</span></div>
        <div class="flex items-center justify-between"><span class="text-slate-400">How it got there:</span><span class="text-sky-300">Phone sync token (server-checked)</span></div>
      </div>
      <p class="text-[11px] text-slate-400 leading-relaxed">Scores come only from each member's own phone-health sync. The server rejects manually entered samples, implausible daily totals and duplicate payloads. The only other way a score changes is an admin override or an admin-approved fix request, and both are written to the activity feed.</p>`;
    openModal('proofInspectorModal');
  });

  // ---------------------------------------------------------------- auth UI
  function showAuth(joinInfo) {
    LIVE.booting = true;
    let el = $('sfAuth');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sfAuth';
      el.className = 'fixed inset-0 z-[90] overflow-y-auto bg-black';
      document.body.appendChild(el);
    }
    const pj = pendingJoin();
    el.style.display = '';
    el.innerHTML = `
      <div class="min-h-full flex items-center justify-center p-5" style="padding-top:max(1.25rem,env(safe-area-inset-top))">
        <div class="w-full max-w-sm space-y-4">
          <div class="text-center space-y-1.5">
            <img src="/icons/icon-192.png" alt="" class="w-16 h-16 rounded-2xl mx-auto shadow-lg shadow-emerald-500/20" />
            <h1 class="text-2xl font-black text-white tracking-tight">StakeFit</h1>
            <p class="text-xs text-slate-400">Stake money on your fitness with friends. Your phone's health data keeps score.</p>
          </div>
          ${pj ? `<div id="sfJoinBanner" class="p-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200">🎟️ You were invited to join a challenge. Sign in or create an account to enter.</div>` : ''}
          <div class="glass-card rounded-3xl p-5 space-y-3">
            <div class="ios-segmented grid grid-cols-2 gap-1 text-xs font-bold">
              <button type="button" id="sfTabLogin" class="py-1.5 rounded-lg ios-segmented-btn-active">Sign in</button>
              <button type="button" id="sfTabSignup" class="py-1.5 rounded-lg text-slate-300">Create account</button>
            </div>
            <form id="sfAuthForm" class="space-y-2.5" autocomplete="on">
              <input id="sfName" type="text" autocomplete="name" placeholder="Your name" maxlength="60" class="hidden w-full px-3.5 py-3 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white" />
              <input id="sfEmail" type="email" autocomplete="email" inputmode="email" placeholder="Email" required class="w-full px-3.5 py-3 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white" />
              <input id="sfPass" type="password" autocomplete="current-password" placeholder="Password (8+ characters)" required minlength="8" class="w-full px-3.5 py-3 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white" />
              <div id="sfAuthErr" class="hidden text-xs text-rose-300"></div>
              <button id="sfAuthSubmit" type="submit" class="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950 font-black text-sm">Sign in</button>
            </form>
          </div>
          <button type="button" id="sfDemoBtn" class="w-full text-center text-xs text-slate-400 underline">Just looking? Try the demo with sample data</button>
        </div>
      </div>`;
    let mode = 'login';
    const setMode = (m) => {
      mode = m;
      $('sfName').classList.toggle('hidden', m !== 'signup');
      $('sfName').required = m === 'signup';
      $('sfPass').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
      $('sfAuthSubmit').textContent = m === 'signup' ? 'Create account' : 'Sign in';
      $('sfTabLogin').className = 'py-1.5 rounded-lg ' + (m === 'login' ? 'ios-segmented-btn-active' : 'text-slate-300');
      $('sfTabSignup').className = 'py-1.5 rounded-lg ' + (m === 'signup' ? 'ios-segmented-btn-active' : 'text-slate-300');
    };
    $('sfTabLogin').onclick = () => setMode('login');
    $('sfTabSignup').onclick = () => setMode('signup');
    if (pj) setMode('signup');
    $('sfDemoBtn').onclick = () => { sessionStorage.setItem('sf_demo', '1'); el.style.display = 'none'; LIVE.on = false; LIVE.booting = false; renderAll(); };
    $('sfAuthForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const err = $('sfAuthErr'); err.classList.add('hidden');
      $('sfAuthSubmit').disabled = true;
      try {
        const body = { email: $('sfEmail').value, password: $('sfPass').value };
        if (mode === 'signup') body.name = $('sfName').value;
        if (pj) { body.joinCode = pj.code; body.invitationId = pj.inv; }
        const out = await api('POST', mode === 'signup' ? '/auth/signup' : '/auth/login', body);
        clearPendingJoin();
        sessionStorage.removeItem('sf_demo');
        el.style.display = 'none';
        await boot();
        if (out.joined) { toast(out.joined.already ? 'You are already in this challenge' : `🎉 You joined "${out.joined.title}"! Now connect your health app.`); if (!out.joined.already) setTimeout(openConnect, 600); }
        else if (mode === 'signup') setTimeout(openConnect, 600);
      } catch (e2) {
        err.textContent = e2.message; err.classList.remove('hidden');
      } finally { $('sfAuthSubmit').disabled = false; }
    };
  }

  function pendingJoin() {
    const p = new URLSearchParams(location.search);
    const code = p.get('join') || store.get('sf_join');
    if (!code) return null;
    store.set('sf_join', code);
    const inv = p.get('inv') || store.get('sf_inv') || undefined;
    if (inv) store.set('sf_inv', inv);
    return { code, inv };
  }
  function clearPendingJoin() { store.del('sf_join'); store.del('sf_inv'); if (location.search) history.replaceState({}, '', location.pathname); }

  // ---------------------------------------------------------------- account menu
  function openAccount() {
    openInfo('👤 Your account', `
      <div class="space-y-3">
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800"><div class="font-bold text-white">${esc(LIVE.me.name)}</div><div class="text-xs text-slate-400">${esc(LIVE.me.email)}</div></div>
        <button type="button" onclick="closeModal('sfInfoModal');LIVE_UI.openConnect()" class="w-full py-2.5 rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold text-xs">📲 Health App Connections</button>
        <button type="button" onclick="LIVE_UI.installApp()" class="w-full py-2.5 rounded-xl bg-slate-800 text-slate-200 font-bold text-xs">⬇️ Install App on This Device</button>
        <button type="button" onclick="LIVE_UI.signOut()" class="w-full py-2.5 rounded-xl bg-rose-500/20 text-rose-300 border border-rose-500/40 font-bold text-xs">Sign out</button>
      </div>`);
  }
  async function signOut() {
    try { await api('POST', '/auth/logout', {}); } catch (e) { /* ignore */ }
    store.del(CACHE_KEY);
    location.href = '/';
  }
  async function joinPrompt() {
    const code = (prompt('Enter the invite code from your friend:') || '').trim();
    if (!code) return;
    const out = await act('POST', '/challenges/join', { code });
    if (out && out.id) { state.activeChallengeId = out.id; swapChallengeScopedState(); renderAll(); setTimeout(openConnect, 500); }
  }

  // ---------------------------------------------------------------- health connections screen
  const GUIDES = {
    apple_health: (url) => `
      <div class="space-y-3 text-xs text-slate-300">
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
          <div class="font-extrabold text-white">Option A — Health Auto Export app (hands-off, recommended)</div>
          <ol class="list-decimal list-inside space-y-1 text-slate-300">
            <li>Install <strong>Health Auto Export</strong> from the App Store and allow Health access.</li>
            <li>Create an <strong>Automation</strong> with type <strong>REST API</strong>, format <strong>JSON</strong>, and paste your sync URL (below).</li>
            <li>Select metrics: <em>Step Count</em>, <em>Active Energy</em>, <em>Apple Exercise Time</em>, <em>Walking + Running Distance</em>.</li>
            <li>Set aggregation to <strong>Days</strong> and sync period to <strong>Today</strong>, then schedule it (e.g. hourly).</li>
          </ol>
          <div class="text-[11px] text-slate-500">Menu names can change between app versions. Use "Manual export" once to test.</div>
        </div>
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
          <div class="font-extrabold text-white">Option B — Apple Shortcuts (free, built in)</div>
          <ol class="list-decimal list-inside space-y-1">
            <li>Shortcuts → new shortcut → <strong>Find Health Samples</strong> (Steps, start date = today) → <strong>Calculate Statistics (Sum)</strong>.</li>
            <li>Add <strong>Get Contents of URL</strong>: your sync URL, method <strong>POST</strong>, Request Body <strong>JSON</strong>: <code class="text-emerald-300">date</code> = Current Date formatted <code>yyyy-MM-dd</code>, <code class="text-emerald-300">steps</code> = the Sum.</li>
            <li>Shortcuts → Automation → <strong>Time of Day</strong> (a few times daily) → run the shortcut, turn off "Ask Before Running".</li>
          </ol>
        </div>
        <div class="text-[11px] text-slate-500">Apple does not let websites read HealthKit directly, so a sender on your iPhone is required. Wearables that feed Apple Health (Apple Watch, Garmin, Whoop, Oura…) are included automatically.</div>
      </div>`,
    health_connect: () => `
      <div class="space-y-3 text-xs text-slate-300">
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
          <div class="font-extrabold text-white">Android: Health Connect → webhook</div>
          <ol class="list-decimal list-inside space-y-1">
            <li>Android does not let websites read Health Connect, so install a <strong>Health Connect → webhook bridge app</strong> (or an automation app such as Tasker) that can read your steps/calories/exercise and POST JSON.</li>
            <li>Point it at your sync URL (below) and send one JSON object per day in the format shown.</li>
            <li>Fitbit, Samsung Health, Garmin and Google Fit data that is shared into Health Connect is included.</li>
          </ol>
        </div>
        <div class="text-[11px] text-slate-500">A one-tap native Android/iOS wrapper (Capacitor) that talks to Health Connect and HealthKit directly is the next step on the roadmap.</div>
      </div>`,
    webhook: () => `
      <div class="space-y-2 text-xs text-slate-300">
        <p>Any app, script or bridge that can send an HTTPS POST can feed StakeFit. Send daily <em>totals</em> — re-sending a day replaces its value, never adds to it.</p>
      </div>`
  };
  const SAMPLE_JSON = `{\n  "date": "2026-10-27",\n  "steps": 8423,\n  "calories": 512,\n  "minutes": 42,\n  "distance_km": 6.1\n}`;

  function connectModal() {
    let m = $('sfConnect');
    if (!m) {
      m = document.createElement('div');
      m.id = 'sfConnect';
      m.className = 'fixed inset-0 z-[60] hidden items-start justify-center bg-slate-950/90 backdrop-blur-md p-3 overflow-y-auto';
      document.body.appendChild(m);
    }
    return m;
  }

  async function openConnect(focusProvider, reveal) {
    const m = connectModal();
    m.classList.remove('hidden'); m.classList.add('flex');
    let daily = [];
    try { daily = (await api('GET', '/health/daily?days=14')).rows; } catch (e) { /* offline */ }
    renderConnect(daily, focusProvider, reveal);
  }
  function closeConnect() { const m = connectModal(); m.classList.add('hidden'); m.classList.remove('flex'); }

  function renderConnect(daily, focusProvider, reveal) {
    const m = connectModal();
    const conns = LIVE.connections;
    const metricIcon = { steps: '👣', calories: '🔥', minutes: '⏱️', distance: '🏃' };
    const unit = { steps: '', calories: ' kcal', minutes: ' min', distance: ' km' };
    const byDay = {};
    daily.forEach((r) => { (byDay[r.day] = byDay[r.day] || {})[r.metric] = (byDay[r.day][r.metric] || []).concat(r); });
    const dayRows = Object.keys(byDay).sort().reverse().slice(0, 14).map((d) => `
      <tr class="border-t border-slate-800"><td class="py-1.5 pr-2 text-slate-400 font-mono">${d.slice(5)}</td>
      <td class="py-1.5 text-slate-200">${['steps', 'calories', 'minutes', 'distance'].map((k) => {
        const rows = byDay[d][k]; if (!rows) return '';
        const top = rows.slice().sort((a, b) => priorityOf(a.provider) - priorityOf(b.provider))[0];
        return `<span class="inline-block mr-2.5">${metricIcon[k]} ${Number(top.value).toLocaleString()}${unit[k]}${rows.length > 1 ? ' <span title="Another source also reported this day; your primary source is used" class="text-sky-400">⇄</span>' : ''}</span>`;
      }).join('')}</td></tr>`).join('');

    const cards = LIVE.providers.map((p) => {
      const c = conns.find((x) => x.provider === p.key);
      const showUrl = reveal && reveal.provider === p.key;
      const open = showUrl || focusProvider === p.key;
      return `
      <div class="p-4 rounded-2xl border ${c ? 'bg-slate-900/90 border-emerald-500/40' : 'bg-slate-900/50 border-slate-800'} space-y-2.5">
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2.5 min-w-0"><span class="text-2xl">${p.icon}</span>
            <div class="min-w-0"><div class="text-sm font-extrabold text-white">${esc(p.name)}</div><div class="text-[11px] text-slate-400">${esc(p.method)}</div></div></div>
          <span class="shrink-0 text-[10px] font-extrabold px-2 py-0.5 rounded-full ${c && c.enabled ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-slate-800 text-slate-400'}">${c ? (c.enabled ? '● Connected' : 'Paused') : 'Not connected'}</span>
        </div>
        ${c ? `<div class="text-[11px] text-slate-400">Last sync <strong class="text-slate-200">${esc(ago(c.last_sync_at))}</strong> • ${c.samples_received} day-totals received • link …${esc(c.token_hint)} • priority ${c.priority}</div>` : ''}
        ${showUrl ? `<div class="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-1.5"><div class="text-[11px] font-bold text-emerald-300">Your private sync URL (shown once — copy it now)</div><code class="block break-all text-[11px] text-white select-all" id="sfSyncUrl">${esc(reveal.ingestUrl)}</code><button type="button" onclick="LIVE_UI.copyUrl()" class="px-3 py-1.5 rounded-lg bg-emerald-500 text-slate-950 font-black text-[11px]">📋 Copy URL</button></div>` : ''}
        <div class="flex flex-wrap gap-1.5">
          <button type="button" onclick="LIVE_UI.setup('${p.key}')" class="px-3 py-1.5 rounded-xl ${c ? 'bg-slate-800 text-slate-200' : 'bg-emerald-500 text-slate-950'} font-extrabold text-[11px]">${c ? '🔁 New sync URL' : '＋ Set up'}</button>
          ${c ? `<button type="button" onclick="LIVE_UI.guide('${p.key}')" class="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-200 font-bold text-[11px]">📖 Setup guide</button>
                 <button type="button" onclick="LIVE_UI.makePrimary('${c.id}')" class="px-3 py-1.5 rounded-xl bg-slate-800 text-sky-300 font-bold text-[11px]">⭐ Make primary</button>
                 <button type="button" onclick="LIVE_UI.toggleConn('${c.id}', ${!c.enabled})" class="px-3 py-1.5 rounded-xl bg-slate-800 text-amber-300 font-bold text-[11px]">${c.enabled ? 'Pause' : 'Resume'}</button>
                 <button type="button" onclick="LIVE_UI.disconnect('${c.id}')" class="px-3 py-1.5 rounded-xl bg-slate-800 text-rose-300 font-bold text-[11px]">Disconnect</button>` : ''}
        </div>
        ${open ? `<div class="pt-1">${(GUIDES[p.key] || (() => ''))()}${p.key !== 'webhook' || open ? `<div class="mt-2 text-[11px] text-slate-400">Send JSON like this (one object per day, or <code>{"samples":[…]}</code>). Health Auto Export's own format is also understood:</div><pre class="mt-1 p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-emerald-200 overflow-x-auto">${esc(SAMPLE_JSON)}</pre>` : ''}</div>` : ''}
      </div>`;
    }).join('');

    const feeds = state.challenges.map((c) => { const mc = METRIC_CONFIG[c.metric] || METRIC_CONFIG.steps; return `<div class="flex items-center justify-between gap-2 text-[11px]"><span class="text-slate-200 truncate">${mc.icon} ${esc(c.title)}</span><span class="text-slate-400 shrink-0">${esc(mc.name)} • day ${c.daysElapsed}/${c.totalDays}</span></div>`; }).join('') || '<div class="text-[11px] text-slate-400">Join or create a challenge to start scoring.</div>';

    m.innerHTML = `
      <div class="bg-slate-900 border border-emerald-500/30 rounded-3xl max-w-lg w-full my-3 p-4 sm:p-5 space-y-4" style="padding-top:max(1rem,env(safe-area-inset-top))">
        <div class="flex items-start justify-between gap-2">
          <div><span class="text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Phone Health Sync</span>
            <h3 class="text-lg font-extrabold text-white mt-1">📲 Connect your health app</h3>
            <p class="text-xs text-slate-400">Choose whichever source(s) you use. Your totals feed every challenge you are in — manual entries are rejected.</p></div>
          <button type="button" onclick="LIVE_UI.closeConnect()" class="px-2.5 py-1 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold">✕</button>
        </div>
        ${cards}
        <div class="p-3 rounded-2xl bg-slate-950 border border-slate-800 space-y-1.5"><div class="text-xs font-extrabold text-white">🧭 Where your data goes</div>${feeds}</div>
        <div class="p-3 rounded-2xl bg-slate-950 border border-slate-800">
          <div class="flex items-center justify-between"><div class="text-xs font-extrabold text-white">🗓️ Received in the last 14 days</div><button type="button" onclick="LIVE_UI.openConnect()" class="text-[11px] text-sky-300 underline">Refresh</button></div>
          ${dayRows ? `<table class="w-full text-[11px] mt-1.5"><tbody>${dayRows}</tbody></table>` : '<div class="text-[11px] text-slate-400 mt-1">Nothing received yet. After you finish setup, run your automation once — it should appear here within seconds.</div>'}
        </div>
        <div class="text-[10px] text-slate-500 leading-relaxed">If two sources report the same day, your ⭐ primary source is used so nothing is double-counted. Daily totals above a plausible ceiling (e.g. 80,000 steps) are quarantined and shown in the audit ledger. Direct Strava/Fitbit logins aren't offered: Strava's API terms bar showing one athlete's data to other users, and the legacy Fitbit API is being shut down.</div>
      </div>`;
  }
  const priorityOf = (provider) => { const c = LIVE.connections.find((x) => x.provider === provider); return c ? c.priority : 100; };

  const LIVE_UI = (window.LIVE_UI = {
    openConnect, closeConnect, installApp, openAccount, signOut, joinPrompt,
    async setup(provider) {
      try {
        const out = await api('POST', '/health/connections', { provider });
        await refresh();
        await openConnect(provider, { provider, ingestUrl: out.ingestUrl });
        toast(out.message);
      } catch (e) { toast(`⚠️ ${e.message}`); }
    },
    guide(provider) { openConnect(provider); },
    async copyUrl() { const el = $('sfSyncUrl'); if (el && await copyText(el.textContent)) toast('📋 Sync URL copied'); },
    async makePrimary(id) {
      try {
        for (const c of LIVE.connections) await api('PATCH', `/health/connections/${c.id}`, { priority: c.id === id ? 1 : Math.max(c.priority, 10) });
        await refresh(); await openConnect(); toast('⭐ Primary source updated');
      } catch (e) { toast(`⚠️ ${e.message}`); }
    },
    async toggleConn(id, enabled) { try { await api('PATCH', `/health/connections/${id}`, { enabled }); await refresh(); await openConnect(); } catch (e) { toast(`⚠️ ${e.message}`); } },
    async disconnect(id) {
      if (!confirm('Disconnect this source? Its sync URL stops working. Days already synced stay in your history.')) return;
      try { await api('DELETE', `/health/connections/${id}`); await refresh(); await openConnect(); toast('Disconnected'); } catch (e) { toast(`⚠️ ${e.message}`); }
    },
    exitDemo() { sessionStorage.removeItem('sf_demo'); location.reload(); }
  });
  // the original "Health router" modal button now opens the real screen
  const origOpenModal = window.openModal;
  window.openModal = function (id) {
    if (LIVE.on && id === 'healthSyncRouterModal') { openConnect(); return; }
    return origOpenModal(id);
  };

  // ---------------------------------------------------------------- boot
  const css = document.createElement('style');
  css.textContent = `
    body.live-mode .demo-only { display: none !important; }
    #sfConnect pre, #sfConnect code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    header.sticky { padding-top: env(safe-area-inset-top); }
    nav.ios-tabbar-blur { padding-bottom: calc(0.25rem + env(safe-area-inset-bottom)); }
    @media (max-width: 520px), (display-mode: standalone) { body.live-mode #iosStatusBar { display: none; } }
  `;
  document.head.appendChild(css);

  async function boot() {
    LIVE.booting = true;
    const splash = $('sfSplash') || Object.assign(document.createElement('div'), { id: 'sfSplash', className: 'fixed inset-0 z-[95] flex items-center justify-center bg-black', innerHTML: '<div class="text-center space-y-2"><img src="/icons/icon-192.png" class="w-16 h-16 rounded-2xl mx-auto animate-pulse" alt=""><div class="text-xs text-slate-400">Loading StakeFit…</div></div>' });
    document.body.appendChild(splash);
    splash.style.display = '';
    try {
      const s = await api('GET', '/state');
      LIVE.on = true;
      document.body.classList.add('live-mode');
      const prefs = JSON.parse(store.get(PREF_KEY) || '{}');
      if (prefs.activeChallengeId) state.activeChallengeId = prefs.activeChallengeId;
      state.simpleView = prefs.simpleView || 'hub';
      applyState(s);
      const pj = pendingJoin();
      if (pj) {
        try { const out = await api('POST', '/challenges/join', { code: pj.code, invitationId: pj.inv }); clearPendingJoin(); const s2 = await api('GET', '/state'); applyState(s2); state.activeChallengeId = out.id; swapChallengeScopedState(); toast(out.already ? 'You are already in this challenge' : `🎉 You joined "${out.title}"!`); if (!out.already) setTimeout(openConnect, 700); }
        catch (e) { clearPendingJoin(); toast(`⚠️ ${e.message}`); }
      }
      LIVE.booting = false;
      splash.style.display = 'none';
      const view = new URLSearchParams(location.search).get('view');
      switchSimpleView(view === 'sync' ? (state.simpleView || 'hub') : (view || state.simpleView || 'hub'));
      if (view === 'sync') openConnect();
      updateInstallButton();
      startPolling();
    } catch (e) {
      splash.style.display = 'none';
      if (e.offline) {
        const cached = store.get(CACHE_KEY);
        if (cached) { LIVE.on = true; applyState(JSON.parse(cached)); LIVE.booting = false; showOfflineBanner(true); switchSimpleView('hub'); return; }
      }
      if (sessionStorage.getItem('sf_demo') === '1') { LIVE.on = false; LIVE.booting = false; renderAll(); return; }
      showAuth();
    }
  }

  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    const tick = () => {
      if (!LIVE.on || document.hidden) return;
      const a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
      if (document.querySelector('#sfConnect:not(.hidden)')) return;
      refresh({ keepTicker: true });
    };
    pollTimer = setInterval(tick, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  }

  document.addEventListener('DOMContentLoaded', () => {});
  // Script runs after the page markup; boot immediately.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
