-- Guest ideas: anyone can enqueue (no sign-in), with layered limits, a global brake,
-- bans, shadow-mute, and a kill switch. Guests only reach the DB through the Vercel
-- function (/api/idea), which holds the service role; these RPCs are not callable by anon.

-- ---------- limits (editable without code) ----------
alter table public.idea_limits
  add column if not exists guests_enabled boolean not null default true,      -- kill switch: false = sign-in only
  add column if not exists guest_per_10min int not null default 3,
  add column if not exists guest_max_pending int not null default 2,
  add column if not exists ip_per_10min int not null default 9,               -- ~3x guest
  add column if not exists ip_max_pending int not null default 6,
  add column if not exists brake_pending int not null default 12,             -- queue length that tightens guests
  add column if not exists turnstile_required boolean not null default false, -- only enforced when keys exist
  add column if not exists shadow_after_strikes int not null default 2;

-- ---------- guest sessions ----------
create table if not exists public.guest_sessions (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique check (handle ~ '^[a-z]+-[0-9]{4}$'),
  fp_hash text,
  ip_hash text,
  strikes int not null default 0,
  shadow boolean not null default false,
  banned boolean not null default false,
  human_ok boolean not null default false,     -- passed Turnstile once
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists guest_sessions_fp on public.guest_sessions (fp_hash);
alter table public.guest_sessions enable row level security;   -- no policies: service role only

create table if not exists public.guest_bans (
  kind text not null check (kind in ('ip', 'fp', 'session')),
  value text not null,
  reason text,
  created_at timestamptz not null default now(),
  primary key (kind, value)
);
alter table public.guest_bans enable row level security;

-- Shadow-muted submissions: the submitter sees them as submitted, they are never painted.
create table if not exists public.shadow_ideas (
  id bigint generated always as identity primary key,
  guest_id uuid references public.guest_sessions on delete set null,
  user_id uuid references auth.users on delete set null,
  handle text,
  body text not null,
  ip_hash text,
  fp_hash text,
  reason text,
  created_at timestamptz not null default now()
);
alter table public.shadow_ideas enable row level security;

-- ---------- ideas can belong to a guest ----------
alter table public.ideas alter column user_id drop not null;
alter table public.ideas
  add column if not exists guest_id uuid references public.guest_sessions on delete set null,
  add column if not exists ip_hash text,
  add column if not exists fp_hash text;
create index if not exists ideas_guest on public.ideas (guest_id, created_at);
create index if not exists ideas_iphash on public.ideas (ip_hash, created_at);
create index if not exists ideas_fphash on public.ideas (fp_hash, created_at);
do $$ begin
  alter table public.ideas add constraint ideas_owner check (user_id is not null or guest_id is not null);
exception when duplicate_object then null; end $$;

-- Minors + sexual content: never paint either; the combination is an instant shadow.
create or replace function public.is_minor_ref(t text) returns boolean language sql immutable as $$
  select t ~* '\m(child|children|kid|kids|minor|minors|underage|under-age|teen|teens|teenage|teenager|preteen|pre-teen|toddler|baby|babies|infant|schoolgirl|schoolboy|loli|lolita|shota|jailbait|young girl|young boy|little girl|little boy|\d{1,2}\s*(yo|y/o|year[- ]old))\M'
$$;

-- ---------- guest session upsert: limits survive a cookie clear via the fingerprint ----------
create or replace function public.guest_session(p_id uuid, p_fp text, p_ip text)
returns table (id uuid, handle text, banned boolean)
language plpgsql security definer set search_path = public as $$
declare g guest_sessions; words text[] := array['wanderer','drifter','dreamer','weaver','stargazer','pilgrim','nomad','voyager','seeker','lantern','comet','harbor','meadow','ember','tide'];
  h text; tries int := 0;
begin
  if p_id is not null then select * into g from guest_sessions s where s.id = p_id; end if;
  if g.id is null and p_fp is not null then
    select * into g from guest_sessions s where s.fp_hash = p_fp and s.created_at > now() - interval '30 days'
      order by s.last_seen desc limit 1;
  end if;
  if g.id is null then
    loop
      h := words[1 + floor(random() * array_length(words, 1))::int] || '-' || lpad(floor(random() * 10000)::int::text, 4, '0');
      begin
        insert into guest_sessions (handle, fp_hash, ip_hash) values (h, p_fp, p_ip) returning * into g;
        exit;
      exception when unique_violation then tries := tries + 1; if tries > 8 then raise; end if;
      end;
    end loop;
  else
    update guest_sessions s set last_seen = now(), ip_hash = coalesce(p_ip, s.ip_hash), fp_hash = coalesce(s.fp_hash, p_fp)
      where s.id = g.id returning * into g;
  end if;
  return query select g.id, g.handle,
    g.banned or exists (select 1 from guest_bans b where (b.kind = 'ip' and b.value = p_ip) or (b.kind = 'fp' and b.value = p_fp) or (b.kind = 'session' and b.value = g.id::text));
end $$;

-- ---------- guest submit ----------
-- p_flagged: the Vercel layer's moderation verdict ('' = clean, else a reason).
create or replace function public.guest_submit_idea(p_guest uuid, p_ip text, p_fp text, p_body text, p_flagged text default '', p_human boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guest_sessions; lim idea_limits; b text := btrim(p_body); pend int; brake boolean;
  g_lim int; g_pend int; ip_lim int; n int; new_id bigint; bad text := nullif(p_flagged, '');
begin
  select * into lim from idea_limits where id = 1;
  if not coalesce(lim.guests_enabled, true) then raise exception 'signin_required'; end if;
  select * into g from guest_sessions where id = p_guest for update;
  if g.id is null then raise exception 'no_session'; end if;
  if g.banned or exists (select 1 from guest_bans x where (x.kind = 'ip' and x.value = p_ip) or (x.kind = 'fp' and x.value = p_fp) or (x.kind = 'session' and x.value = g.id::text)) then
    raise exception 'not_allowed';
  end if;
  if lim.turnstile_required and not (g.human_ok or p_human) then raise exception 'human_check'; end if;
  if p_human and not g.human_ok then update guest_sessions set human_ok = true where id = g.id; end if;
  if char_length(b) < 2 or char_length(b) > 300 then raise exception 'bad_length'; end if;

  -- moderation: sexual content and minors are never painted; repeat offenders get shadow-muted
  if bad is null and public.is_sexual(b) then bad := 'sexual'; end if;
  if public.is_minor_ref(b) and (bad is not null or public.is_sexual(b)) then bad := 'minor_sexual'; end if;
  if bad is not null then
    update guest_sessions set strikes = strikes + case when bad = 'minor_sexual' then 99 else 1 end,
      shadow = shadow or strikes + 1 >= coalesce(lim.shadow_after_strikes, 2) or bad = 'minor_sexual'
      where id = g.id returning * into g;
    perform public.audit('guest_idea_rejected', g.id::text, jsonb_build_object('reason', bad, 'body', left(b, 120), 'handle', g.handle));
    if not g.shadow then return jsonb_build_object('error', 'content_not_allowed'); end if;   -- return (not raise) so the strike sticks
  end if;

  -- global brake: a long queue tightens guest limits
  select count(*) into pend from ideas where status = 'pending';
  brake := pend >= coalesce(lim.brake_pending, 12);
  g_lim := case when brake then greatest(1, lim.guest_per_10min / 3) else lim.guest_per_10min end;
  g_pend := case when brake then 1 else lim.guest_max_pending end;
  ip_lim := case when brake then greatest(2, lim.ip_per_10min / 2) else lim.ip_per_10min end;

  -- layered limits: session OR same fingerprint (survives a cookie clear), then the IP
  select count(*) into n from (
    select 1 from ideas i where (i.guest_id = g.id or (p_fp is not null and i.fp_hash = p_fp)) and i.created_at > now() - interval '10 minutes'
    union all select 1 from shadow_ideas s where (s.guest_id = g.id or (p_fp is not null and s.fp_hash = p_fp)) and s.created_at > now() - interval '10 minutes') q;
  if n >= g_lim then raise exception 'rate_limited'; end if;
  if (select count(*) from ideas i where (i.guest_id = g.id or (p_fp is not null and i.fp_hash = p_fp)) and i.status = 'pending') >= g_pend then
    raise exception 'too_many_pending';
  end if;
  if p_ip is not null then
    if (select count(*) from ideas i where i.ip_hash = p_ip and i.guest_id is not null and i.created_at > now() - interval '10 minutes') >= ip_lim then raise exception 'rate_limited'; end if;
    if (select count(*) from ideas i where i.ip_hash = p_ip and i.guest_id is not null and i.status = 'pending') >= lim.ip_max_pending then raise exception 'too_many_pending'; end if;
  end if;

  -- shadow-muted (or same-fingerprint as a muted session): accept silently, never paint
  if g.shadow or exists (select 1 from guest_sessions s where s.fp_hash = p_fp and s.shadow) then
    insert into shadow_ideas (guest_id, handle, body, ip_hash, fp_hash, reason) values (g.id, g.handle, b, p_ip, p_fp, coalesce(bad, 'muted')) returning id into new_id;
    return jsonb_build_object('id', -new_id, 'handle', g.handle, 'shadow', true);
  end if;

  -- signed-in ideas get priority under the brake: guest ideas queue behind them (FIFO is by created_at)
  insert into ideas (user_id, guest_id, handle, body, ip_hash, fp_hash, created_at)
    values (null, g.id, g.handle, b, p_ip, p_fp,
            case when brake then now() + least(interval '10 minutes', pend * interval '20 seconds') else now() end)
    returning id into new_id;
  perform public.audit('guest_submit_idea', new_id::text, jsonb_build_object('handle', g.handle, 'body', left(b, 120), 'brake', brake));
  return jsonb_build_object('id', new_id, 'handle', g.handle, 'shadow', false, 'brake', brake);
end $$;

revoke execute on function public.guest_session(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.guest_submit_idea(uuid, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.guest_session(uuid, text, text) to service_role;
grant execute on function public.guest_submit_idea(uuid, text, text, text, text, boolean) to service_role;

-- signed-in path: also refuse minors+sexual combos (is_sexual already blocks sexual)
-- and make signed-in submissions refuse when guests are muted? No: sign-in is an upgrade, never gated.

-- Privacy: hashes/guest ids are never readable by clients (RLS limits rows; this limits columns).
revoke select on public.ideas from anon, authenticated;
grant select (id, user_id, handle, body, status, votes, boost_cents, plan, created_at, played_at,
              start_strip, end_strip, image_path, image_note) on public.ideas to anon, authenticated;
