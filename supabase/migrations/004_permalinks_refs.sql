-- Permalinks (where each idea landed) + optional reference image per idea.
alter table public.ideas add column if not exists start_strip int;
alter table public.ideas add column if not exists end_strip int;
alter table public.ideas add column if not exists image_path text;
alter table public.ideas add column if not exists image_note text;

-- Public-read bucket for reference images: 2 MB, jpeg/png/webp only. Users write only into their own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('idea-refs', 'idea-refs', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg','image/png','image/webp'];
drop policy if exists "idea refs upload own" on storage.objects;
create policy "idea refs upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'idea-refs' and (storage.foldername(name))[1] = auth.uid()::text
              and public.is_sanctioned('mute') is null);

drop function if exists public.submit_idea(text);
create or replace function public.submit_idea(p_body text, p_image text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare new_id bigint; b text := btrim(p_body);
begin
  perform public.require_user('mute');
  if char_length(b) < 2 or char_length(b) > 300 then raise exception 'bad_length'; end if;
  if public.is_sexual(b) then
    perform public.audit('idea_rejected_sexual', null, jsonb_build_object('body', left(b, 120)));
    raise exception 'content_not_allowed';
  end if;
  if p_image is not null and (p_image !~ ('^' || auth.uid()::text || '/[A-Za-z0-9_.-]{1,80}$')
      or not exists (select 1 from storage.objects where bucket_id = 'idea-refs' and name = p_image)) then
    raise exception 'bad_image';
  end if;
  if exists (select 1 from ideas where user_id = auth.uid() and status = 'pending') then
    raise exception 'one_active_idea';
  end if;
  perform public.rate_check('submit_idea', 3, interval '10 minutes', 8);
  if exists (select 1 from ideas where user_id = auth.uid() and created_at > now() - interval '60 seconds') then
    raise exception 'cooldown:60';
  end if;
  insert into ideas (user_id, handle, body, image_path) values (auth.uid(), public.my_handle(), b, p_image) returning id into new_id;
  perform public.audit('submit_idea', new_id::text, jsonb_build_object('body', b, 'image', p_image));
  return new_id;
end $$;
