-- Welds Wine Wisdoms — AI usage tracking and per-user limits
-- Run this once in: supabase.com → your project → SQL Editor → New query
-- Safe to run again (it only creates what is missing and replaces the functions).
--
-- What it adds:
--   api_usage             one row for every call the app makes to Claude
--   usage_limit_defaults  the monthly limit everyone gets, per feature
--   usage_limits          your per-person overrides of those defaults
--   claim_usage()         checks a person's limit and records the call (used by the Workers)
--   usage_summary()       totals per person, for the admin panel
--
-- Features: 'label' (label scan), 'shelf' (shelf scanner), 'research' (Wine Intel),
--           'deals' (supermarket deals check, tracked but not limited by default)
--
-- How a person's limit is worked out, for each feature:
--   1. If you've set a limit for that person (a row in usage_limits), that's it.
--      A number is their monthly limit, 0 blocks the feature, and blank (null) is unlimited.
--   2. Otherwise admins are unlimited.
--   3. Otherwise everyone gets the default in usage_limit_defaults (blank = unlimited).
-- Limits are per calendar month (UK time) and reset on the 1st.
-- Calls that fail don't count towards a limit.

-- 1. Every call to Claude
create table if not exists public.api_usage (
  id                 bigserial primary key,
  user_id            uuid references auth.users(id) on delete set null,
  feature            text not null,
  model              text,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0,
  web_searches       integer not null default 0,
  cost_usd           numeric(12,6) not null default 0,
  status             text not null default 'pending',   -- pending → ok or failed
  created_at         timestamptz not null default now()
);
create index if not exists api_usage_user_feature_time_idx on public.api_usage (user_id, feature, created_at);
create index if not exists api_usage_time_idx on public.api_usage (created_at);
-- Only the Workers (service key) read or write this table: no policies on purpose
alter table public.api_usage enable row level security;

-- 2. The default monthly limit for everyone, per feature (null = unlimited)
create table if not exists public.usage_limit_defaults (
  feature       text primary key,
  monthly_limit integer check (monthly_limit is null or monthly_limit >= 0)
);
alter table public.usage_limit_defaults enable row level security;
-- Starting defaults: unlimited, so nothing changes until you set limits
insert into public.usage_limit_defaults (feature, monthly_limit) values
  ('label', null), ('shelf', null), ('research', null), ('deals', null)
on conflict (feature) do nothing;

-- 3. Per-person overrides (null monthly_limit = unlimited for that person)
create table if not exists public.usage_limits (
  user_id       uuid not null references auth.users(id) on delete cascade,
  feature       text not null,
  monthly_limit integer check (monthly_limit is null or monthly_limit >= 0),
  updated_at    timestamptz not null default now(),
  primary key (user_id, feature)
);
alter table public.usage_limits enable row level security;

-- Start of the current month (or n months back), UK time
drop function if exists public.usage_month_start();
create or replace function public.usage_month_start(p_months_back integer default 0)
returns timestamptz language sql stable as $$
  select (date_trunc('month', now() at time zone 'Europe/London') - make_interval(months => p_months_back)) at time zone 'Europe/London'
$$;

-- The limit that applies to one person for one feature: { "limit": n or null, "source": ... }
create or replace function public.effective_usage_limit(p_user uuid, p_feature text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_limit integer;
  v_admin boolean;
begin
  select monthly_limit into v_limit from usage_limits where user_id = p_user and feature = p_feature;
  if found then return jsonb_build_object('limit', v_limit, 'source', 'user'); end if;
  select coalesce(is_admin, false) into v_admin from profiles where id = p_user;
  if coalesce(v_admin, false) then return jsonb_build_object('limit', null, 'source', 'admin'); end if;
  select monthly_limit into v_limit from usage_limit_defaults where feature = p_feature;
  return jsonb_build_object('limit', v_limit, 'source', 'default');
end $$;

-- Check the limit and, if there's room, record the call as 'pending'.
-- Returns { allowed, id, used, limit, resets_at }.
create or replace function public.claim_usage(p_user uuid, p_feature text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_start timestamptz := usage_month_start();
  v_limit integer;
  v_used  integer;
  v_id    bigint;
  v_reset timestamptz := ((date_trunc('month', now() at time zone 'Europe/London') + interval '1 month') at time zone 'Europe/London');
begin
  -- One claim at a time per person and feature, so two quick taps can't both squeeze in
  perform pg_advisory_xact_lock(hashtext(p_user::text || ':' || p_feature));
  v_limit := (effective_usage_limit(p_user, p_feature) ->> 'limit')::integer;
  select count(*) into v_used from api_usage
    where user_id = p_user and feature = p_feature and status <> 'failed' and created_at >= v_start;
  if v_limit is not null and v_used >= v_limit then
    return jsonb_build_object('allowed', false, 'used', v_used, 'limit', v_limit, 'resets_at', v_reset);
  end if;
  insert into api_usage (user_id, feature) values (p_user, p_feature) returning id into v_id;
  return jsonb_build_object('allowed', true, 'id', v_id, 'used', v_used + 1, 'limit', v_limit, 'resets_at', v_reset);
end $$;

-- Totals per person and feature between two times, for the admin panel
create or replace function public.usage_summary(p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, feature text, calls bigint, failed bigint,
               input_tokens bigint, output_tokens bigint, web_searches bigint, cost_usd numeric)
language sql stable security definer set search_path = public as $$
  select u.user_id, u.feature,
         count(*) filter (where u.status <> 'failed'),
         count(*) filter (where u.status = 'failed'),
         coalesce(sum(u.input_tokens + u.cache_read_tokens + u.cache_write_tokens), 0),
         coalesce(sum(u.output_tokens), 0),
         coalesce(sum(u.web_searches), 0),
         coalesce(sum(u.cost_usd), 0)
  from api_usage u
  where u.created_at >= coalesce(p_from, '-infinity'::timestamptz)
    and u.created_at <  coalesce(p_to, 'infinity'::timestamptz)
  group by u.user_id, u.feature
$$;

-- Only the Workers (service key) may call these
revoke all on function public.usage_month_start(integer) from public, anon, authenticated;
grant execute on function public.usage_month_start(integer) to service_role;
revoke all on function public.effective_usage_limit(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_usage(uuid, text) from public, anon, authenticated;
revoke all on function public.usage_summary(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.effective_usage_limit(uuid, text) to service_role;
grant execute on function public.claim_usage(uuid, text) to service_role;
grant execute on function public.usage_summary(timestamptz, timestamptz) to service_role;
