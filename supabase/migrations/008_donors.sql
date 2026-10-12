-- Donor shout-outs, low-fuel nudge threshold, and priority-queue knobs.
-- Stripe is in TEST mode; donations only keep the GPU alive.

alter table public.idea_limits
  add column if not exists fuel_low_cents int not null default 500,   -- nudge when the fuel balance drops below this
  add column if not exists prio_viewers int not null default 10,      -- priority queue engages at >= this many viewers…
  add column if not exists prio_pending int not null default 6,       -- …or this many pending ideas
  add column if not exists prio_ratio int not null default 2;         -- N priority ideas, then 1 free idea

-- ---------- donor banners ----------
create table if not exists public.donor_banners (
  user_id uuid primary key references auth.users on delete cascade,
  handle text not null,
  tagline text check (tagline is null or char_length(tagline) <= 60),
  url text check (url is null or char_length(url) <= 200),
  hidden boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.donor_banners enable row level security;
drop policy if exists donor_banners_read on public.donor_banners;
create policy donor_banners_read on public.donor_banners for select using (not hidden);
grant select on public.donor_banners to anon, authenticated;

create or replace function public.is_donor(uid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from donations d where d.user_id = uid)
$$;

-- URL safety: https only, a real hostname (no IPs, no credentials, no ports), no shorteners or adult hosts.
create or replace function public.safe_url(u text) returns text language plpgsql immutable as $$
declare host text;
begin
  if u is null or btrim(u) = '' then return null; end if;
  u := btrim(u);
  if u !~* '^https?://' then u := 'https://' || u; end if;
  u := regexp_replace(u, '^http://', 'https://', 'i');
  host := lower(substring(u from '^https://([^/?#]+)'));
  if host is null or host ~ '[@:]' or host ~ '^[0-9.]+$' or host !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then raise exception 'bad_url'; end if;
  if host ~ '(^|\.)(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|onlyfans\.com|fansly\.com|pornhub\.com|xvideos\.com|xhamster\.com|chaturbate\.com)$'
     or host ~ '(porn|xxx|sex|nude|escort|casino|onlyfans)' or host ~ '\.(xxx|adult|porn|sex|zip|mov)$' then raise exception 'bad_url'; end if;
  if public.is_sexual(u) then raise exception 'bad_url'; end if;
  return left(u, 200);
end $$;

create or replace function public.set_donor_banner(p_tagline text, p_url text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); h text; t text := nullif(btrim(regexp_replace(coalesce(p_tagline, ''), '\s+', ' ', 'g')), ''); u text;
begin
  if uid is null then raise exception 'login_required'; end if;
  if not public.is_donor(uid) then raise exception 'donors_only'; end if;
  select handle into h from profiles where id = uid;
  if h is null then raise exception 'handle_required'; end if;
  if t is not null and (char_length(t) > 60 or public.is_sexual(t) or public.is_minor_ref(t) and public.is_sexual(t)
                        or t ~* '(https?://|www\.|\.com\b|\.gg\b)') then raise exception 'content_not_allowed'; end if;
  u := public.safe_url(p_url);
  insert into donor_banners (user_id, handle, tagline, url, updated_at) values (uid, h, t, u, now())
    on conflict (user_id) do update set handle = excluded.handle, tagline = excluded.tagline, url = excluded.url, updated_at = now();
  perform public.audit('donor_banner', uid::text, jsonb_build_object('tagline', t, 'url', u));
  return jsonb_build_object('handle', h, 'tagline', t, 'url', u);
end $$;
revoke execute on function public.set_donor_banner(text, text) from public, anon;
grant execute on function public.set_donor_banner(text, text) to authenticated;

-- ---------- public donor views (amounts are shown; it's a thank-you wall) ----------
create or replace view public.donors_recent with (security_invoker = false) as
  select coalesce(p.handle, d.handle, 'anonymous') as handle, d.amount_cents, d.created_at,
         b.tagline, b.url
  from public.donations d
  left join public.profiles p on p.id = d.user_id
  left join public.donor_banners b on b.user_id = d.user_id and not b.hidden
  order by d.created_at desc limit 30;

create or replace view public.donors_top with (security_invoker = false) as
  select coalesce(p.handle, max(d.handle), 'anonymous') as handle, sum(d.amount_cents)::int as total_cents,
         count(*)::int as gifts, max(d.created_at) as last_at, max(b.tagline) as tagline, max(b.url) as url
  from public.donations d
  left join public.profiles p on p.id = d.user_id
  left join public.donor_banners b on b.user_id = d.user_id and not b.hidden
  group by coalesce(d.user_id::text, 'anon:' || coalesce(d.handle, '')), p.handle
  order by total_cents desc limit 50;
grant select on public.donors_recent, public.donors_top to anon, authenticated;

-- Fuel status carries the nudge threshold so clients don't need idea_limits.
create or replace view public.fuel_status with (security_invoker = false) as
  select coalesce(sum(delta_cents), 0)::numeric(12,2) as balance_cents,
         (select status from pod_state where id = 1) as pod_status,
         (select fuel_low_cents from idea_limits where id = 1) as low_cents
  from public.fuel_ledger;
grant select on public.fuel_status to anon, authenticated;
