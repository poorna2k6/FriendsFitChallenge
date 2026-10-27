# Deploying StakeFit to Vercel (with Postgres)

## Architecture

```
public/            static PWA: index.html, live.js, engine.js, sw.js, manifest, icons, built CSS, Chart.js
api/[...path].js   ONE serverless function (Node) → lib/handler.js → lib/routes.js
lib/               auth, http, scoring, state builder, health ingest, peek pricing
db/schema.sql      Postgres schema (idempotent); db/migrate.js applies it
```
Why one function? Vercel's free plan caps functions per deployment; a single catch-all keeps you far from it.

## 1. Push the repo and import it in Vercel
1. Vercel dashboard → **Add New → Project** → import `poorna2k6/friendsfitchallenge`.
2. Framework preset: **Other**. Leave build/output settings as detected (`vercel.json` already sets `npm run build` and output `public`).

## 2. Add the database
Vercel dashboard → your project → **Storage → Create / Connect → Neon (Postgres)** (Vercel's Postgres is provided via the Neon marketplace integration). Accept the defaults and connect it to **Production + Preview**. This injects `DATABASE_URL` / `POSTGRES_URL` automatically.
*(Any Postgres 13+ works — Supabase, Railway, RDS — just set `DATABASE_URL`.)*

## 3. Add the secret
Project → **Settings → Environment Variables**:

| Name | Value |
|---|---|
| `AUTH_SECRET` | output of `openssl rand -base64 32` (≥ 16 chars; rotating it signs everyone out) |

## 4. Deploy
Click **Deploy**. The build runs `node db/migrate.js --if-configured`, which creates all tables (safe to re-run on every deploy). If you added the database after the first deploy, just **Redeploy**.

Check: open `https://YOUR-APP.vercel.app/api/healthz` → `{"ok":true}`.

## 5. Use it
1. Open the site on your phone, **Create account**, then **Connect health app** (see `docs/HEALTH_SYNC.md`).
2. Install: iPhone Safari → Share → *Add to Home Screen*; Android Chrome → *Install app*. (There is also an **Install App** button in the header.)
3. Create a challenge, tap **Admin → Copy Invite Link**, send it to friends. Friends open the link, create an account and are dropped into the challenge.

## Local development

```bash
npm install
createdb stakefit_dev                                   # any local Postgres
export DATABASE_URL=postgres://localhost/stakefit_dev DATABASE_SSL=off AUTH_SECRET=dev-secret-dev-secret
npm run db:migrate
npm run dev                                             # http://localhost:3000
npm test                                                # engine/parser/auth unit tests
DATABASE_URL=… npm test                                 # + full API end-to-end test (use a scratch DB: it truncates tables)
```
`npm run build:css` regenerates `public/assets/app.css` after you change Tailwind classes in `public/index.html` or `public/live.js` (the generated file is committed so deploys need no build tooling). `npm run build:vendor` re-copies Chart.js; `npm run build:icons` re-renders the PNG icons (needs Playwright).

## Operational notes
* Cookies are `HttpOnly; SameSite=Lax; Secure` (on HTTPS); writes also require the `X-SF-Client` header (CSRF defence). A strict CSP is set in `vercel.json`.
* Scale: the free Neon tier and Hobby plan comfortably handle a few hundred friends-and-family users. `lib/db.js` uses a tiny pool (3) per function instance.
* The service worker (`public/sw.js`) caches the app shell only; `/api/*` is never cached. Bump `VERSION` in `sw.js` when you want clients to drop old caches.
* Backups: use Neon's point-in-time restore or `pg_dump "$DATABASE_URL"`.
* Real-money warning: this app **tracks** stakes; it does not hold or move funds. Check your local gambling / money-transmission rules before running paid pots, and consider a regulated escrow/payment partner.
