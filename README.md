# StakeFit — Friends Fitness Challenge

Stake money on your fitness with friends. Everyone's phone health data (steps, active calories, workout minutes, distance) keeps score; people below the cutoff forfeit stake to the qualifiers, proportionally. Installable PWA, Postgres-backed, deployable on Vercel.

* **Live mode** (signed in): real accounts, shared challenges, server-enforced blind mode, pay-to-peek, admin tools, phone health sync via private webhook URLs.
* **Demo mode** (no account): the original in-browser simulation with sample data.

| Doc | What's in it |
|---|---|
| [docs/FEATURE_ANALYSIS.md](docs/FEATURE_ANALYSIS.md) | Every feature of the original page, what changed, bugs fixed, honest gaps |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Vercel + Postgres setup, env vars, local dev |
| [docs/HEALTH_SYNC.md](docs/HEALTH_SYNC.md) | Apple Health / Health Connect sync, payload formats, anti-cheat, API reference |

Quick start: `npm install && npm test` · deploy steps in `docs/DEPLOY.md`.
