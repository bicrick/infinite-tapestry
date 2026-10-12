# Infinite Tapestry: production guide

## Architecture

```
 viewers (browser) ──https──> Vercel (static app + /api functions)
        │                         ├─ /api/checkout        Stripe Checkout session (test mode until go-live)
        │                         ├─ /api/stripe-webhook  verify signature → donations + fuel_ledger + audit → wake pod
        │                         ├─ /api/controller      reconcile pod with fuel (called by Supabase pg_cron every 5 min)
        │                         └─ /api/snapshot        last canvas for the "asleep" backdrop
        ├──wss──> RunPod GPU pod (FastAPI + SD1.5 inpainting, 1 shared timeline for everyone)
        │             ├─ Crowd director: top-3 pending ideas (boost, votes, age) → Claude merges → queue, "by @handles"
        │             ├─ Autopilot (Claude) when the pool is empty
        │             ├─ NSFW classifier per strip (Falconsai/nsfw_image_detection): regenerate, then blur
        │             ├─ Fuel meter: burns GPU ($0.17/h) + Claude cost into fuel_ledger; self-stops at 0
        │             └─ Mirrors every strip + state to Supabase (the disk is only a cache)
        └──https/realtime──> Supabase (project vforasrnktvqzukusejq)
                      Auth (magic link; Google optional), Postgres (ideas, votes, chat, donations, fuel_ledger,
                      sanctions, rate_events, audit_log [append-only], pod_state, tapestry_state, strips),
                      Storage bucket `tapestry` (strip JPEGs, canvas.png), Realtime (ideas, chat, pod_state),
                      pg_cron + pg_net (controller ping, rate-table trim), Vault (controller URL + secret)
```

Why the controller lives on Vercel and is triggered by Supabase pg_cron: both are already part of the
stack, always on, and free at this scale. Vercel Hobby crons only run daily, so pg_cron provides the 5-minute
tick. The pod also stops itself at zero fuel, and the webhook wakes it right after a donation, so the cron
is only a safety net.

### Abuse protection
* All writes go through SECURITY DEFINER RPCs (migration 001), which enforce login, handle, sanctions and per-user/per-IP
  rate limits with progressive auto-mute. Specific limits: one active idea per user, a 60 s cooldown and 3 ideas
  per 10 min; chat is capped at 5 messages per 30 s.
* The GPU server WebSocket allows 8 connections per IP and 500 in total. Messages are capped at 4 KB; anyone
  sending more than 120 messages in 10 s is disconnected. Only admins can send stage-control messages (verified
  Supabase JWT plus `profiles.is_admin`). Claude is capped at 90 calls per hour and a 400k-token budget, with backoff.
* Checkout is throttled to 6 sessions per minute per IP. Tiers are fixed, the return URL must be same-origin, and webhook
  replays are idempotent through a unique `stripe_session_id`.
* Admin tools: hover a chat line to hide, mute or ban it; ideas show a reject button for admins; the Audit tab reads
  `admin_audit()`.
* The audit log records submissions, votes, chat, checkouts, fuel credits, director merges, NSFW blocks, pod start/stop
  and admin actions, with hashed IPs.

### Content line
"Wild west except sexual content": sexual intents are rejected (in SQL, in guard.py and by Claude), minors are
always blocked, and every generated strip passes the NSFW classifier.

## Environment

GPU pod (`/root/.tapestry.env`):
`TAPESTRY_ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RUNPOD_POD_ID`, `RUNPOD_API_KEY`,
plus optional `TAPESTRY_STORAGE_PREFIX` (default `live`), `TAPESTRY_GPU_CENTS_PER_HOUR` (17), `TAPESTRY_CROWD` (1),
`TAPESTRY_MAX_CONN_PER_IP` (8) and `TAPESTRY_MAX_CONNECTIONS` (500).

Vercel project `infinite-tapestry-app` (preview env today):
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`RUNPOD_API_KEY`, `RUNPOD_POD_ID`, `CONTROLLER_SECRET`, `IP_HASH_SALT`, `CONTROLLER_ENABLE_START` (0 = never auto-start;
set 1 at go-live), optional `STRIPE_TAX_CODE` (default txcd_10000000).

Local secrets (box): `~/.tapestry/supabase.env` and `~/.tapestry/app.env` (CONTROLLER_SECRET, IP_HASH_SALT,
VERCEL_BYPASS, STRIPE_WEBHOOK_ID/SECRET).

## Runbook
* **Deploy the web app (preview):** `scripts/deploy_web.sh` builds static + functions, deploys a Vercel preview,
  aliases it to infinite-tapestry-preview.vercel.app, and repoints the Stripe webhook and the Vault `controller_url` at the
  new deployment.
* **Deploy the GPU server:** copy `infinite_tapestry/` to `/root/it`, then
  `pkill -f "m infinite_[t]apestry"; nohup /root/run.sh > /root/server.log 2>&1 < /dev/null &`.
* **Restore:** automatic. On start the server reads `tapestry_state` and `canvas.png` from Supabase, and older strips load
  from Storage on demand.
* **Sleep or wake by hand:** `update pod_state set desired='off'` (the controller stops the pod) or `'auto'`.
* **Grant fuel:** `insert into fuel_ledger(delta_cents, reason) values (500, 'admin_grant');`
* **Make an admin:** `update profiles set is_admin = true where handle = '…';`
* **Soak test:** `/tmp/soak.py` style. At 8× on mock, 1,672 strips held server RSS flat at about 147 MB and JS heap at 2–3 MB,
  because the client evicts beyond 360 strips and refetches on pan.

## Go-live checklist (needs you)
1. Stripe: switch to live keys and create a live webhook endpoint for `/api/stripe-webhook` on the production domain. Review
   the tax setting (the account uses managed payments, so Checkout adds tax on top; fuel is credited on the
   subtotal minus Stripe fees).
2. Vercel: add the env vars to **Production**, set `CONTROLLER_ENABLE_START=1`, then deploy prod (this replaces the offline page).
   Point the Vault `controller_url` at the prod URL (no bypass param needed if prod is public).
3. Supabase Auth: set `site_url` to the prod domain and configure custom SMTP (the built-in sender is heavily rate-limited).
   For Google login, create OAuth credentials, enable the provider, and set `google: true` via `TAPESTRY_GOOGLE_LOGIN=true` in the build.
4. Seed fuel or donate, set `pod_state.desired='auto'`, and the controller will wake the pod.
5. Make your account admin (see above).
