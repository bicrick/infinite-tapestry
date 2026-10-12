-- Every 5 minutes, ask the Vercel controller to reconcile the GPU pod with the fuel tank.
-- The controller URL and shared secret live in Supabase Vault (set by scripts/deploy_web.sh):
--   controller_url    e.g. https://<deployment>/api/controller?x-vercel-protection-bypass=<bypass>
--   controller_secret matches CONTROLLER_SECRET on Vercel
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.ping_controller() returns bigint
language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'controller_url'),
    headers := jsonb_build_object('content-type', 'application/json',
      'x-controller-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'controller_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 15000);
$$;
revoke all on function public.ping_controller() from public, anon, authenticated;

select cron.unschedule('tapestry-controller') where exists (select 1 from cron.job where jobname = 'tapestry-controller');
select cron.schedule('tapestry-controller', '*/5 * * * *', 'select public.ping_controller()');

-- Trim the rate-limit scratch table daily.
select cron.unschedule('tapestry-rate-trim') where exists (select 1 from cron.job where jobname = 'tapestry-rate-trim');
select cron.schedule('tapestry-rate-trim', '17 4 * * *', $$delete from public.rate_events where created_at < now() - interval '2 days'$$);
