-- Welds Wine Wisdoms — Supabase Database Setup
-- Run this in: supabase.com → your project → SQL Editor → New query

-- 1. Create the wines table
create table if not exists public.wines (
  id            text primary key,
  user_id       uuid references auth.users(id) on delete cascade not null,
  name          text not null,
  winery        text,
  vintage       text,
  country       text,
  region        text,
  grape         text,
  style         text,
  price         text,
  purchased_from text,
  date_tasted   text,
  notes         text,
  rating        integer,
  photo_front   text,
  photo_back    text,
  loc_lat       double precision,
  loc_lng       double precision,
  loc_label     text,
  created_at    timestamptz default now()
);

alter table public.wines enable row level security;

create policy "Users can read own wines"   on public.wines for select using (auth.uid() = user_id);
create policy "Users can insert own wines" on public.wines for insert with check (auth.uid() = user_id);
create policy "Users can update own wines" on public.wines for update using (auth.uid() = user_id);
create policy "Users can delete own wines" on public.wines for delete using (auth.uid() = user_id);

create index if not exists wines_user_id_idx on public.wines(user_id);

-- 2. Create the shared_wines table (public read, used for share links)
create table if not exists public.shared_wines (
  id           text primary key,
  wine_id      text,
  user_id      uuid references auth.users(id) on delete cascade,
  name         text not null,
  winery       text,
  vintage      text,
  country      text,
  region       text,
  grape        text,
  style        text,
  rating       integer,
  notes        text,
  photo_front  text,
  loc_label    text,
  date_tasted  text,
  price        text,
  created_at   timestamptz default now()
);

-- Public read (anyone with the share ID can view)
alter table public.shared_wines enable row level security;

create policy "Anyone can read shared wines"
  on public.shared_wines for select
  using (true);

create policy "Users can insert shared wines"
  on public.shared_wines for insert
  with check (auth.uid() = user_id);

create policy "Users can delete own shared wines"
  on public.shared_wines for delete
  using (auth.uid() = user_id);
