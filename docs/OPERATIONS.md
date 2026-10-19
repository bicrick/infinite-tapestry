# Operations

Everything production needs lives in this repo plus GitHub repo secrets/variables. No laptop, box or pod disk is a
source of truth: a lost machine is replaced by cloning and pushing.

## Moving parts

| Piece | Where | Deployed by |
|---|---|---|
| Site + API (`static/`, `web/api`, `web/lib`) | Vercel project `infinite-tapestry-app` | CI on every push to `main` |
| GPU worker (`infinite_tapestry/`, `scripts/pod/`) | RunPod pod (id in Supabase `pod_state.pod_id`) | CI publishes a release, the pod follows it |
| Database (ideas, strips index, pod_state, auto_config, …) | Supabase Postgres, schema in `supabase/migrations/` | by hand (SQL editor / `supabase db push`) |
| Images (strips, Time Machine tiles, canvas, crops) | Cloudflare R2 bucket (`R2_BUCKET`), public via `R2_PUBLIC_URL` | written by the pod and the Vercel cron |
| Small private objects | Supabase Storage: `deploy/worker/*` (releases), `deploy/secrets/r2.env`, `tapestry/tm/idx` (TM JSON index), `idea-refs` (user uploads) | CI / app |

Scheduled jobs: Vercel cron `/api/tm` every 5 min (Time Machine index + tiles), Supabase pg_cron → `/api/controller`
every 5 min (GPU on/off reconcile; URL + `CONTROLLER_SECRET` live in Supabase Vault), GitHub `Watchdog` every 5 min
(fails, and opens an issue, when no strip landed for 3+ minutes while the GPU should be on).

## CI flow (`.github/workflows/ci.yml`)

push to `main` (or Actions → CI → Run workflow):

1. **test** — pytest, JS syntax check, site build + smoke test. No secrets.
2. **publish-worker** — `scripts/publish_worker.sh`: if the worker code (`infinite_tapestry/`, `scripts/pod/`,
   `pyproject.toml`, `requirements.txt`) changed since the current release, upload `deploy/worker/<sha>.tgz` and point
   `latest.txt` at it. Web-only commits publish nothing and never restart the pod. `force_worker` on a manual run
   publishes anyway.
3. **deploy-web** — sync secrets (below), build, `vercel deploy --prod`, smoke-test the deployment, alias the domains,
   `vercel promote` (so crons follow), then check the prod pod reports `storage.r2.write_ok`.
4. **The pod** — `scripts/pod/supervise.sh` polls `latest.txt` every 2 min. On a new sha it downloads the release,
   restarts the app on it and waits for `/health`; if that fails within 5 min it switches back to the previous release
   and never retries that sha. New pods (GPU switch) pull the newest release at boot (`web/lib/gpu.js` `BOOT`).

Pull requests get a Vercel preview (no domains) and run the tests; nothing reaches prod.

## Secrets

GitHub repo secrets are the source of truth. `scripts/ci/secrets.json` lists every runtime secret, which Vercel
environments get it, whether it is required, and where to get the value. On each deploy
`scripts/ci/sync_secrets.py` upserts changed values into Vercel (change detection by a short hash tag in the env
comment, so values are never read back or printed) and refreshes the pod's durable R2 copy. A required secret missing
from GitHub *and* Vercel fails the deploy; one present only in Vercel is flagged as a warning.

To rotate a secret: `gh secret set NAME`, then push (or run CI by hand). Pods get secrets in their RunPod env at
creation (`gpu.js podEnv`, from Vercel env); a running pod picks up rotated R2 keys from the durable copy by itself.

CI-only secrets (not synced): `VERCEL_TOKEN` (deploys), `VERCEL_BYPASS` (smoke tests behind deployment protection).
Repo variables: `SITE_URL`, `TAPESTRY_GOOGLE_LOGIN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `STRIPE_MODE`,
`RUNPOD_MIN_BALANCE`.

Not secrets in GitHub (by design): the pod SSH key (`~/.ssh/rp_tapestry`, debugging only; its public half is
`SSH_PUB` in `web/lib/gpu.js`; replace both to rotate) and the Supabase Vault entries for pg_cron.

## Everyday

```bash
make setup && make test        # fresh clone, CPU only
make dev                       # mock worker + viewer at http://127.0.0.1:8000
make deploy                    # test, push main, follow the CI run
make redeploy                  # re-run CI for main;  make redeploy-worker  also forces a pod release
make health                    # prod pod throughput / R2 / alarms over 60 s
scripts/gpu.sh status|on|off   # GPU switch (TAPESTRY_GPU_SECRET)
```

Without a laptop: Actions → **CI** → Run workflow (redeploy), Actions → **Ops** → Run workflow:
`pod-health`, `storage-dry-run`, `storage-migrate` (`scripts/ops/storage_migrate.py`: moves any binaries left in
Supabase Storage to R2, verifies, deletes; resumable, safe to rerun).

Debugging the pod: `scripts/ops/pod_ssh.py 'tail -50 /root/server.log'` (needs `RUNPOD_API_KEY` and the SSH key).
Pod files: `/root/it` → `/root/releases/<sha>`, logs `/root/server.log` and `/root/supervise.log`,
`touch /root/supervise.pause` holds the app down. Live render settings (steps, CFG, scene widths, …) are in the admin
**Configuration** tab (`auto_config.render`); the pod re-reads them every 15 s.

Rollback: revert the commit and push (the pod follows `latest.txt`), or point `deploy/worker/latest.txt` at an older
sha that is still in `deploy/worker/` (CI keeps the newest releases).

## Recovering from scratch

Nothing on any machine is needed. With only the GitHub repo and its secrets:

1. `git clone https://github.com/bicrick/infinite-tapestry && cd infinite-tapestry && make setup && make test`.
2. Check the secrets: Actions → CI → Run workflow. The "Sync secrets" step lists anything missing; set it with
   `gh secret set NAME` (where to find each value: `scripts/ci/secrets.json`).
3. New Supabase project instead of the old one: apply `supabase/migrations/*.sql` in order, create the private buckets
   `deploy`, `tapestry`, `idea-refs`, set the Vault entries for the controller (see `003_controller_cron.sql`), update
   the `SUPABASE_*` secrets.
4. Push to `main` (or run CI by hand). The site deploys; the worker release is published (use `force_worker` if the
   worker code did not change).
5. Turn the GPU on (admin page switch or `scripts/gpu.sh on`). The controller creates a pod if needed; the pod boots
   the newest release and starts painting in 5–10 minutes.

## External service settings (set once, by hand)

These live in the providers' dashboards, not in env vars. Check them when moving to a new domain or project:

- **Vercel** → project → Domains: `infinitetapestry.app` (+ `www` redirect). `SITE_URL` (repo variable and Vercel env)
  must match; the build rewrites absolute URLs from it.
- **Supabase** → Auth → URL configuration: Site URL = `SITE_URL`, redirect allow list `SITE_URL/**`. Google provider
  client id/secret (Google Cloud OAuth client; authorized redirect URI `https://<project>.supabase.co/auth/v1/callback`).
- **Cloudflare R2** → bucket CORS: AllowedOrigins includes `SITE_URL`.
- **Cloudflare Turnstile** → widget hostnames include the site host (the widget fails on unlisted hosts).
- **Stripe** (live and test) → webhook endpoint `SITE_URL/api/stripe-webhook`, event `checkout.session.completed`;
  its signing secret is `STRIPE_(LIVE_)WEBHOOK_SECRET`. `STRIPE_MODE=live|test` picks the key pair.
- **Supabase Vault**: `controller_url` (= `SITE_URL/api/controller`) and the controller secret (= `CONTROLLER_SECRET`)
  used by the pg_cron job in `supabase/migrations/003_controller_cron.sql`.
- **GitHub** → Settings → Notifications → Actions: email on failed workflows (Watchdog and CI failures alert this way).
