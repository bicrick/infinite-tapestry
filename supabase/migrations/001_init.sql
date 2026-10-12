-- Infinite Tapestry: crowd queue, chat, fuel, moderation, audit.
-- Writes go through SECURITY DEFINER RPCs that enforce auth, sanctions and rate limits.

create extension if not exists pgcrypto;

-- ---------- core tables ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  handle text unique check (handle ~ '^[A-Za-z0-9_]{2,20}$'),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.ideas (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  handle text not null,
  body text not null check (char_length(body) between 2 and 300),
  status text not null default 'pending' check (status in ('pending','playing','played','rejected','withdrawn')),
  votes int not null default 0,
  boost_cents int not null default 0,
  plan jsonb,
  created_at timestamptz not null default now(),
  played_at timestamptz
);
create index if not exists ideas_pending on public.ideas (status, boost_cents desc, votes desc, created_at);

create table if not exists public.votes (
  idea_id bigint references public.ideas on delete cascade,
  user_id uuid references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (idea_id, user_id)
);

create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  handle text not null,
  body text not null check (char_length(body) between 1 and 280),
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists chat_recent on public.chat_messages (created_at desc);

create table if not exists public.donations (
  id bigint generated always as identity primary key,
  stripe_session_id text unique not null,
  user_id uuid references auth.users on delete set null,
  handle text,
  amount_cents int not null check (amount_cents > 0),
  kind text not null default 'fuel' check (kind in ('fuel','boost')),
  idea_id bigint references public.ideas on delete set null,
  message text check (message is null or char_length(message) <= 140),
  created_at timestamptz not null default now()
);

create table if not exists public.fuel_ledger (
  id bigint generated always as identity primary key,
  delta_cents numeric(12,4) not null,
  reason text not null,          -- donation | gpu_burn | claude_burn | admin_grant
  ref text,
  created_at timestamptz not null default now()
);

create table if not exists public.sanctions (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete cascade,
  ip_hash text,
  kind text not null check (kind in ('ban','mute')),
  until timestamptz,             -- null = permanent
  reason text,
  by_user uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.rate_events (
  id bigint generated always as identity primary key,
  subject text not null,         -- 'u:<uuid>' or 'ip:<hash>'
  action text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_events_lookup on public.rate_events (subject, action, created_at desc);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_handle text,
  ip_hash text,
  action text not null,
  target text,
  detail jsonb
);
create index if not exists audit_at on public.audit_log (at desc);

create table if not exists public.pod_state (
  id int primary key default 1 check (id = 1),
  status text not null default 'unknown',
  desired text not null default 'auto',
  updated_at timestamptz not null default now(),
  note text
);
insert into public.pod_state (id) values (1) on conflict do nothing;

-- Append-only audit log.
create or replace function public.audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only'; end $$;
drop trigger if exists audit_no_update on public.audit_log;
create trigger audit_no_update before update or delete on public.audit_log
  for each row execute function public.audit_immutable();

-- ---------- helpers ----------
create or replace function public.req_ip_hash() returns text language sql stable as $$
  select encode(extensions.digest(coalesce(
    split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for',''), ',', 1),
    'unknown') || ':it-salt-v1', 'sha256'), 'hex')
$$;

create or replace function public.my_handle() returns text language sql stable security definer set search_path = public as $$
  select handle from public.profiles where id = auth.uid()
$$;

create or replace function public.audit(p_action text, p_target text, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (actor, actor_handle, ip_hash, action, target, detail)
  values (auth.uid(), public.my_handle(), public.req_ip_hash(), p_action, p_target, p_detail)
$$;

create or replace function public.is_sanctioned(p_kind text) returns timestamptz
language sql stable security definer set search_path = public as $$
  -- returns the latest 'until' (or 'infinity') of an active sanction, null if none
  select max(coalesce(until, 'infinity'::timestamptz)) from public.sanctions
  where (user_id = auth.uid() or ip_hash = public.req_ip_hash())
    and (kind = 'ban' or kind = p_kind)
    and (until is null or until > now())
$$;

-- Sliding-window limiter with progressive auto-mute for floods.
-- Raises 'rate_limited:<seconds>' when over limit.
create or replace function public.rate_check(p_action text, p_limit int, p_window interval,
  p_flood int default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  subj_u text := 'u:' || coalesce(auth.uid()::text, 'anon');
  subj_ip text := 'ip:' || public.req_ip_hash();
  n_u int; n_ip int; prior int; mute_for interval;
begin
  select count(*) into n_u from rate_events where subject = subj_u and action = p_action and created_at > now() - p_window;
  select count(*) into n_ip from rate_events where subject = subj_ip and action = p_action and created_at > now() - p_window;
  insert into rate_events (subject, action) values (subj_u, p_action), (subj_ip, p_action);
  if p_flood is not null and greatest(n_u, n_ip) >= p_flood then
    select count(*) into prior from sanctions where user_id = auth.uid() and kind = 'mute' and created_at > now() - interval '24 hours';
    mute_for := least(interval '24 hours', interval '5 minutes' * power(2, prior));
    insert into sanctions (user_id, ip_hash, kind, until, reason) values (auth.uid(), public.req_ip_hash(), 'mute', now() + mute_for, 'auto: flooding ' || p_action);
    perform public.audit('auto_mute', p_action, jsonb_build_object('minutes', extract(epoch from mute_for)/60));
    raise exception 'muted:%', extract(epoch from mute_for)::int;
  end if;
  if greatest(n_u, n_ip) >= p_limit then
    raise exception 'rate_limited:%', extract(epoch from p_window)::int;
  end if;
end $$;

create or replace function public.require_user(p_kind text) returns void
language plpgsql stable security definer set search_path = public as $$
declare s timestamptz;
begin
  if auth.uid() is null then raise exception 'login_required'; end if;
  if public.my_handle() is null then raise exception 'handle_required'; end if;
  s := public.is_sanctioned(p_kind);
  if s is not null then raise exception 'sanctioned:%', case when s = 'infinity' then 'permanent' else s::text end; end if;
end $$;

create or replace function public.is_sexual(t text) returns boolean language sql immutable as $$
  select t ~* '\m(sex|sexy|sexual|nude|nudes|naked|nudity|erotic|erotica|porn|porno|nsfw|topless|lingerie|genitals?|penis|vagina|nipples?|orgasm|seductive|sensual|fetish|bdsm|lewd|hentai|undress\w*|stripper|striptease|intercourse|masturbat\w*|boobs?|tits|breasts|xxx|horny|kinky)\M'
$$;

-- ---------- user RPCs ----------
create or replace function public.set_handle(p_handle text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login_required'; end if;
  perform public.rate_check('set_handle', 5, interval '1 hour');
  insert into profiles (id, handle) values (auth.uid(), p_handle)
    on conflict (id) do update set handle = excluded.handle;
  perform public.audit('set_handle', p_handle);
  return p_handle;
exception when unique_violation then raise exception 'handle_taken';
end $$;

create or replace function public.submit_idea(p_body text) returns bigint
language plpgsql security definer set search_path = public as $$
declare new_id bigint; b text := btrim(p_body);
begin
  perform public.require_user('mute');
  if char_length(b) < 2 or char_length(b) > 300 then raise exception 'bad_length'; end if;
  if public.is_sexual(b) then
    perform public.audit('idea_rejected_sexual', null, jsonb_build_object('body', left(b, 120)));
    raise exception 'content_not_allowed';
  end if;
  if exists (select 1 from ideas where user_id = auth.uid() and status = 'pending') then
    raise exception 'one_active_idea';
  end if;
  perform public.rate_check('submit_idea', 3, interval '10 minutes', 8);
  if exists (select 1 from ideas where user_id = auth.uid() and created_at > now() - interval '60 seconds') then
    raise exception 'cooldown:60';
  end if;
  insert into ideas (user_id, handle, body) values (auth.uid(), public.my_handle(), b) returning id into new_id;
  perform public.audit('submit_idea', new_id::text, jsonb_build_object('body', b));
  return new_id;
end $$;

create or replace function public.withdraw_idea(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  update ideas set status = 'withdrawn' where id = p_id and user_id = auth.uid() and status = 'pending';
  perform public.audit('withdraw_idea', p_id::text);
end $$;

create or replace function public.toggle_vote(p_idea bigint) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
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
  update ideas set votes = (select count(*) from votes where idea_id = p_idea) where id = p_idea returning votes into n;
  return n;
end $$;

create or replace function public.send_chat(p_body text) returns bigint
language plpgsql security definer set search_path = public as $$
declare new_id bigint; b text := btrim(p_body);
begin
  perform public.require_user('mute');
  if char_length(b) < 1 or char_length(b) > 280 then raise exception 'bad_length'; end if;
  perform public.rate_check('chat', 5, interval '30 seconds', 15);
  insert into chat_messages (user_id, handle, body) values (auth.uid(), public.my_handle(), b) returning id into new_id;
  perform public.audit('chat', new_id::text, jsonb_build_object('body', left(b, 280)));
  return new_id;
end $$;

-- ---------- admin RPCs ----------
create or replace function public.require_admin() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce((select is_admin from profiles where id = auth.uid()), false) then raise exception 'admin_only'; end if;
end $$;

create or replace function public.admin_sanction(p_user uuid, p_kind text, p_minutes int, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  insert into sanctions (user_id, kind, until, reason, by_user)
    values (p_user, p_kind, case when p_minutes is null or p_minutes <= 0 then null else now() + make_interval(mins => p_minutes) end, p_reason, auth.uid());
  if p_kind = 'ban' then
    update chat_messages set hidden = true where user_id = p_user;
    update ideas set status = 'rejected' where user_id = p_user and status = 'pending';
  end if;
  perform public.audit('admin_' || p_kind, p_user::text, jsonb_build_object('minutes', p_minutes, 'reason', p_reason));
end $$;

create or replace function public.admin_lift(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  update sanctions set until = now() where user_id = p_user and (until is null or until > now());
  perform public.audit('admin_lift', p_user::text);
end $$;

create or replace function public.admin_hide_chat(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  update chat_messages set hidden = true where id = p_id;
  perform public.audit('admin_hide_chat', p_id::text);
end $$;

create or replace function public.admin_reject_idea(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  update ideas set status = 'rejected' where id = p_id;
  perform public.audit('admin_reject_idea', p_id::text);
end $$;

create or replace function public.admin_audit(p_limit int default 200, p_action text default null)
returns setof public.audit_log language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  return query select * from audit_log where p_action is null or action = p_action order by at desc limit least(p_limit, 1000);
end $$;

-- ---------- public read views ----------
create or replace view public.fuel_status with (security_invoker = false) as
  select coalesce(sum(delta_cents), 0)::numeric(12,2) as balance_cents,
         (select status from pod_state where id = 1) as pod_status
  from public.fuel_ledger;

create or replace view public.donor_wall with (security_invoker = false) as
  select coalesce(handle, 'anonymous') as handle, sum(amount_cents) as total_cents, max(created_at) as last_at,
         (array_agg(message order by created_at desc) filter (where message is not null))[1] as message
  from public.donations group by coalesce(handle, 'anonymous') order by total_cents desc limit 50;

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.ideas enable row level security;
alter table public.votes enable row level security;
alter table public.chat_messages enable row level security;
alter table public.donations enable row level security;
alter table public.fuel_ledger enable row level security;
alter table public.sanctions enable row level security;
alter table public.rate_events enable row level security;
alter table public.audit_log enable row level security;
alter table public.pod_state enable row level security;

drop policy if exists "read handles" on public.profiles;
create policy "read handles" on public.profiles for select using (true);
drop policy if exists "read ideas" on public.ideas;
create policy "read ideas" on public.ideas for select using (status in ('pending','playing','played'));
drop policy if exists "read own votes" on public.votes;
create policy "read own votes" on public.votes for select using (user_id = auth.uid());
drop policy if exists "read chat" on public.chat_messages;
create policy "read chat" on public.chat_messages for select using (not hidden);
drop policy if exists "read pod" on public.pod_state;
create policy "read pod" on public.pod_state for select using (true);
-- donations/fuel/sanctions/rate_events/audit_log: no direct client access (views/RPCs only).

revoke all on public.audit_log from anon, authenticated;
grant select on public.fuel_status, public.donor_wall to anon, authenticated;
revoke execute on function public.admin_audit(int, text) from anon;
revoke execute on function public.rate_check(text, int, interval, int) from anon, authenticated;
revoke execute on function public.audit(text, text, jsonb) from anon, authenticated;

-- Realtime
do $$ begin
  begin alter publication supabase_realtime add table public.ideas; exception when others then null; end;
  begin alter publication supabase_realtime add table public.chat_messages; exception when others then null; end;
  begin alter publication supabase_realtime add table public.pod_state; exception when others then null; end;
end $$;
