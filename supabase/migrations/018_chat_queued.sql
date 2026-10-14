-- System lines in chat: '<name> queued "<idea>"' when a public idea lands. Inserted by a trigger on ideas so
-- every client sees it via the existing realtime channel, whatever path created the idea (guest API or the
-- signed-in RPC). Never for admins/owner, never for shadow-muted ideas (those live in shadow_ideas), never
-- for Auto (Auto never writes to ideas). Additive only: no data is removed.
alter table public.chat_messages add column if not exists kind text not null default 'user';
alter table public.chat_messages add column if not exists idea_id bigint;
alter table public.chat_messages add column if not exists extra int not null default 0;
-- the submitter lives here, not in user_id, so system lines never count toward the user's chat slow mode
alter table public.chat_messages add column if not exists actor_user uuid;
alter table public.chat_messages add column if not exists actor_guest uuid;
create unique index if not exists chat_idea_once on public.chat_messages (idea_id) where idea_id is not null;
create index if not exists chat_queued_actor on public.chat_messages (actor_user, actor_guest, created_at) where kind = 'queued';

create or replace function public.chat_idea_queued() returns trigger
language plpgsql security definer set search_path = public as $$
declare h text; adm boolean; t text; rid bigint;
begin
  if new.status <> 'pending' then return new; end if;
  if not coalesce((select chat_enabled from idea_limits where id = 1), true) then return new; end if;
  if new.user_id is not null then
    select is_admin into adm from profiles where id = new.user_id;
    if coalesce(adm, false) then return new; end if;
  end if;
  h := nullif(btrim(coalesce(new.handle, '')), '');
  if h is null or lower(ltrim(h, '@')) in ('bicrick', 'claude', 'auto') then h := 'Someone'; end if;
  t := btrim(regexp_replace(new.body, '\s+', ' ', 'g'));
  if char_length(t) > 60 then t := rtrim(left(t, 57)) || '…'; end if;
  if char_length(t) < 1 then return new; end if;
  -- coalesce bursts: same person within 90 s bumps their existing line ("and 2 more") instead of a new one
  select id into rid from chat_messages
   where kind = 'queued' and not hidden and created_at > now() - interval '90 seconds'
     and ((new.user_id is not null and actor_user = new.user_id) or (new.guest_id is not null and actor_guest = new.guest_id))
   order by created_at desc limit 1;
  if rid is not null then
    update chat_messages set extra = extra + 1 where id = rid;
    return new;
  end if;
  insert into chat_messages (handle, body, kind, idea_id, actor_user, actor_guest)
  values (h, t, 'queued', new.id, new.user_id, new.guest_id) on conflict do nothing;
  return new;
exception when others then
  return new;   -- a chat line must never block an idea
end $$;
revoke execute on function public.chat_idea_queued() from public, anon, authenticated;

drop trigger if exists ideas_chat_queued on public.ideas;
create trigger ideas_chat_queued after insert on public.ideas for each row execute function public.chat_idea_queued();

-- Idea rejected/withdrawn later: hide its line.
create or replace function public.chat_idea_hidden() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('rejected', 'withdrawn') and old.status is distinct from new.status then
    update chat_messages set hidden = true where idea_id = new.id and not hidden;
  end if;
  return new;
exception when others then return new;
end $$;
revoke execute on function public.chat_idea_hidden() from public, anon, authenticated;
drop trigger if exists ideas_chat_hidden on public.ideas;
create trigger ideas_chat_hidden after update of status on public.ideas for each row execute function public.chat_idea_hidden();
