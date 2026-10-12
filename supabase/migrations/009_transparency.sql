-- Transparency on /about: fuel history, burn rate, "alive for X days" streak.
-- Public read is aggregated numbers only (no handles, no ids, no refs).

create table if not exists public.fuel_snapshots (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  balance_cents numeric(12,2) not null,
  burn_cents_per_hour numeric(10,2) not null,
  painting boolean not null,
  pod_status text
);
alter table public.fuel_snapshots enable row level security;

-- Streak = continuous painting. It BREAKS when no GPU burn is recorded for more than 30 minutes
-- (pod stopped, out of fuel, crashed, or redeployed for longer than that). Short restarts don't count.
create table if not exists public.alive_streak (
  id int primary key default 1 check (id = 1),
  started_at timestamptz not null,
  last_seen_at timestamptz not null,
  breaks int not null default 0
);
create table if not exists public.streak_breaks (
  id bigint generated always as identity primary key,
  ended_streak_started_at timestamptz not null,
  went_dark_at timestamptz not null,
  resumed_at timestamptz not null
);
alter table public.alive_streak enable row level security;
alter table public.streak_breaks enable row level security;

-- Seed the streak from real ledger history: first GPU burn after the most recent >30 min gap.
insert into public.alive_streak (id, started_at, last_seen_at)
select 1, coalesce((select t from (select created_at t, lag(created_at) over (order by created_at) p
                                   from public.fuel_ledger where reason = 'gpu_burn') g
                    where p is null or t - p > interval '30 minutes' order by t desc limit 1), now()),
       coalesce((select max(created_at) from public.fuel_ledger where reason = 'gpu_burn'), now())
on conflict (id) do nothing;

create or replace function public.record_transparency() returns void
language plpgsql security definer set search_path = public as $$
declare bal numeric; burn numeric; last_burn timestamptz; s alive_streak;
begin
  select coalesce(sum(delta_cents), 0) into bal from fuel_ledger;
  select coalesce(-sum(delta_cents), 0) into burn from fuel_ledger
    where reason in ('gpu_burn', 'claude_burn') and created_at > now() - interval '60 minutes';
  select max(created_at) into last_burn from fuel_ledger where reason = 'gpu_burn';
  insert into fuel_snapshots (balance_cents, burn_cents_per_hour, painting, pod_status)
    values (bal, burn, last_burn > now() - interval '15 minutes', (select status from pod_state where id = 1));
  select * into s from alive_streak where id = 1 for update;
  if last_burn is not null and last_burn > s.last_seen_at then
    if last_burn - s.last_seen_at > interval '30 minutes' then
      insert into streak_breaks (ended_streak_started_at, went_dark_at, resumed_at) values (s.started_at, s.last_seen_at, last_burn);
      update alive_streak set started_at = last_burn, last_seen_at = last_burn, breaks = breaks + 1 where id = 1;
    else
      update alive_streak set last_seen_at = last_burn where id = 1;
    end if;
  end if;
end $$;
revoke all on function public.record_transparency() from public, anon, authenticated;

select cron.unschedule('tapestry-transparency') where exists (select 1 from cron.job where jobname = 'tapestry-transparency');
select cron.schedule('tapestry-transparency', '*/5 * * * *', 'select public.record_transparency()');

-- Public aggregate: hourly balance/burn series from the ledger (last 14 days), donation top-ups per hour,
-- current burn rate, and the streak. Amounts only.
create or replace function public.transparency() returns jsonb
language sql stable security definer set search_path = public as $$
  with h as (
    select date_trunc('hour', created_at) hr,
           sum(delta_cents) d,
           coalesce(-sum(delta_cents) filter (where reason in ('gpu_burn', 'claude_burn')), 0) burn,
           coalesce(sum(delta_cents) filter (where reason = 'donation'), 0) don,
           coalesce(sum(delta_cents) filter (where reason = 'admin_grant'), 0) grnt
    from fuel_ledger group by 1),
  c as (select hr, sum(d) over (order by hr) bal, burn, don, grnt from h)
  select jsonb_build_object(
    'now', now(),
    'balance_cents', (select round(coalesce(sum(delta_cents), 0), 2) from fuel_ledger),
    'burn_cents_per_hour', (select round(coalesce(-sum(delta_cents), 0), 2) from fuel_ledger
                            where reason in ('gpu_burn', 'claude_burn') and created_at > now() - interval '60 minutes'),
    'painting', coalesce((select max(created_at) > now() - interval '15 minutes' from fuel_ledger where reason = 'gpu_burn'), false),
    'streak', (select jsonb_build_object('started_at', started_at, 'last_seen_at', last_seen_at, 'breaks', breaks,
                      'rule', 'Breaks if the GPU stops painting for more than 30 minutes') from alive_streak where id = 1),
    'series', coalesce((select jsonb_agg(jsonb_build_object('t', hr, 'bal', round(bal, 2), 'burn', round(burn, 2), 'donated', round(don, 2), 'granted', round(grnt, 2)) order by hr)
                        from c where hr > now() - interval '14 days'), '[]'::jsonb),
    'snapshots', (select count(*) from fuel_snapshots));
$$;
revoke all on function public.transparency() from public;
grant execute on function public.transparency() to anon, authenticated;
