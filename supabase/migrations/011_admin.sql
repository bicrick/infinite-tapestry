-- Admin panel backing tables. Service role only (no client policies); every admin endpoint checks is_admin server-side.

-- Steer Auto without a redeploy: the pod polls this row every ~30 s.
create table if not exists public.auto_config (
  id int primary key default 1 check (id = 1),
  paused boolean not null default false,
  theme text check (theme is null or char_length(theme) <= 200),
  theme_until timestamptz,
  mood_weights jsonb not null default '{}'::jsonb,   -- {"cosmic": 8, "quirky gag": 0, ...}; missing keys keep defaults
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.auto_config (id) values (1) on conflict (id) do nothing;
alter table public.auto_config enable row level security;

-- Reports from scene pages and queue rows.
create table if not exists public.reports (
  id bigint generated always as identity primary key,
  idea_id bigint references public.ideas on delete set null,
  strip_a int, strip_b int,
  reason text not null check (char_length(reason) between 1 and 200),
  reporter_user uuid, ip_hash text,
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  created_at timestamptz not null default now()
);
create index if not exists reports_open on public.reports (status, created_at desc);
create index if not exists reports_ip on public.reports (ip_hash, created_at);
alter table public.reports enable row level security;

-- CI writes one row per web deploy and per worker release (history for the admin Deploys list).
create table if not exists public.deploy_log (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('web','worker','rollback')),
  sha text not null, url text, run_id text, note text,
  created_at timestamptz not null default now()
);
create index if not exists deploy_log_recent on public.deploy_log (created_at desc);
alter table public.deploy_log enable row level security;

-- Usage for the Stats card (database + storage bytes). Service role only.
create or replace function public.admin_usage() returns jsonb
language sql stable security definer set search_path = public, storage as $$
  select jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'storage', coalesce((select jsonb_object_agg(bucket_id, b) from (
       select bucket_id, sum(coalesce((metadata->>'size')::bigint, 0)) b from storage.objects group by 1) q), '{}'::jsonb),
    'strips', (select count(*) from public.strips),
    'ideas_24h', (select count(*) from public.ideas where created_at > now() - interval '24 hours'),
    'ideas_1h', (select count(*) from public.ideas where created_at > now() - interval '1 hour'),
    'ideas_hourly', coalesce((select jsonb_agg(jsonb_build_object('h', h, 'n', n) order by h) from (
       select date_trunc('hour', created_at) h, count(*) n from public.ideas where created_at > now() - interval '24 hours' group by 1) q), '[]'::jsonb),
    'pending', (select count(*) from public.ideas where status = 'pending'),
    'reports_open', (select count(*) from public.reports where status = 'open'));
$$;
revoke execute on function public.admin_usage() from public, anon, authenticated;
grant execute on function public.admin_usage() to service_role;
