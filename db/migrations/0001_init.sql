-- StakeFit schema (PostgreSQL 13+). Idempotent: safe to re-run.
-- Money is stored as integer cents. Dates are plain DATE (the day the phone reports, in the user's local time).

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text not null,
  avatar        text not null,
  color         text not null default '#10b981',
  password_hash text not null,
  created_at    timestamptz not null default now()
);
create unique index if not exists users_email_key on users (lower(email));

-- One row per phone-health source a user chose to connect. The ingest token is stored hashed.
create table if not exists health_connections (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  provider         text not null check (provider in ('apple_health','health_connect','webhook')),
  label            text not null,
  token_hash       text not null unique,
  token_hint       text not null,
  priority         int  not null default 10,           -- lower wins when two sources report the same day
  enabled          boolean not null default true,
  last_sync_at     timestamptz,
  samples_received int not null default 0,
  created_at       timestamptz not null default now(),
  unique (user_id, provider)
);

-- Raw per-user daily totals as reported by the phone, independent of any challenge.
create table if not exists daily_metrics (
  user_id     uuid not null references users(id) on delete cascade,
  day         date not null,
  metric      text not null check (metric in ('steps','calories','minutes','distance')),
  provider    text not null,
  value       numeric not null check (value >= 0),
  source_name text,
  updated_at  timestamptz not null default now(),
  primary key (user_id, day, metric, provider)
);
create index if not exists daily_metrics_user_day on daily_metrics (user_id, day);

create table if not exists challenges (
  id               uuid primary key default gen_random_uuid(),
  admin_id         uuid not null references users(id),
  title            text not null,
  metric           text not null check (metric in ('steps','calories','minutes','distance','habits','hybrid')),
  duration_key     text not null check (duration_key in ('1W','1M','1Y')),
  start_date       date not null,
  buy_in_cents     int  not null check (buy_in_cents > 0),
  cutoff_pct       numeric not null default 70,
  slash_pct        numeric not null default 100,
  distribution_mode text not null default 'proportional_total'
                   check (distribution_mode in ('proportional_total','proportional_surplus','all_in_pot')),
  daily_benchmark  numeric not null,
  governance_locked boolean not null default false,
  invite_code      text not null unique,
  peek             jsonb not null default '{}'::jsonb,   -- blindMode, feeType, peekOneCost, peekAllCost, peekAllMode, billingWindow, routingMode
  modules          jsonb not null default '[]'::jsonb,   -- feature plug-ins / critic safeguards
  created_at       timestamptz not null default now()
);

create table if not exists memberships (
  challenge_id uuid not null references challenges(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  paid         boolean not null default false,
  paid_at      timestamptz,
  grace_active boolean not null default false,
  joined_at    timestamptz not null default now(),
  primary key (challenge_id, user_id)
);
create index if not exists memberships_user on memberships (user_id);

-- Non-sensor score changes: habit boosters, admin overrides, approved glitch fixes, late-join pace normalisation.
create table if not exists adjustments (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references challenges(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  day          date not null default current_date,
  amount       numeric not null,
  kind         text not null check (kind in ('habit','admin_override','glitch_fix','prorate')),
  ref          text,
  note         text,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now()
);
create index if not exists adjustments_chal_user on adjustments (challenge_id, user_id);

create table if not exists glitch_requests (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references challenges(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  delta        numeric not null check (delta > 0),
  reason       text not null,
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  uuid references users(id)
);

create table if not exists invitations (
  id               uuid primary key default gen_random_uuid(),
  challenge_id     uuid not null references challenges(id) on delete cascade,
  name             text not null,
  contact          text not null,
  channel          text not null,
  device           text not null,
  status           text not null default 'sent' check (status in ('sent','accepted','cancelled')),
  created_by       uuid not null references users(id),
  accepted_user_id uuid references users(id),
  created_at       timestamptz not null default now()
);

-- Pay-to-peek. target_id NULL = "peek all" pass. expires_day is a challenge day number (like the UI).
create table if not exists peek_passes (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references challenges(id) on delete cascade,
  viewer_id    uuid not null references users(id) on delete cascade,
  target_id    uuid references users(id) on delete cascade,
  fee_cents    int not null check (fee_cents >= 0),
  expires_day  int not null,
  created_at   timestamptz not null default now()
);
create index if not exists peek_passes_lookup on peek_passes (challenge_id, viewer_id);

-- Where each peek fee went: to_user NULL = winners' pot.
create table if not exists peek_payments (
  id           uuid primary key default gen_random_uuid(),
  pass_id      uuid not null references peek_passes(id) on delete cascade,
  challenge_id uuid not null references challenges(id) on delete cascade,
  to_user      uuid references users(id),
  amount_cents int not null check (amount_cents >= 0)
);
create index if not exists peek_payments_chal on peek_payments (challenge_id);

-- Activity feed + live ticker + peek ledger + nudges.
create table if not exists events (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references challenges(id) on delete cascade,
  user_id      uuid references users(id) on delete set null,
  kind         text not null,
  text         text not null,
  amount       numeric,
  unit         text,
  source       text,
  created_at   timestamptz not null default now()
);
create index if not exists events_chal_time on events (challenge_id, created_at desc);

-- Anti-cheat / telemetry audit ledger. payload_hash is the real SHA-256 of the received body.
create table if not exists audit_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  provider     text,
  verdict      text not null check (verdict in ('VERIFIED','QUARANTINED','DEDUPED')),
  source_label text not null,
  detail       text,
  delta        text,
  payload_hash text,
  created_at   timestamptz not null default now()
);
create index if not exists audit_user_time on audit_log (user_id, created_at desc);

-- Tiny fixed-window limiter (works on serverless where memory is not shared).
create table if not exists rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  hits         int not null
);
