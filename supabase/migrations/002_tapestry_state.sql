-- Durable tapestry state (source of truth; pod disk is only a cache).
create table if not exists public.tapestry_state (
  id text primary key default 'live',
  strip_index int not null default 0,
  data jsonb not null,
  canvas_path text,
  updated_at timestamptz not null default now()
);
create table if not exists public.strips (
  session text not null default 'live',
  idx int not null,
  width int not null,
  height int not null,
  overlap int not null,
  prompt text,
  path text not null,
  created_at timestamptz not null default now(),
  primary key (session, idx)
);
alter table public.tapestry_state enable row level security;
alter table public.strips enable row level security;
-- service role only (no client policies)
