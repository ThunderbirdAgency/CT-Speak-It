-- Mockingbird event log.
-- Run once against your Supabase project (SQL editor or `supabase db push`),
-- then set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on the Mockingbird
-- deployment. Every dictation and voice action across ALL your apps lands here.

create table if not exists public.mockingbird_events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  app         text,               -- which build (appContext / page title)
  user_id     text,               -- who spoke (widget userId option)
  kind        text not null,      -- 'dictation' | 'action' | 'transcribe'
  raw_text    text,               -- what the recognizer heard
  output_text text,               -- what Claude produced (dictation)
  actions     jsonb,              -- matched actions [{name, input}, ...]
  duration_ms integer,            -- server processing time
  meta        jsonb               -- tone, dictionary size, model, etc.
);

create index if not exists mockingbird_events_created_at_idx
  on public.mockingbird_events (created_at desc);
create index if not exists mockingbird_events_user_idx
  on public.mockingbird_events (user_id, created_at desc);
create index if not exists mockingbird_events_kind_idx
  on public.mockingbird_events (kind);

-- Lock the table down: only the service role (used by the API endpoints)
-- can write; browsers have no direct access.
alter table public.mockingbird_events enable row level security;
