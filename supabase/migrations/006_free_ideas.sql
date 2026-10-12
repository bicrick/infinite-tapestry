-- Free enqueueing: no per-idea cooldown, no one-pending rule. Soft limits are configurable.
create table if not exists public.idea_limits (
  id int primary key default 1 check (id = 1),
  per_minute int not null default 10,
  max_pending int not null default 5
);
insert into public.idea_limits (id) values (1) on conflict (id) do nothing;
alter table public.idea_limits enable row level security;

create or replace function public.submit_idea(p_body text, p_image text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare new_id bigint; b text := btrim(p_body); lim idea_limits;
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
  select * into lim from idea_limits where id = 1;
  if (select count(*) from ideas where user_id = auth.uid() and status = 'pending') >= coalesce(lim.max_pending, 5) then
    raise exception 'too_many_pending';
  end if;
  -- Soft per-minute limit; flood (3x) still triggers the progressive auto-mute.
  perform public.rate_check('submit_idea', coalesce(lim.per_minute, 10), interval '1 minute', coalesce(lim.per_minute, 10) * 3);
  insert into ideas (user_id, handle, body, image_path) values (auth.uid(), public.my_handle(), b, p_image) returning id into new_id;
  perform public.audit('submit_idea', new_id::text, jsonb_build_object('body', b, 'image', p_image));
  return new_id;
end $$;
