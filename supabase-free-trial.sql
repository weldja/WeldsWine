-- Welds Wine Wisdoms — free trial for visitors (run AFTER supabase-usage-limits.sql)
-- Run this once in: supabase.com → your project → SQL Editor → New query
-- Safe to run again.
--
-- Visitors can try the scanners without an account. Behind the scenes the app
-- signs them in as a Supabase "anonymous" user (Authentication → Sign In /
-- Providers → "Allow anonymous sign-ins" must be ON). When they create an
-- account, that same user becomes a normal member, so their wines are kept.
--
-- What it adds:
--   usage_trial_settings   per feature: how many free uses each trial visitor gets
--                          (in total, not per month), and a daily cap for ALL trial
--                          visitors together, as a safety valve against abuse
--   api_usage.trial        marks calls made during a free trial
--   effective_usage_limit / claim_usage   now handle trial visitors
--
-- How a trial visitor's limit is worked out, for each feature:
--   1. per_user from usage_trial_settings, counted over all time (it never resets)
--   2. AND all trial visitors together may not go over daily_total in 24 hours
-- Once someone creates an account their trial use no longer counts: they get
-- the normal monthly limits from then on.

-- 1. Trial allowance per feature (null = unlimited, 0 = not in the trial)
create table if not exists public.usage_trial_settings (
  feature     text primary key,
  per_user    integer check (per_user is null or per_user >= 0),
  daily_total integer check (daily_total is null or daily_total >= 0)
);
alter table public.usage_trial_settings enable row level security;
-- Starting allowance: 3 label scans, 1 shelf scan, 3 Wine Intel lookups, no deals checks
insert into public.usage_trial_settings (feature, per_user, daily_total) values
  ('label', 3, 300), ('shelf', 1, 50), ('research', 3, 300), ('deals', 0, 0)
on conflict (feature) do nothing;

-- 2. Mark calls made during a trial
alter table public.api_usage add column if not exists trial boolean not null default false;
create index if not exists api_usage_trial_time_idx on public.api_usage (feature, created_at) where trial;

-- Is this a trial (anonymous) visitor?
create or replace function public.is_trial_user(p_user uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select coalesce((select u.is_anonymous from auth.users u where u.id = p_user), false)
$$;

-- 3. The limit that applies to one person for one feature: { "limit": n or null, "source": ... }
create or replace function public.effective_usage_limit(p_user uuid, p_feature text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_limit integer;
  v_admin boolean;
begin
  select monthly_limit into v_limit from usage_limits where user_id = p_user and feature = p_feature;
  if found then return jsonb_build_object('limit', v_limit, 'source', 'user'); end if;
  if is_trial_user(p_user) then
    select per_user into v_limit from usage_trial_settings where feature = p_feature;
    if not found then v_limit := 0; end if;
    return jsonb_build_object('limit', v_limit, 'source', 'trial');
  end if;
  select coalesce(is_admin, false) into v_admin from profiles where id = p_user;
  if coalesce(v_admin, false) then return jsonb_build_object('limit', null, 'source', 'admin'); end if;
  select monthly_limit into v_limit from usage_limit_defaults where feature = p_feature;
  return jsonb_build_object('limit', v_limit, 'source', 'default');
end $$;

-- 4. Check the limit and, if there's room, record the call as 'pending'.
-- Returns { allowed, id, used, limit, resets_at, trial, reason }
-- reason (when not allowed): 'limit' = this person's limit, 'trial_busy' = the daily trial cap
create or replace function public.claim_usage(p_user uuid, p_feature text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_trial boolean := is_trial_user(p_user);
  v_start timestamptz := usage_month_start();
  v_limit integer;
  v_used  integer;
  v_cap   integer;
  v_today integer;
  v_id    bigint;
  v_reset timestamptz := ((date_trunc('month', now() at time zone 'Europe/London') + interval '1 month') at time zone 'Europe/London');
begin
  -- One claim at a time per person and feature, so two quick taps can't both squeeze in
  perform pg_advisory_xact_lock(hashtext(p_user::text || ':' || p_feature));
  v_limit := (effective_usage_limit(p_user, p_feature) ->> 'limit')::integer;

  if v_trial then
    -- Trial: counted over all time, and never resets
    select count(*) into v_used from api_usage
      where user_id = p_user and feature = p_feature and status <> 'failed';
    if v_limit is not null and v_used >= v_limit then
      return jsonb_build_object('allowed', false, 'used', v_used, 'limit', v_limit, 'resets_at', null, 'trial', true, 'reason', 'limit');
    end if;
    -- Safety valve: all trial visitors together, over the last 24 hours
    perform pg_advisory_xact_lock(hashtext('trial-cap:' || p_feature));
    select daily_total into v_cap from usage_trial_settings where feature = p_feature;
    if v_cap is not null then
      select count(*) into v_today from api_usage
        where trial and feature = p_feature and status <> 'failed' and created_at > now() - interval '24 hours';
      if v_today >= v_cap then
        return jsonb_build_object('allowed', false, 'used', v_used, 'limit', v_limit, 'resets_at', null, 'trial', true, 'reason', 'trial_busy');
      end if;
    end if;
    insert into api_usage (user_id, feature, trial) values (p_user, p_feature, true) returning id into v_id;
    return jsonb_build_object('allowed', true, 'id', v_id, 'used', v_used + 1, 'limit', v_limit, 'resets_at', null, 'trial', true);
  end if;

  -- Members: per calendar month. Anything used during their free trial doesn't count.
  select count(*) into v_used from api_usage
    where user_id = p_user and feature = p_feature and status <> 'failed' and not trial and created_at >= v_start;
  if v_limit is not null and v_used >= v_limit then
    return jsonb_build_object('allowed', false, 'used', v_used, 'limit', v_limit, 'resets_at', v_reset, 'trial', false, 'reason', 'limit');
  end if;
  insert into api_usage (user_id, feature) values (p_user, p_feature) returning id into v_id;
  return jsonb_build_object('allowed', true, 'id', v_id, 'used', v_used + 1, 'limit', v_limit, 'resets_at', v_reset, 'trial', false);
end $$;

-- 5. Who is on a trial, for the admin panel (ids of anonymous users)
create or replace function public.trial_user_ids()
returns setof uuid language sql stable security definer set search_path = public, auth as $$
  select u.id from auth.users u where u.is_anonymous
$$;

-- 6. Tidy-up: delete trial visitors who never created an account, after p_days days.
-- Their wines and cellars go with them. Run by hand (or on a schedule) when you like:
--   select public.delete_old_trial_users(30);
create or replace function public.delete_old_trial_users(p_days integer default 30)
returns integer language plpgsql security definer set search_path = public, auth as $$
declare v_count integer;
begin
  with gone as (
    delete from auth.users u
    where u.is_anonymous and u.created_at < now() - make_interval(days => greatest(p_days, 1))
    returning u.id
  ) select count(*) into v_count from gone;
  return v_count;
end $$;

-- Only the Workers (service key) may call these
revoke all on function public.is_trial_user(uuid) from public, anon, authenticated;
revoke all on function public.effective_usage_limit(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_usage(uuid, text) from public, anon, authenticated;
revoke all on function public.trial_user_ids() from public, anon, authenticated;
revoke all on function public.delete_old_trial_users(integer) from public, anon, authenticated;
grant execute on function public.is_trial_user(uuid) to service_role;
grant execute on function public.effective_usage_limit(uuid, text) to service_role;
grant execute on function public.claim_usage(uuid, text) to service_role;
grant execute on function public.trial_user_ids() to service_role;
grant execute on function public.delete_old_trial_users(integer) to service_role;
