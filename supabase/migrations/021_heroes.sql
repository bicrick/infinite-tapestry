-- Hall of Heroes: real, live-mode Stripe donations only (test sessions excluded), never the owner/admins.
-- Name = the supporter's chosen handle, else 'Someone'. No amounts exposed.
create or replace view public.donors_heroes with (security_invoker = false) as
  select case when p.handle is null then 'Someone' else p.handle end as name,
         count(*)::int as gifts, sum(d.amount_cents)::int as total_cents, max(d.created_at) as last_at
  from public.donations d
  left join public.profiles p on p.id = d.user_id
  where d.stripe_session_id like 'cs\_live\_%'
    and not coalesce(p.is_admin, false)
    and coalesce(lower(p.handle), '') <> 'bicrick'
  group by coalesce(d.user_id::text, 'anon:' || d.id::text), p.handle;
revoke all on public.donors_heroes from anon, authenticated;
