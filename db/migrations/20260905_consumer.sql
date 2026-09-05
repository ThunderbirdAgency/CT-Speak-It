-- Additive consumer schema. Backend-only access; identity is verified by Clerk.
begin;
create table if not exists public.mockingbird_accounts (
 user_id text primary key,
 memory_enabled boolean not null default false,
 profile jsonb not null default '{}'::jsonb,
 snippets jsonb not null default '[]'::jsonb,
 gift_until timestamptz,
 stripe_customer_id text unique,
 stripe_subscription_id text unique,
 subscription_status text,
 paid_until timestamptz,
 billing_event_at bigint not null default 0,
 created_at timestamptz not null default now()
);
create table if not exists public.mockingbird_gift_codes (
 id uuid primary key default gen_random_uuid(), code_hash text unique not null,
 label text not null, duration_days int not null check(duration_days between 1 and 3650),
 max_uses int not null check(max_uses between 1 and 10000), uses int not null default 0,
 expires_at timestamptz not null, revoked_at timestamptz, created_by text not null,
 created_at timestamptz not null default now()
);
create table if not exists public.mockingbird_redemptions (
 code_id uuid references public.mockingbird_gift_codes(id), user_id text references public.mockingbird_accounts(user_id),
 redeemed_at timestamptz not null default now(), primary key(code_id,user_id)
);
create table if not exists public.mockingbird_devices (
 id uuid primary key default gen_random_uuid(), user_id text not null references public.mockingbird_accounts(user_id),
 token_hash text unique not null, name text not null, expires_at timestamptz not null,
 revoked_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.mockingbird_pairings (
 code_hash text primary key, user_id text not null references public.mockingbird_accounts(user_id),
 expires_at timestamptz not null
);
create table if not exists public.mockingbird_quotas (
 user_id text not null, bucket text not null, day date not null default (now() at time zone 'utc')::date,
 used int not null default 0, primary key(user_id,bucket,day)
);
create index if not exists mockingbird_devices_user_idx on public.mockingbird_devices(user_id);
create index if not exists mockingbird_redemptions_user_idx on public.mockingbird_redemptions(user_id);
create index if not exists mockingbird_pairings_user_idx on public.mockingbird_pairings(user_id);
-- No transcript columns: usage accounting does not require the user's words.
alter table public.mockingbird_accounts enable row level security;
alter table public.mockingbird_gift_codes enable row level security;
alter table public.mockingbird_redemptions enable row level security;
alter table public.mockingbird_devices enable row level security;
alter table public.mockingbird_pairings enable row level security;
alter table public.mockingbird_quotas enable row level security;
revoke all on public.mockingbird_accounts, public.mockingbird_gift_codes, public.mockingbird_redemptions, public.mockingbird_devices, public.mockingbird_pairings, public.mockingbird_quotas from public, anon, authenticated;
grant all on public.mockingbird_accounts, public.mockingbird_gift_codes, public.mockingbird_redemptions, public.mockingbird_devices, public.mockingbird_pairings, public.mockingbird_quotas to service_role;

create or replace function public.mockingbird_take_quota(p_user text,p_bucket text,p_limit int) returns boolean language plpgsql security invoker set search_path='' as $$
declare n int;
begin
 insert into public.mockingbird_quotas(user_id,bucket,used) values(p_user,p_bucket,1)
 on conflict(user_id,bucket,day) do update set used=public.mockingbird_quotas.used+1
 where public.mockingbird_quotas.used<p_limit returning used into n;
 return n is not null;
end; $$;
create or replace function public.mockingbird_redeem(p_user text,p_hash text) returns timestamptz language plpgsql security invoker set search_path='' as $$
declare c public.mockingbird_gift_codes; until_at timestamptz;
begin
 select * into c from public.mockingbird_gift_codes where code_hash=p_hash for update;
 if c.id is null or c.revoked_at is not null or c.expires_at<=now() then raise exception 'Code is invalid or expired'; end if;
 select gift_until into until_at from public.mockingbird_accounts where user_id=p_user for update;
 if not found then raise exception 'Account required'; end if;
 if exists(select 1 from public.mockingbird_redemptions where code_id=c.id and user_id=p_user) then return until_at; end if;
 if c.uses>=c.max_uses then raise exception 'This code has been fully claimed'; end if;
 -- Codes extend to at least this date; repeated gifts cannot accumulate years by cycling codes.
 until_at:=greatest(coalesce(until_at,now()),now()+make_interval(days=>c.duration_days));
 insert into public.mockingbird_redemptions(code_id,user_id) values(c.id,p_user);
 update public.mockingbird_gift_codes set uses=uses+1 where id=c.id;
 update public.mockingbird_accounts set gift_until=until_at where user_id=p_user;
 return until_at;
end; $$;
create or replace function public.mockingbird_pair(p_hash text,p_token_hash text,p_name text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare u text; d public.mockingbird_devices;
begin
 delete from public.mockingbird_pairings where code_hash=p_hash and expires_at>now() returning user_id into u;
 if u is null then raise exception 'Code is invalid or expired'; end if;
 insert into public.mockingbird_devices(user_id,token_hash,name,expires_at) values(u,p_token_hash,left(p_name,80),now()+interval '30 days') returning * into d;
 return jsonb_build_object('userId',u,'deviceId',d.id,'expiresAt',d.expires_at);
end; $$;
revoke all on function public.mockingbird_take_quota(text,text,int), public.mockingbird_redeem(text,text), public.mockingbird_pair(text,text,text) from public,anon,authenticated;
grant execute on function public.mockingbird_take_quota(text,text,int), public.mockingbird_redeem(text,text), public.mockingbird_pair(text,text,text) to service_role;
commit;
