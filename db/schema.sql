-- Mockingbird database.
-- Run once against your Supabase project (SQL editor or `supabase db push`),
-- then set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on the Mockingbird
-- deployment. Everything here is optional: with no Supabase configured,
-- Mockingbird works exactly the same, it just doesn't remember anything.
--
-- Safe to re-run: this file is idempotent, so it also upgrades an existing
-- v3 install (the ALTERs add the columns introduced with connectors).

-- ---------------------------------------------------------------- events
-- Every dictation, every resolved command, every action actually executed —
-- across the web widget and the desktop app.

create table if not exists public.mockingbird_events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  app         text,               -- which build / which app was in front of them
  user_id     text,               -- who spoke (widget userId / desktop userId)
  kind        text not null,      -- 'dictation' | 'action' | 'execute' | 'transcribe'
  raw_text    text,               -- what the recognizer heard
  output_text text,               -- what Claude produced, or what the action did
  actions     jsonb,              -- matched actions [{name, input}, ...]
  connector   text,               -- 'followupboss', 'apu', ... when executed by Mockingbird
  status      text,               -- 'ok' | 'error' for executed actions
  duration_ms integer,            -- server processing time
  meta        jsonb               -- tone, model, mode, per-action results
);

alter table public.mockingbird_events add column if not exists connector text;
alter table public.mockingbird_events add column if not exists status text;

create index if not exists mockingbird_events_created_at_idx
  on public.mockingbird_events (created_at desc);
create index if not exists mockingbird_events_user_idx
  on public.mockingbird_events (user_id, created_at desc);
create index if not exists mockingbird_events_kind_idx
  on public.mockingbird_events (kind);
create index if not exists mockingbird_events_connector_idx
  on public.mockingbird_events (connector, created_at desc);

-- --------------------------------------------------------------- profiles
-- The distilled working profile per person: how they write, the names they
-- use, how they run their process. Rebuilt periodically from the events above
-- and fed back into the prompts so Mockingbird sounds like them and resolves
-- their commands correctly. The user can read it (GET /api/profile) and delete
-- it (DELETE /api/profile) — see docs/LEARNING.md.

create table if not exists public.mockingbird_profiles (
  user_id     text primary key,
  updated_at  timestamptz not null default now(),
  events_seen integer,
  summary     text,               -- plain-language version the person can read
  profile     jsonb               -- {writing_style, phrases, vocabulary, people, working_patterns, preferences}
);

-- Lock both tables down: only the service role (used by the API endpoints)
-- can read or write; browsers and desktop clients have no direct access.
alter table public.mockingbird_events enable row level security;
alter table public.mockingbird_profiles enable row level security;

-- ------------------------------------------------------------------ views
-- Ready-made rollups for a usage dashboard.

create or replace view public.mockingbird_daily_usage as
  select
    date_trunc('day', created_at)                       as day,
    user_id,
    count(*) filter (where kind = 'dictation')          as dictations,
    count(*) filter (where kind = 'action')             as commands,
    count(*) filter (where kind = 'execute')            as executed,
    count(*) filter (where kind = 'execute'
                       and status = 'error')            as failed,
    round(avg(duration_ms))                             as avg_ms,
    sum(coalesce(array_length(regexp_split_to_array(
      coalesce(output_text, raw_text, ''), '\s+'), 1), 0)) as words
  from public.mockingbird_events
  group by 1, 2;
