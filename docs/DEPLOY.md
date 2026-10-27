# Deploying StakeFit to Vercel (with Postgres)

## Architecture

```
public/            static PWA: index.html, live.js, engine.js, sw.js, manifest, icons, built CSS, Chart.js
api/index.js       ONE serverless function (vercel.json rewrites /api/* to it) (Node) → lib/handler.js → lib/routes.js
lib/               auth, http, scoring, state builder, health ingest, peek pricing
db/migrations/*.sql  versioned schema; db/migrate.js applies new ones on every build
```
Why one function? Vercel's free plan caps functions per deployment; a single catch-all keeps you far from it.

## 1. Push the repo and import it in Vercel
1. Vercel dashboard → **Add New → Project** → import `poorna2k6/friendsfitchallenge`.
2. Framework preset: **Other**. Leave build/output settings as detected (`vercel.json` already sets `npm run build` and output `public`).

## 2 + 3. Database and secret — one command (or the dashboard)

**Command line (recommended):**
```bash
npm install
npm run setup:vercel
```
It links the folder to your Vercel project, runs `vercel integration add neon` (**choose the Free plan** when prompted and connect it to Production, Preview and Development), and generates + stores `AUTH_SECRET`. It skips anything already configured, so it is safe to re-run.

**Or by hand:** Vercel dashboard → project → **Storage → Create → Neon (Postgres)**, then **Settings → Environment Variables** → add `AUTH_SECRET` = `openssl rand -base64 32`.

*(Any Postgres 13+ works — Supabase, Railway, RDS — just set `DATABASE_URL`.)*

### How the schema stays up to date automatically
`vercel.json` runs `npm run build` = `node db/migrate.js --if-configured` on every deployment. It applies each file in `db/migrations/` that isn't yet recorded in the `schema_migrations` table, inside a transaction, under a Postgres advisory lock (two simultaneous builds can't collide). To change the database in future, add the next numbered file (e.g. `db/migrations/0002_add_timezone.sql`), commit, push — the next build applies it, and a failing migration fails the build so broken schema never goes live.

Rules of thumb: migrations are forward-only (never edit an applied file); prefer additive changes (`add column … if not exists`) so the previous deployment keeps working while the new one rolls out. **Preview builds skip migrations** by default because Neon's integration usually shares one database across environments; set `MIGRATE_ON_PREVIEW=1` (or give previews their own database) if you want them to migrate.

## 4. Deploy
Click **Deploy**. The build creates all tables on the first run. If you added the database after the first deploy, just **Redeploy**.

Check: open `https://YOUR-APP.vercel.app/api/healthz`. It should show `"ok":true`; otherwise it tells you which piece is missing (`authSecret`, `databaseUrl`, `database`, `schema`). If tables are missing (e.g. a preview build, which skips migrations) the first sign-up/login creates them automatically.

## 5. Use it
1. Open the site on your phone, **Create account**, then **Connect health app** (see `docs/HEALTH_SYNC.md`).
2. Install: iPhone Safari → Share → *Add to Home Screen*; Android Chrome → *Install app*. (There is also an **Install App** button in the header.)
3. Create a challenge, tap **Admin → Copy Invite Link**, send it to friends. Friends open the link, create an account and are dropped into the challenge.

## Local development

```bash
npm install
createdb stakefit_dev                                   # any local Postgres
export DATABASE_URL=postgres://localhost/stakefit_dev DATABASE_SSL=off AUTH_SECRET=dev-secret-dev-secret
npm run db:migrate                                      # applies db/migrations
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
