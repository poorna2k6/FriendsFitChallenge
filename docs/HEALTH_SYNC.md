# Phone health-app sync

## What is and isn't possible from a web app / PWA

| Source | Can a website read it directly? | What StakeFit does |
|---|---|---|
| **Apple Health (HealthKit)** | No. Apple exposes no web API | iPhone sends daily totals to your private sync URL via the **Health Auto Export** app or a free **Apple Shortcut** automation |
| **Google Health Connect (Android)** | No. Native-only SDK | A Health Connect → webhook bridge app (or Tasker-style automation) POSTs daily totals |
| Garmin / Whoop / Oura / Samsung / Fitbit | Only through their partner APIs | Anything that syncs into Apple Health or Health Connect is included automatically; otherwise POST via the generic webhook |
| **Strava** | Yes (OAuth) | **Not offered.** Strava's API terms (tightened Nov 2024; developer-forum threads from Oct 2026 still cite the restriction under the June 2026 agreement) bar showing one athlete's data to other users, which is what a leaderboard does. Check the current agreement or ask Strava before relying on it either way |
| **Fitbit Web API** | Yes (OAuth) | **Not offered.** Google is retiring the legacy API (support ended 30 Sep 2026; Google's pages give shutdown dates between 30 Oct and 2 Nov 2026) and its replacement, the Google Health API, is restricted-scope and not onboarding new projects |

Roadmap to a true one-tap experience: wrap the PWA with **Capacitor** and add HealthKit + Health Connect plugins (the server API below stays unchanged), or add an aggregator such as Open Wearables / Junction / Terra for Garmin, Whoop, Oura.

## How it works

1. User opens **Connect Health App**, picks one or more sources, taps **Set up** → the server creates a private sync URL: `https://<your-domain>/api/ingest/sf_…` (shown once; only its SHA-256 is stored).
2. The phone-side sender POSTs **daily totals** (JSON) to that URL, as often as it likes.
3. The server validates, stores per-user/per-day/per-metric rows in `daily_metrics`, then every challenge the user is in recomputes scores from those rows (+ approved adjustments). Nothing is added twice: re-sending a day **replaces** that day.
4. If two sources report the same day, the user's **⭐ primary** source (lowest priority number) is used and the overlap is logged as `DEDUPED`.

## Payload formats

Native (one object, an array, or `{"samples":[…]}`):

```json
{ "date": "2026-10-27", "steps": 8423, "calories": 512, "minutes": 42, "distance_km": 6.1 }
```

Accepted aliases: `step_count`; `active_calories`, `active_energy_kcal`; `exercise_minutes`, `workout_minutes`; `distance` (km), `distance_m`, `distance_mi`. Numbers may be strings (`"8,423"`). Dates: `YYYY-MM-DD`, `MM/DD/YYYY` or anything `Date.parse` understands (use the user's **local** date).

Health Auto Export JSON (`data.metrics[].{name,units,data[].{date,qty,source}}`) is parsed for `step_count`, `active_energy` (kcal or kJ), `apple_exercise_time`, `walking_running_distance` (km, mi or m). *The exact HAE schema could not be re-verified online while building this; parsing is tolerant, and a manual export from the app is the quickest test.* When several devices report the same metric/day (iPhone + Watch) the **maximum** is used, never the sum.

curl test:

```bash
curl -X POST "https://YOUR-APP/api/ingest/sf_YOURTOKEN" \
  -H "content-type: application/json" \
  -d '{"date":"2026-10-27","steps":8423,"calories":512}'
# {"ok":true,"accepted":2,"quarantined":0,"rejected":0,"days":["2026-10-27"]}
```

`GET /api/ingest/<token>` returns `{ok:true,…}` — handy as a connectivity check.

## Apple Shortcut recipe (free)

1. **Find Health Samples** (Type: Steps, Start Date: is today) → **Calculate Statistics** (Sum).
2. **Get Contents of URL** — URL = your sync URL, Method **POST**, Request Body **JSON**: `date` = *Current Date* formatted `yyyy-MM-dd`, `steps` = *Statistics*. (Repeat the Find/Calculate pair for active energy and exercise minutes if you want them.)
3. Shortcuts → **Automation → Time of Day** (e.g. 10:00, 14:00, 18:00, 22:00) → run the shortcut → turn **Ask Before Running** off.

## Anti-cheat & integrity (server side, every request)

* Token-authenticated; revoke/rotate any time; 240 requests/hour per source.
* Rejects `userEntered: true`, negative/non-numeric values, dates outside today−45…today+1.
* **Quarantines** implausible daily totals (steps > 80,000, active kcal > 6,000, minutes > 600, km > 120) — visible to the user in the audit ledger; an admin can credit a legit freak day through an override.
* Identical payloads within 24 h are ignored (`DEDUPED`).
* Members cannot credit themselves by typing: manual entries become admin-approval requests.
* Honest limit: a determined cheater can still fake what *their own phone* sends (e.g. a step-spoofing app). This is a friends-and-family trust model hardened against casual cheating, not a tamper-proof attestation. Native HealthKit/Health Connect `wasUserEntered` metadata (roadmap) closes most of the remaining gap.

## API reference (all under `/api`, JSON, cookie session, header `X-SF-Client: 1` on writes)

`POST /auth/signup|login|logout` · `GET /state` · `PATCH /me` · `POST /challenges` · `PATCH /challenges/:id` · `POST /challenges/join` · `GET /challenges/preview?code=` · `POST /challenges/:id/{peek,habit,grace,nudge,override,glitch,invites,modules}` · `POST /challenges/:id/glitch/:rid/(approve|reject)` · `POST /challenges/:id/members/:uid/paid` · `POST /challenges/:id/modules/:modId/toggle` · `DELETE /challenges/:id/invites/:iid` · `POST /health/connections` · `PATCH|DELETE /health/connections/:id` · `GET /health/daily` · `POST|GET /ingest/:token` (public, token-auth) · `GET /healthz`.
