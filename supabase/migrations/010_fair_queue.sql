-- Fair queue, only when busy (> busy_pending waiting). Quiet behaviour is unchanged.
-- Busy: one idea per person per round (round-robin), score = votes + age bonus, 30-min pick cooldown,
-- 90-min expiry ('expired', the author is told to resubmit), shorter holds (pod side), honest place + ETA.
-- No LLM anywhere in selection. Selection is atomic (pick_ideas, advisory lock + row update).
alter table public.ideas drop constraint if exists ideas_status_check;
alter table public.ideas add constraint ideas_status_check
  check (status in ('pending','playing','played','rejected','withdrawn','expired'));
alter table public.ideas add column if not exists picked_at timestamptz;
create index if not exists ideas_picked on public.ideas (picked_at) where picked_at is not null;
create index if not exists ideas_pending_created on public.ideas (created_at) where status = 'pending';

alter table public.idea_limits
  add column if not exists busy_pending int not null default 15,       -- fair mode when more than this many wait
  add column if not exists expire_minutes int not null default 90,
  add column if not exists cooldown_minutes int not null default 30,
  add column if not exists age_votes_per_min numeric not null default 0.2, -- 5 min waiting = 1 vote
  add column if not exists busy_scene_s int not null default 9,         -- ~1 blend + 2 hold strips
  add column if not exists quiet_scene_s int not null default 15;       -- ~1 blend + 4 hold strips + pull tick

drop policy if exists "read ideas" on public.ideas;
create policy "read ideas" on public.ideas for select using (status in ('pending','playing','played','expired'));

-- The canonical line: every pending idea with its place and an honest ETA (seconds).
create or replace function public.fair_line(p_limit int default 20)
returns table(id bigint, handle text, body text, image_path text, votes int, place int, eta_s int, busy boolean)
language plpgsql stable security definer set search_path = public as $$
declare lim idea_limits; n int;
begin
  select * into lim from idea_limits where idea_limits.id = 1;
  select count(*) into n from ideas i where i.status = 'pending';
  if n <= lim.busy_pending then
    -- quiet: exactly today's order (FIFO; votes first once more than 3 wait)
    return query
      select i.id, i.handle, i.body, i.image_path, i.votes,
             (row_number() over w)::int, ((row_number() over w) * lim.quiet_scene_s)::int, false
      from ideas i where i.status = 'pending'
      window w as (order by case when n > 3 then i.votes else 0 end desc, i.created_at, i.id)
      order by 6 limit p_limit;
    return;
  end if;
  return query
  with p as (
    select i.*, coalesce(i.user_id::text, 'g:' || i.guest_id::text) as own,
           i.votes + lim.age_votes_per_min * greatest(0, extract(epoch from now() - i.created_at) / 60) as score
    from ideas i where i.status = 'pending' and i.created_at > now() - make_interval(mins => lim.expire_minutes)),
  cool as (
    select coalesce(i.user_id::text, 'g:' || i.guest_id::text) as own,
           greatest(0, extract(epoch from max(i.picked_at) + make_interval(mins => lim.cooldown_minutes) - now())) as wait_s
    from ideas i where i.picked_at > now() - make_interval(mins => lim.cooldown_minutes) group by 1),
  r as (
    select p.*, row_number() over (partition by p.own order by p.score desc, p.id) as k, coalesce(c.wait_s, 0) as cw
    from p left join cool c using (own)),
  o as (
    select r.*, row_number() over (order by r.k, (r.cw > 0), r.score desc, r.id) as pl from r)
  select o.id, o.handle, o.body, o.image_path, o.votes, o.pl::int,
         greatest(o.pl * lim.busy_scene_s, o.cw + (o.k - 1) * lim.cooldown_minutes * 60)::int, true
  from o order by o.pl limit p_limit;
end $$;

-- Atomic pick for the pod (busy mode). Expires stale ideas, then marks the next p_n as playing.
create or replace function public.pick_ideas(p_n int default 3)
returns table(id bigint, handle text, body text, votes int, boost_cents int, image_path text, user_id uuid)
language plpgsql volatile security definer set search_path = public as $$
declare lim idea_limits;
begin
  perform pg_advisory_xact_lock(7104201);
  select * into lim from idea_limits where idea_limits.id = 1;
  if (select count(*) from ideas i where i.status = 'pending') > lim.busy_pending then
    update ideas i set status = 'expired'
      where i.status = 'pending' and i.created_at < now() - make_interval(mins => lim.expire_minutes);
  end if;
  return query
    update ideas i set status = 'playing', picked_at = now()
    from (select f.id, f.place from public.fair_line(p_n) f) f
    where i.id = f.id and i.status = 'pending'
    returning i.id, i.handle, i.body, i.votes, i.boost_cents, i.image_path, i.user_id;
end $$;

-- Anyone can ask where their idea stands.
create or replace function public.queue_place(p_id bigint)
returns table(place int, eta_s int, busy boolean, status text)
language sql stable security definer set search_path = public as $$
  select f.place, f.eta_s, f.busy, i.status
  from ideas i left join public.fair_line(100000) f on f.id = i.id where i.id = p_id;
$$;

-- Demand-scaled per-person cap: 5 when quiet, falling continuously to 1 at twice the busy threshold.
create or replace function public.submit_idea(p_body text, p_image text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare new_id bigint; b text := btrim(p_body); lim idea_limits; pend int; cap int;
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
  select count(*) into pend from ideas where status = 'pending';
  cap := coalesce(lim.max_pending, 5);
  if pend > lim.busy_pending then
    cap := greatest(1, cap - ceil((pend - lim.busy_pending) * (cap - 1)::numeric / greatest(1, lim.busy_pending))::int);
  end if;
  if (select count(*) from ideas where user_id = auth.uid() and status = 'pending') >= cap then
    raise exception 'too_many_pending';
  end if;
  perform public.rate_check('submit_idea', coalesce(lim.per_minute, 10), interval '1 minute', coalesce(lim.per_minute, 10) * 3);
  insert into ideas (user_id, handle, body, image_path) values (auth.uid(), public.my_handle(), b, p_image) returning id into new_id;
  perform public.audit('submit_idea', new_id::text, jsonb_build_object('body', b, 'image', p_image));
  return new_id;
end $$;

revoke execute on function public.fair_line(int) from public, anon, authenticated;
revoke execute on function public.pick_ideas(int) from public, anon, authenticated;
grant execute on function public.fair_line(int) to service_role;
grant execute on function public.pick_ideas(int) to service_role;
grant execute on function public.queue_place(bigint) to anon, authenticated, service_role;

-- Drawer list: the whole pending set, sorted on the server (display only), paged.
create or replace function public.queue_list(p_sort text default 'up', p_offset int default 0, p_limit int default 50)
returns table(id bigint, handle text, body text, image_path text, votes int, place int, eta_s int, busy boolean, created_at timestamptz, user_id uuid)
language sql stable security definer set search_path = public as $$
  select f.id, f.handle, f.body, f.image_path, f.votes, f.place, f.eta_s, f.busy, i.created_at, i.user_id
  from public.fair_line(100000) f join ideas i on i.id = f.id
  order by case when p_sort = 'new' then extract(epoch from i.created_at) * -1 when p_sort = 'liked' then -f.votes else 0 end,
           f.place
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
$$;
grant execute on function public.queue_list(text, int, int) to anon, authenticated, service_role;
