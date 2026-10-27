#!/usr/bin/env bash
# One-time setup: link the Vercel project, attach a free Neon Postgres, set AUTH_SECRET.
# Schema creation + all future schema changes are automatic: every build runs `node db/migrate.js`.
set -euo pipefail
V="npx --yes vercel@latest"

echo "1/3  Linking this folder to a Vercel project (log in if asked)..."
$V link --yes

echo "2/3  Adding a Postgres database via the Neon integration."
echo "     >>> When prompted for a plan, choose FREE. Connect it to Production, Preview and Development. <<<"
if $V env ls production 2>/dev/null | grep -qE '^ *(DATABASE_URL|POSTGRES_URL) '; then
  echo "     A database is already connected - skipping."
else
  $V integration add neon
fi

echo "3/3  Setting AUTH_SECRET (used to sign login cookies)..."
if $V env ls production 2>/dev/null | grep -qE '^ *AUTH_SECRET '; then
  echo "     AUTH_SECRET already set - skipping."
else
  SECRET="$(openssl rand -base64 32)"
  for env in production preview development; do
    printf '%s' "$SECRET" | $V env add AUTH_SECRET "$env" >/dev/null
  done
  echo "     AUTH_SECRET stored for production, preview and development."
fi

echo
echo "Done. Deploy with:  npx vercel --prod     (or push to your production branch)"
echo "The build will create the tables automatically and apply any future migrations."
