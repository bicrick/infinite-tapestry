-- Reactions (per-strip counts), guest chat, moderated handles.

create or replace function public.is_hateful(t text) returns boolean language sql immutable as $$
  select t ~* '\m(n[i1]gg(er|a)s?|f[a@]gg?ots?|k[i1]kes?|sp[i1]cs?|ch[i1]nks?|tr[a@]nn(y|ies)|wetbacks?|r[e3]tards?|heil|hitler|nazis?|kkk)\M'
$$;

-- ---------- reactions ----------
create table if not exists public.strip_reactions (
  strip int primary key,
  lol int not null default 0, fire int not null default 0, mind int not null default 0,
  love int not null default 0, dead int not null default 0,
  title text,
  updated_at timestamptz not null default now()
);
alter table public.strip_reactions enable row level security;
drop policy if exists "read reactions" on public.strip_reactions;
create policy "read reactions" on public.strip_reactions for select using (true);

create or replace function public.add_reactions(p_rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r jsonb; c jsonb;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    c := coalesce(r->'counts', '{}'::jsonb);
    insert into strip_reactions (strip, lol, fire, mind, love, dead, title)
    values ((r->>'strip')::int, coalesce((c->>'lol')::int,0), coalesce((c->>'fire')::int,0), coalesce((c->>'mind')::int,0),
            coalesce((c->>'love')::int,0), coalesce((c->>'dead')::int,0), nullif(r->>'title',''))
    on conflict (strip) do update set lol = strip_reactions.lol + excluded.lol, fire = strip_reactions.fire + excluded.fire,
      mind = strip_reactions.mind + excluded.mind, love = strip_reactions.love + excluded.love, dead = strip_reactions.dead + excluded.dead,
      title = coalesce(excluded.title, strip_reactions.title), updated_at = now();
  end loop;
end $$;
revoke execute on function public.add_reactions(jsonb) from public, anon, authenticated;
grant execute on function public.add_reactions(jsonb) to service_role;

-- per-scene rollup for 'most laughed' and variable scene length
create or replace view public.scene_reactions as
  select title, min(strip) as first_strip, max(strip) as last_strip, sum(lol) lol, sum(fire) fire, sum(mind) mind,
         sum(love) love, sum(dead) dead, sum(lol+fire+mind+love+dead) total, max(updated_at) updated_at
  from public.strip_reactions where title is not null group by title;

-- ---------- guest chat ----------
alter table public.chat_messages alter column user_id drop not null;
alter table public.chat_messages add column if not exists guest_id uuid references public.guest_sessions on delete set null;
alter table public.chat_messages add column if not exists ip_hash text;
create index if not exists chat_guest on public.chat_messages (guest_id, created_at desc);

create or replace function public.guest_send_chat(p_guest uuid, p_ip text, p_fp text, p_body text, p_flagged text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare g guest_sessions; b text := btrim(p_body); bad text := nullif(p_flagged, ''); n int; new_id bigint;
begin
  if not coalesce((select guests_enabled from idea_limits where id = 1), true) then raise exception 'signin_required'; end if;
  select * into g from guest_sessions where id = p_guest for update;
  if g.id is null then raise exception 'no_session'; end if;
  if g.banned or exists (select 1 from guest_bans x where (x.kind = 'ip' and x.value = p_ip) or (x.kind = 'fp' and x.value = p_fp) or (x.kind = 'session' and x.value = g.id::text)) then
    raise exception 'not_allowed';
  end if;
  if char_length(b) < 1 or char_length(b) > 280 then raise exception 'bad_length'; end if;
  if bad is null and (public.is_sexual(b) or public.is_hateful(b)) then bad := 'blocked'; end if;
  if bad is not null then
    update guest_sessions set strikes = strikes + 1, shadow = shadow or strikes + 1 >= 3 where id = g.id returning * into g;
    perform public.audit('guest_chat_rejected', g.id::text, jsonb_build_object('reason', bad, 'body', left(b, 120), 'handle', g.handle));
    return jsonb_build_object('error', 'content_not_allowed');
  end if;
  select count(*) into n from chat_messages where guest_id = g.id and created_at > now() - interval '30 seconds';
  if n >= 4 then raise exception 'rate_limited'; end if;
  if p_ip is not null and (select count(*) from chat_messages where ip_hash = p_ip and created_at > now() - interval '30 seconds') >= 12 then
    raise exception 'rate_limited';
  end if;
  if g.shadow then return jsonb_build_object('id', 0, 'handle', g.handle, 'shadow', true); end if;
  insert into chat_messages (user_id, guest_id, handle, body, ip_hash) values (null, g.id, g.handle, b, p_ip) returning id into new_id;
  perform public.audit('guest_chat', new_id::text, jsonb_build_object('handle', g.handle, 'body', left(b, 280)));
  return jsonb_build_object('id', new_id, 'handle', g.handle);
end $$;
revoke execute on function public.guest_send_chat(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.guest_send_chat(uuid, text, text, text, text) to service_role;

-- signed-in chat gets the same hard blocks
create or replace function public.send_chat(p_body text) returns bigint
language plpgsql security definer set search_path = public as $$
declare new_id bigint; b text := btrim(p_body);
begin
  perform public.require_user('mute');
  if char_length(b) < 1 or char_length(b) > 280 then raise exception 'bad_length'; end if;
  if public.is_sexual(b) or public.is_hateful(b) then raise exception 'content_not_allowed'; end if;
  perform public.rate_check('chat', 5, interval '30 seconds', 15);
  insert into chat_messages (user_id, handle, body) values (auth.uid(), public.my_handle(), b) returning id into new_id;
  perform public.audit('chat', new_id::text, jsonb_build_object('body', left(b, 280)));
  return new_id;
end $$;

-- ---------- moderated, unique handles ----------
create or replace function public.set_handle(p_handle text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login_required'; end if;
  if p_handle !~ '^[A-Za-z0-9_]{2,20}$' then raise exception 'bad_handle'; end if;
  if public.is_sexual(p_handle) or public.is_hateful(p_handle)
     or lower(p_handle) in ('auto','admin','administrator','mod','moderator','system','infinitetapestry','infinite_tapestry','tapestry','staff','support','official')
  then raise exception 'handle_not_allowed'; end if;
  perform public.rate_check('set_handle', 5, interval '1 hour');
  insert into profiles (id, handle) values (auth.uid(), p_handle)
    on conflict (id) do update set handle = excluded.handle;
  perform public.audit('set_handle', p_handle);
  return p_handle;
exception when unique_violation then raise exception 'handle_taken';
end $$;
