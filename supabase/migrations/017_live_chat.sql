-- Live chat on the home page: signed-in users post through /api/chat (server moderation first),
-- 200 chars, no links, slow mode, sitewide off switch. Guests read only.
alter table public.idea_limits add column if not exists chat_enabled boolean not null default true;
alter table public.idea_limits add column if not exists chat_slow_seconds int not null default 5;

-- Public, cheap: is chat on, and how slow.
create or replace function public.chat_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('enabled', coalesce(chat_enabled, true), 'slow', coalesce(chat_slow_seconds, 5)) from idea_limits where id = 1
$$;
grant execute on function public.chat_settings() to anon, authenticated;

create or replace function public.has_link(t text) returns boolean language sql immutable as $$
  select t ~* '(https?://|www\.|\m[a-z0-9-]+\s?(\.|\(dot\)|\[dot\])\s?(com|net|org|io|gg|co|app|xyz|ly|me|tv|ru|info|biz|link|site|online|shop|live|dev|ai|us|uk|de|to|cc|fm|be|so|club|store)\M|discord\.gg|t\.me/)'
$$;

-- Called only by /api/chat (service role) after the token is verified and the text moderated.
create or replace function public.user_send_chat(p_user uuid, p_ip text, p_body text, p_flagged text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare b text := btrim(regexp_replace(p_body, '\s+', ' ', 'g')); h text; lim idea_limits; last timestamptz; wait int; new_id bigint; bad text := nullif(p_flagged, '');
begin
  select * into lim from idea_limits where id = 1;
  if not coalesce(lim.chat_enabled, true) then return jsonb_build_object('error', 'chat_off'); end if;
  select handle into h from profiles where id = p_user;
  if h is null then return jsonb_build_object('error', 'handle_required'); end if;
  if exists (select 1 from sanctions s where (s.user_id = p_user or (p_ip is not null and s.ip_hash = p_ip))
             and s.kind in ('ban', 'mute') and (s.until is null or s.until > now())) then
    return jsonb_build_object('error', 'muted');
  end if;
  if char_length(b) < 1 or char_length(b) > 200 then return jsonb_build_object('error', 'bad_length'); end if;
  if public.has_link(b) then return jsonb_build_object('error', 'no_links'); end if;
  if bad is null and (public.is_sexual(b) or public.is_hateful(b)) then bad := 'blocked'; end if;
  if bad is not null then
    perform public.audit('chat_rejected', p_user::text, jsonb_build_object('reason', bad, 'body', left(b, 120)));
    return jsonb_build_object('error', 'content_not_allowed');
  end if;
  perform pg_advisory_xact_lock(hashtext('chat:' || p_user::text));
  select max(created_at) into last from chat_messages where user_id = p_user;
  if last is not null and last > now() - make_interval(secs => coalesce(lim.chat_slow_seconds, 5)) then
    wait := ceil(extract(epoch from (last + make_interval(secs => coalesce(lim.chat_slow_seconds, 5)) - now())))::int;
    return jsonb_build_object('error', 'slow_mode', 'wait', greatest(1, wait));
  end if;
  insert into chat_messages (user_id, handle, body, ip_hash) values (p_user, h, b, p_ip) returning id into new_id;
  perform public.audit('chat', new_id::text, jsonb_build_object('body', left(b, 200)));
  return jsonb_build_object('id', new_id, 'handle', h);
end $$;
revoke execute on function public.user_send_chat(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.user_send_chat(uuid, text, text, text) to service_role;

-- The old direct paths skipped server moderation: chat now goes only through /api/chat.
revoke execute on function public.send_chat(text) from public, anon, authenticated;
