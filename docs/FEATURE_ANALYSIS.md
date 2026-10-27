# StakeFit — Feature Analysis of the Original Page

Source analysed: `stakefit_friends_fitness_challenge_proportional_payout_tracker.html` (5,452 lines, one file, now `public/index.html`).
The original was a high-fidelity **single-browser prototype**: all data lived in `localStorage`, health sync was simulated with random numbers, and "signing in" meant choosing a friend from a dropdown.

Legend: ✅ kept and now backed by the database · 🔁 kept, behaviour changed for real use · 🧪 kept in demo mode only (simulation) · ➕ new

---

## 1. Feature inventory (nothing dropped)

### Challenge engine
| Feature | Original | Now |
|---|---|---|
| 6 metrics: steps, active kcal, workout minutes, distance (km), habit points, hybrid score (steps/100 + kcal/10 + mins×2) | typed/simulated | ✅ computed from synced daily totals; habits from boosters |
| 3 durations: 1 week / 1 month / 1 year | ✅ | ✅ |
| Buy-in, survival cutoff (% of #1), penalty (% of stake lost) | ✅ | ✅ (server-validated ranges) |
| 3 distribution modes: proportional-total, proportional-surplus, all-in-pot | ✅ | ✅ same maths (`public/engine.js`, shared by browser + server, verified against 54 golden cases captured from the original) |
| #1 always safe; forfeited pool + peek pot split among qualifiers | ✅ | ✅ |
| Governance lock ("smart-contract" rules immutable mid-challenge) | toggle | ✅ enforced server-side (403 on rule edits while locked) |
| Challenge day / days remaining | manual number + "Simulate Day" | 🔁 follows the calendar from `start_date`; admin can still correct it; 🧪 Simulate Day in demo |
| Per-member streak | random | 🔁 consecutive days hitting the daily target |

### Pay-to-peek / blind mode
| Feature | Now |
|---|---|
| Blind mode hides every rival's score and the #1 bar | 🔁 **enforced on the server**. Hidden numbers are never sent to the browser (the original hid them only visually; DevTools showed everything) |
| Peek 1 member / Peek all | ✅ priced server-side from the admin's rules |
| Fee type fixed $ or % of buy-in; presets 1¢–50¢; auto-scale to 2% of pot | ✅ |
| "Peek all" pricing: sum of others or flat bundle | ✅ |
| Billing window: weekly / daily / challenge / per click (free re-clicks inside the pass) | ✅ passes expire by challenge day (per-click = 1-day pass) |
| 4 fee routings: direct to peeked member, winners' pot, 80/20 spy royalty, stake handicap | ✅ cent-exact splitting (remainder to first recipient) |
| Peek ledger, "re-lock peeks" | ✅ ledger · 🧪 re-lock (demo; passes expire by themselves) |

### Roles & admin console
| Feature | Now |
|---|---|
| Creator becomes 👑 Admin; others are members; locked admin screen for members | ✅ real roles (`challenges.admin_id`) instead of name-matching |
| Invite form (WhatsApp / SMS / email), pending queue, copy invite link | 🔁 real single-use-trackable links `/?join=CODE&inv=ID`; WhatsApp/SMS/email deep links; "Simulate Accept & Pay" → "Copy Invite Link" |
| Add-friend modal (add a fake friend with a starting score) | 🔁 replaced by invites — friends join with their own account |
| Mark buy-in paid / pending | ✅ admin only |
| Admin unmasked table, manual score override (add/set/subtract + reason), 1-tap glitch fix | ✅ every override writes an adjustment, a feed entry and an audit entry |
| Member "my watch died" request → admin approve | ✅ + new Decline button |
| Rules editor (metric, duration, buy-in, cutoff, penalty, title, daily target, distribution) | ✅ debounced saves |

### Member experience
| Feature | Now |
|---|---|
| Activity ring (% of daily goal), total, daily average, streak, stake balance (buy-in − peeks + royalties) | ✅ |
| 1-tap habit boosters (💧 water, 😴 sleep + 3 more), 5 boosters in Coach tab | 🔁 once per booster per day and capped at 50% of a normal day (they were unlimited and honour-system) |
| 🛡️ Grace Freeze (−5% personal cutoff, 1 per challenge, toggle back) | ✅ gated by the plug-in switch |
| Squad story bar, 🔥👀⚡ nudges, "Hype Squad", live ticker | ✅ nudges stored in the activity feed |
| "+ Log Progress" manual entry (+ photo-proof source) | 🔁 manual numbers can't credit yourself: they become a request the admin approves (admin entries are audit-logged) |
| Copy group report (WhatsApp text) | ✅ |
| Projected final settlement, P2P transfer list, instant payout rails (Apple Cash / Venmo / UPI) | ✅ projections · rails are hand-off buttons only — **no money moves inside the app** |

### Plug-in hub, coach, dashboards
| Feature | Now |
|---|---|
| 6 plug-ins (grace, anti-sandbag floor, late-join normalisation, zero-negative escrow, weekend 2×, buddy shield) + add custom module | ✅ stored per challenge. Grace, anti-sandbag, late-join (88% of group average), zero-negative escrow and weekend 1.25× are now actually implemented in the engine; buddy shield is still cosmetic |
| Coach: rescue plans, pace needed to beat #1's projected finish | ✅ (hidden while blind) |
| Charts: progress vs cutoff, money flow | ✅ (hidden while blind) |
| Security tab: provider grid, BLE stream, fraud simulator, SHA-256 audit ledger, attestation counters | 🔁 provider grid + audit ledger are real (real SHA-256 of each payload, VERIFIED / QUARANTINED / DEDUPED verdicts) · 🧪 BLE stream and fraud simulator remain in demo mode |
| Swarm/critic review modal, OTA push, CI/CD YAML, Go-Live kit | 🧪 demo only (the "Go Live" button becomes **Install App** in live mode) |

### App chrome
Multi-challenge hub with All/Admin/Member/Created filters · iOS-style nav bar with role pill · paged vs scroll mode · phone-frame vs wide layout · 6-tab bottom bar · Dynamic-Island pill · toasts · 7 modals · header challenge switcher. All kept. The fake iOS status bar (clock, 5G, battery) is hidden on real phones / installed PWA, where the OS draws its own.

---

## 2. Bugs found in the original (fixed)

1. **Hub crashed `renderAll()` on every call** — `calc.totalPot` doesn't exist (`toFixed` of `undefined`), so everything after step 11B (nav chrome, charts, glitch list) never ran. Also printed `undefined` for `dCfg.badge` / `mCfg.label`, and `$NaN` in the Dynamic Island pill.
2. WhatsApp invite pack read `c.name`, `c.stake`, `c.peekFee` (real fields: `title`, `buyIn`, peek config) → "undefined / NaN".
3. Peek rules and plug-in switches were **global**, not per challenge — editing one room changed all of them.
4. "Zero-Negative Escrow", "Weekend 2×" and "Late-join normalisation" toggles did nothing / were applied unconditionally.
5. **Blind mode was cosmetic** — scores sat in browser memory and in the charts/feed/dashboard.
6. Cheating surface: unlimited habit-booster re-claims, manual logs credited instantly (only a 3.5× spike filter), admin identified by display-name equality, fake hashes ("0x9f8a…") that attested nothing.
7. User text was stored HTML-escaped but several templates inserted names/titles raw (XSS risk once data is shared between users).
8. Tailwind CDN runtime + Google Fonts + Chart.js CDN: blocked offline, not cacheable, flagged as "not for production".
9. Settlement transfers are a proportional approximation (kept; labelled in docs). Money is **not** held in escrow anywhere.

## 3. Honest gaps (not built)

* **No payments.** Buy-ins, payouts and peek fees are tracked, not moved. Adding Stripe Connect (or similar) is a separate regulated project (money-transmission / gambling rules differ by country and state — get advice before charging real money).
* **No native HealthKit / Health Connect.** Browsers cannot read them. See `docs/HEALTH_SYNC.md` for what is supported and the roadmap.
* No push notifications, password reset email, email verification, or challenge deletion/leave flow yet.
* "Buddy shield" plug-in is a toggle with no mechanics.
