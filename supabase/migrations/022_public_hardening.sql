-- Public-repo hardening (Oct 21, 2026). Idempotent; safe to re-run.
-- Clients must name columns explicitly on chat_messages, profiles and pod_state (select=* is refused for anon here).

-- 1) chat_messages: viewers see the message, never who sent it beyond user_id/handle. ip_hash, guest_id and the
--    actor_* moderation columns stay server-side (service_role). Realtime postgres_changes omits revoked columns.
revoke select on public.chat_messages from anon, authenticated;
grant select (id, user_id, handle, body, hidden, created_at, kind, idea_id, extra) on public.chat_messages to anon, authenticated;

-- 2) Internal SECURITY DEFINER helpers: only the server (service_role) and other SECURITY DEFINER functions (owned by
--    postgres, which keeps EXECUTE) call these. PUBLIC had EXECUTE by default.
revoke execute on function public.audit(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.rate_check(text, integer, interval, integer) from public, anon, authenticated;
grant execute on function public.audit(text, text, jsonb) to service_role;
grant execute on function public.rate_check(text, integer, interval, integer) to service_role;

-- 3) profiles.is_admin: signed-in users still read it (the site checks its own row); logged-out viewers don't.
revoke select on public.profiles from anon;
grant select (id, handle, created_at) on public.profiles to anon;

-- 4) pod_state: viewers get status/desired/pod_id/updated_at; error text and operator notes stay server-side.
revoke select on public.pod_state from anon, authenticated;
grant select (id, status, desired, updated_at, pod_id) on public.pod_state to anon, authenticated;

-- 5) Views. scene_reactions only reads strip_reactions (already public), so it runs as the caller.
--    donor_wall/donors_*/fuel_status stay SECURITY DEFINER on purpose: they publish aggregates of tables anon cannot
--    read (donations, fuel_ledger), and their column lists are the public surface.
alter view public.scene_reactions set (security_invoker = true);
