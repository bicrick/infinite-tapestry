-- Generous guest limits + guest hearts.
-- Guests: 6 ideas / 10 min, 4 waiting; under the brake 2 / 10 min (max(2, 6/3)) and 2 waiting.
-- Shared networks scale to 18 / 10 min and 12 waiting. Turnstile + moderation unchanged.
update public.idea_limits set guest_per_10min = 6, guest_max_pending = 4, ip_per_10min = 18, ip_max_pending = 12 where id = 1;
alter table public.idea_limits
  alter column guest_per_10min set default 6, alter column guest_max_pending set default 4,
  alter column ip_per_10min set default 18, alter column ip_max_pending set default 12,
  add column if not exists guest_votes_per_min int not null default 20,     -- per session/fingerprint
  add column if not exists ip_votes_per_min int not null default 60;        -- per network

-- Brake: re-define guest_submit_idea with the softer brake (body otherwise identical to 007).
do $$ declare d text; begin
  d := pg_get_functiondef('public.guest_submit_idea(uuid, text, text, text, text, boolean)'::regprocedure);
  d := replace(d, 'greatest(1, lim.guest_per_10min / 3)', 'greatest(2, lim.guest_per_10min / 3)');
  d := replace(d, 'g_pend := case when brake then 1 else', 'g_pend := case when brake then least(2, lim.guest_max_pending) else');
  if d !~ 'greatest\(2, lim.guest_per_10min / 3\)' or d !~ 'least\(2, lim.guest_max_pending\)' then raise exception 'brake patch did not apply'; end if;
  execute d;
end $$;

-- ---------- guest votes ----------
create table if not exists public.guest_votes (
  idea_id bigint not null references public.ideas on delete cascade,
  guest_id uuid not null references public.guest_sessions on delete cascade,
  ip_hash text,
  fp_hash text,
  created_at timestamptz not null default now(),
  primary key (idea_id, guest_id)
);
-- Same browser fingerprint can't vote twice by clearing cookies.
create unique index if not exists guest_votes_idea_fp on public.guest_votes (idea_id, fp_hash) where fp_hash is not null;
create index if not exists guest_votes_guest on public.guest_votes (guest_id, created_at);
create index if not exists guest_votes_ip on public.guest_votes (ip_hash, created_at);
alter table public.guest_votes enable row level security;   -- no policies: service role only

create table if not exists public.guest_vote_events (       -- rate-limit ledger (toggles included)
  id bigint generated always as identity primary key,
  guest_id uuid, ip_hash text, fp_hash text,
  created_at timestamptz not null default now()
);
create index if not exists guest_vote_events_t on public.guest_vote_events (created_at);
alter table public.guest_vote_events enable row level security;

create or replace function public.recount_votes(p_idea bigint) returns int
language sql security definer set search_path = public as $$
  update ideas set votes = (select count(*) from votes where idea_id = p_idea) + (select count(*) from guest_votes where idea_id = p_idea)
    where id = p_idea returning votes;
$$;
revoke execute on function public.recount_votes(bigint) from public, anon, authenticated;

-- Signed-in toggle: counts include guest hearts.
create or replace function public.toggle_vote(p_idea bigint) returns int
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_user('vote');
  perform public.rate_check('vote', 30, interval '1 minute', 90);
  if exists (select 1 from votes where idea_id = p_idea and user_id = auth.uid()) then
    delete from votes where idea_id = p_idea and user_id = auth.uid();
    perform public.audit('unvote', p_idea::text);
  else
    if not exists (select 1 from ideas where id = p_idea and status = 'pending') then raise exception 'not_votable'; end if;
    insert into votes (idea_id, user_id) values (p_idea, auth.uid());
    perform public.audit('vote', p_idea::text);
  end if;
  return public.recount_votes(p_idea);
end $$;

-- Guest toggle: one heart per guest session (and per fingerprint) per idea. Returns {votes, on}.
create or replace function public.guest_toggle_vote(p_guest uuid, p_ip text, p_fp text, p_idea bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guest_sessions; lim idea_limits; mine guest_votes; n int; on_ boolean;
begin
  select * into lim from idea_limits where id = 1;
  if not coalesce(lim.guests_enabled, true) then raise exception 'signin_required'; end if;
  select * into g from guest_sessions where id = p_guest for update;
  if g.id is null then raise exception 'no_session'; end if;
  if g.banned or exists (select 1 from guest_bans x where (x.kind = 'ip' and x.value = p_ip) or (x.kind = 'fp' and x.value = p_fp) or (x.kind = 'session' and x.value = g.id::text)) then
    raise exception 'not_allowed';
  end if;
  if (select count(*) from guest_vote_events e where (e.guest_id = g.id or (p_fp is not null and e.fp_hash = p_fp)) and e.created_at > now() - interval '1 minute') >= coalesce(lim.guest_votes_per_min, 20)
     or (p_ip is not null and (select count(*) from guest_vote_events e where e.ip_hash = p_ip and e.created_at > now() - interval '1 minute') >= coalesce(lim.ip_votes_per_min, 60)) then
    raise exception 'rate_limited';
  end if;
  -- shadow-muted: looks accepted, never counts
  if g.shadow then return jsonb_build_object('votes', (select votes from ideas where id = p_idea), 'on', true); end if;
  insert into guest_vote_events (guest_id, ip_hash, fp_hash) values (g.id, p_ip, p_fp);
  delete from guest_vote_events where created_at < now() - interval '1 day';

  select * into mine from guest_votes v where v.idea_id = p_idea and (v.guest_id = g.id or (p_fp is not null and v.fp_hash = p_fp)) limit 1;
  if mine.idea_id is not null then
    delete from guest_votes v where v.idea_id = p_idea and (v.guest_id = g.id or (p_fp is not null and v.fp_hash = p_fp));
    on_ := false;
    perform public.audit('guest_unvote', p_idea::text, jsonb_build_object('handle', g.handle));
  else
    if not exists (select 1 from ideas where id = p_idea and status = 'pending') then raise exception 'not_votable'; end if;
    insert into guest_votes (idea_id, guest_id, ip_hash, fp_hash) values (p_idea, g.id, p_ip, p_fp) on conflict do nothing;
    on_ := true;
    perform public.audit('guest_vote', p_idea::text, jsonb_build_object('handle', g.handle));
  end if;
  n := public.recount_votes(p_idea);
  return jsonb_build_object('votes', n, 'on', on_);
end $$;

-- Which ideas this guest has hearted (for the "on" state after a refresh).
create or replace function public.guest_my_votes(p_guest uuid, p_fp text) returns setof bigint
language sql stable security definer set search_path = public as $$
  select distinct v.idea_id from guest_votes v join ideas i on i.id = v.idea_id
  where (v.guest_id = p_guest or (p_fp is not null and v.fp_hash = p_fp)) and i.status in ('pending', 'playing');
$$;

revoke execute on function public.guest_toggle_vote(uuid, text, text, bigint) from public, anon, authenticated;
revoke execute on function public.guest_my_votes(uuid, text) from public, anon, authenticated;
grant execute on function public.guest_toggle_vote(uuid, text, text, bigint) to service_role;
grant execute on function public.guest_my_votes(uuid, text) to service_role;
grant execute on function public.recount_votes(bigint) to service_role;
