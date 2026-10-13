-- Reliability log: pod heartbeat + events (restarts, generation stalls, upstream errors) and sampled,
-- anonymous viewer events (stream disconnect/reconnect, time away from live, reload reason).
-- Service role only (RLS on, no policies). Viewer rows carry a random per-tab id, never IP or user.
create table if not exists public.ops_events (
  id bigserial primary key,
  source text not null check (source in ('pod', 'viewer', 'watchdog')),
  type text not null,
  started_at timestamptz not null default now(),
  duration_ms integer,
  detail jsonb not null default '{}'::jsonb,
  sid text,
  created_at timestamptz not null default now()
);
create index if not exists ops_events_started on public.ops_events (started_at desc);
create index if not exists ops_events_src_type on public.ops_events (source, type, started_at desc);
alter table public.ops_events enable row level security;

create table if not exists public.ops_heartbeat (
  id text primary key,
  at timestamptz not null default now(),
  started_at timestamptz,
  strip_index integer,
  detail jsonb not null default '{}'::jsonb
);
alter table public.ops_heartbeat enable row level security;

-- Admin stats: buckets (hour or day) of pod drops and viewer disconnects, mean time to reconnect,
-- and the longest gap between published strips over the window.
create or replace function public.ops_stats(hours integer default 24, bucket text default 'hour')
returns jsonb language sql stable security definer set search_path = public as $$
  with w as (select now() - make_interval(hours => greatest(1, least(hours, 24 * 31))) as since),
  ev as (select e.* from ops_events e, w where e.started_at >= w.since),
  b as (
    select date_trunc(case when bucket = 'day' then 'day' else 'hour' end, started_at at time zone 'America/Chicago') as t,
      count(*) filter (where source = 'pod' and type in ('restart', 'stall')) as pod_drops,
      count(*) filter (where source = 'viewer' and type = 'disconnect') as viewer_drops,
      count(*) filter (where source = 'viewer' and type = 'reload') as reloads,
      round(avg(duration_ms) filter (where source = 'viewer' and type = 'reconnect')) as mttr_ms
    from ev group by 1),
  g as (
    select s.created_at, extract(epoch from s.created_at - lag(s.created_at) over (order by s.idx)) as gap
    from strips s, w where s.session = 'live-sdxl' and s.created_at >= w.since)
  select jsonb_build_object(
    'buckets', coalesce((select jsonb_agg(jsonb_build_object('t', to_char(t, 'YYYY-MM-DD HH24:00'), 'pod_drops', pod_drops,
      'viewer_drops', viewer_drops, 'reloads', reloads, 'mttr_ms', mttr_ms) order by t) from b), '[]'::jsonb),
    'pod_drops', (select count(*) from ev where source = 'pod' and type in ('restart', 'stall')),
    'viewer_drops', (select count(*) from ev where source = 'viewer' and type = 'disconnect'),
    'mttr_ms', (select round(avg(duration_ms)) from ev where source = 'viewer' and type = 'reconnect'),
    'away_ms_avg', (select round(avg(duration_ms)) from ev where source = 'viewer' and type = 'away_from_live'),
    'reloads', (select jsonb_object_agg(r, n) from (select coalesce(detail->>'reason', '?') r, count(*) n from ev where source = 'viewer' and type = 'reload' group by 1) x),
    'gaps_over_30s', (select count(*) from g where gap > 30),
    'longest_gap_s', (select round(max(gap)::numeric, 1) from g),
    'longest_gap_at', (select created_at from g where gap is not null order by gap desc limit 1),
    'heartbeat', (select to_jsonb(h) from ops_heartbeat h where id = 'pod'),
    'recent', coalesce((select jsonb_agg(x) from (select source, type, started_at, duration_ms, detail from ev
      where not (source = 'viewer' and type in ('reconnect', 'away_from_live')) order by started_at desc limit 40) x), '[]'::jsonb)
  );
$$;
revoke all on function public.ops_stats(integer, text) from public, anon, authenticated;
