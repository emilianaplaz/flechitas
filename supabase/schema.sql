-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run.

create table if not exists hazards (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique, -- generated on the phone, makes retried uploads harmless
  type text not null check (type in ('hueco', 'policia', 'alcabala')),
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  heading smallint check (heading between 0 and 360),
  source text check (source in ('tap', 'detected', 'camera')),
  created_at timestamptz not null default now(),
  confirmations int not null default 1,
  last_seen timestamptz not null default now()
);
create index if not exists hazards_pos on hazards (lat, lon);

-- Every "¿Qué fue eso?" answer, including "Nada". Used to tune the detector thresholds.
create table if not exists detections (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  guess text not null check (guess in ('hueco', 'policia')),
  answer text not null check (answer in ('hueco', 'policia', 'none')),
  peak real,
  duration_ms int,
  speed real,
  lat double precision,
  lon double precision,
  heading smallint,
  created_at timestamptz not null default now()
);

-- The app uses the public anon key, so these policies are the only protection:
-- anyone can read hazards and add rows; nobody can edit or delete from the app.
alter table hazards enable row level security;
alter table detections enable row level security;

create policy "anyone reads hazards" on hazards for select to anon using (true);
create policy "anyone adds hazards" on hazards for insert to anon with check (true);
create policy "anyone adds detections" on detections for insert to anon with check (true);

-- Explicit privileges, so this works whether or not "Automatically expose new tables" is ticked.
-- The app can read hazards and add rows to both tables; it cannot update or delete anything.
revoke all on hazards, detections from anon, authenticated;
grant select, insert on hazards to anon;
grant insert on detections to anon;

-- Migration: a detected hit counts half until the driver taps the hole button. Safe to rerun.
alter table hazards add column if not exists confirmed boolean not null default false;
update hazards set confirmed = true where source = 'tap';

-- Accounts: one profile per Supabase Auth user. Safe to rerun.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

-- Runs as the table owner so it can insert for a user who has no privileges on profiles yet.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data->>'display_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users that signed up before this block existed.
insert into public.profiles (id, display_name)
select id, raw_user_meta_data->>'display_name' from auth.users
on conflict (id) do nothing;

alter table profiles enable row level security;

drop policy if exists "users read own profile" on profiles;
drop policy if exists "users update own profile" on profiles;
create policy "users read own profile" on profiles for select to authenticated using (id = (select auth.uid()));
create policy "users update own profile" on profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

revoke all on profiles from anon, authenticated;
grant select, update on profiles to authenticated;
