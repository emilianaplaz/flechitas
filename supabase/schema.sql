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
