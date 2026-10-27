/* StakeFit shared engine: payout maths + metric catalog. Runs in the browser (demo + live) and on the server. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StakeFitEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const METRICS = {
    steps: { name: 'Steps Count', unit: 'steps', shortUnit: 'steps', icon: '👣', defaultDaily: 10000, maxPlausibleDaily: 80000 },
    calories: { name: 'Active Calories', unit: 'kcal', shortUnit: 'kcal', icon: '🔥', defaultDaily: 650, maxPlausibleDaily: 6000 },
    minutes: { name: 'Workout Minutes', unit: 'mins', shortUnit: 'mins', icon: '⏱️', defaultDaily: 45, maxPlausibleDaily: 600 },
    distance: { name: 'Distance Covered', unit: 'km', shortUnit: 'km', icon: '🏃', defaultDaily: 6, maxPlausibleDaily: 120 },
    habits: { name: 'Daily Habit & Wellness Points', unit: 'pts', shortUnit: 'pts', icon: '💧', defaultDaily: 50, maxPlausibleDaily: 500 },
    hybrid: { name: 'Hybrid Sweat Score', unit: 'sweat pts', shortUnit: 'pts', icon: '⚡', defaultDaily: 250, maxPlausibleDaily: 2500 }
  };
  const DURATIONS = {
    '1W': { label: '1 Week Challenge', totalDays: 7, short: '1 Week (7d)' },
    '1M': { label: '1 Month Challenge', totalDays: 30, short: '1 Month (30d)' },
    '1Y': { label: '1 Year Challenge', totalDays: 365, short: '1 Year (365d)' }
  };

  /** Hybrid Sweat Score = steps/100 + active kcal/10 + workout mins * 2 */
  function hybridScore(steps, calories, minutes) {
    return (steps || 0) / 100 + (calories || 0) / 10 + (minutes || 0) * 2;
  }

  /**
   * ch  : { buyIn, cutoffPct, slashPct, distributionMode, dailyBenchmark, daysElapsed, friends:[{id,score,...}] }
   * ctx : { peek:{totalPeekPot, spyRoyaltiesByMember, peekFeesByMember}, antiSandbag:boolean, graceMap:{[id]:bool}, routingMode, peekCap?:boolean }
   * Returns the same shape the UI has always consumed. Pure: never mutates its inputs.
   */
  function computeStandings(ch, ctx) {
    ctx = ctx || {};
    const peek = ctx.peek || {};
    const spy = peek.spyRoyaltiesByMember || {};
    const fees = peek.peekFeesByMember || {};
    const graceMap = ctx.graceMap || {};
    const safeBuyIn = Math.max(0.01, Number(ch.buyIn) || 5);
    const safeCutoffPct = Math.max(10, Math.min(99, Number(ch.cutoffPct) || 70));
    const safeSlashPct = Math.max(0, Math.min(100, Number.isFinite(Number(ch.slashPct)) ? Number(ch.slashPct) : 100));
    const peekPotBonus = Number(peek.totalPeekPot || 0);

    const friendsSorted = [...ch.friends].sort((a, b) => b.score - a.score);
    const rawTopScore = friendsSorted.length > 0 ? Math.max(1, friendsSorted[0].score) : 1;
    const minLeaderFloor = ctx.antiSandbag ? Math.round((ch.dailyBenchmark || 100) * Math.max(1, ch.daysElapsed) * 0.5) : 1;
    const topScore = Math.max(rawTopScore, minLeaderFloor);
    const cutoffScore = Math.round(topScore * (safeCutoffPct / 100));
    const totalEscrowPot = friendsSorted.length * safeBuyIn;
    const slashFraction = safeSlashPct / 100;

    const enriched = friendsSorted.map((f, idx) => {
      const hasGrace = Boolean(graceMap[f.id]);
      const effectiveCutoffPct = hasGrace ? Math.max(10, safeCutoffPct - 5) : safeCutoffPct;
      const memberCutoff = Math.round(topScore * (effectiveCutoffPct / 100));
      const isSafe = f.score >= memberCutoff || idx === 0;
      return {
        ...f,
        rank: idx + 1,
        pctOfTop: (f.score / topScore) * 100,
        isTopLeader: idx === 0,
        isSafe,
        gapToCutoff: isSafe ? 0 : Math.ceil(memberCutoff - f.score),
        bufferAboveCutoff: isSafe ? Math.max(0, Math.floor(f.score - memberCutoff)) : 0
      };
    });

    const qualifiers = enriched.filter((f) => f.isSafe);
    const failed = enriched.filter((f) => !f.isSafe);
    const forfeitedPool = failed.length * safeBuyIn * slashFraction;
    const totalBonusPool = forfeitedPool + peekPotBonus;
    const sumQualifierScores = qualifiers.reduce((a, f) => a + Math.max(1, f.score), 0);
    const sumQualifierSurplus = qualifiers.reduce((a, f) => a + Math.max(1, f.score - cutoffScore + 1), 0);

    const rows = enriched.map((f) => {
      let slashedAmount = 0, retainedBuyIn = safeBuyIn, achievementSharePct = 0, bonusWon = 0;
      if (!f.isSafe) {
        slashedAmount = safeBuyIn * slashFraction;
        retainedBuyIn = safeBuyIn - slashedAmount;
      } else if (ch.distributionMode === 'proportional_surplus') {
        const w = Math.max(1, f.score - cutoffScore + 1) / Math.max(1, sumQualifierSurplus);
        achievementSharePct = w * 100;
        bonusWon = totalBonusPool * w;
      } else if (ch.distributionMode === 'all_in_pot') {
        const shared = qualifiers.length * safeBuyIn + totalBonusPool;
        const w = Math.max(1, f.score) / Math.max(1, sumQualifierScores);
        achievementSharePct = w * 100;
        bonusWon = shared * w - safeBuyIn;
      } else {
        const w = Math.max(1, f.score) / Math.max(1, sumQualifierScores);
        achievementSharePct = w * 100;
        bonusWon = totalBonusPool * w;
      }
      const spyRoyaltyEarned = Number(spy[f.id] || 0);
      const peekSpent = Number(fees[f.id] || 0);
      let stakeDeductedByPeeks = ctx.routingMode === 'stake_deduct' ? peekSpent : 0;
      // Zero-Negative Escrow Protection: a member can never be charged more than they are owed back.
      if (ctx.peekCap) stakeDeductedByPeeks = Math.min(stakeDeductedByPeeks, Math.max(0, retainedBuyIn + bonusWon + spyRoyaltyEarned));
      const finalPayout = retainedBuyIn + bonusWon + spyRoyaltyEarned - stakeDeductedByPeeks;
      const netProfit = finalPayout - safeBuyIn;
      return {
        ...f, slashedAmount, retainedBuyIn, achievementSharePct, bonusWon, spyRoyaltyEarned, peekSpent,
        stakeDeductedByPeeks, finalPayout, netProfit, roiPct: safeBuyIn > 0 ? (netProfit / safeBuyIn) * 100 : 0
      };
    });

    return {
      buyIn: safeBuyIn, cutoffPct: safeCutoffPct, slashPct: safeSlashPct,
      topLeader: rows[0] || null, topScore, cutoffScore, totalEscrowPot, forfeitedPool, peekPotBonus,
      totalBonusPool, qualifiersCount: qualifiers.length, failedCount: failed.length, sumQualifierScores, rows
    };
  }

  /** Greedy minimal-transfer settlement: who pays whom, given net profit per member. */
  function settlementTransfers(rows) {
    const debtors = rows.filter((r) => r.netProfit < -0.004).map((r) => ({ id: r.id, name: r.name, amt: -r.netProfit }));
    const creditors = rows.filter((r) => r.netProfit > 0.004).map((r) => ({ id: r.id, name: r.name, amt: r.netProfit }));
    debtors.sort((a, b) => b.amt - a.amt);
    creditors.sort((a, b) => b.amt - a.amt);
    const out = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const pay = Math.min(debtors[i].amt, creditors[j].amt);
      if (pay > 0.004) out.push({ from: debtors[i].id, fromName: debtors[i].name, to: creditors[j].id, toName: creditors[j].name, amount: Math.round(pay * 100) / 100 });
      debtors[i].amt -= pay;
      creditors[j].amt -= pay;
      if (debtors[i].amt < 0.005) i++;
      if (creditors[j].amt < 0.005) j++;
    }
    return out;
  }

  return { METRICS, DURATIONS, hybridScore, computeStandings, settlementTransfers };
});
