# Tonight's plan: productionize Infinite Tapestry (Oct 12, overnight)

Status legend: [x] done · [~] in progress · [ ] todo · [!] blocked

Guardrails: Stripe **test mode only**; production Vercel URL keeps the offline page (new app goes to a **preview** URL);
nothing promoted publicly; RunPod hard cap **$10** tonight (starting balance $24.88 at 02:26 CT); pod runs only during
GPU tests and is **stopped** (not terminated) at the end; secrets never printed or committed.

## Architecture (decided)
- **GPU server** (FastAPI on RunPod, unchanged core): one shared generator/timeline, Claude director, NSFW check.
  Talks to Supabase with the service-role key (server env only).
- **Supabase** (`infinite-tapestry`, us-east, free): Auth (magic link; Google needs OAuth creds → morning),
  Postgres tables + RLS + security-definer RPCs (ideas, votes, chat, fuel ledger, donations, boosts, bans/mutes,
  rate events, append-only audit log), Realtime for ideas/chat, Storage bucket for strip persistence.
- **Vercel** (preview deployment, protection bypass for automation): static frontend + serverless functions:
  `/api/checkout` (Stripe Checkout, test), `/api/stripe-webhook` (verifies signature → credits fuel, audit),
  `/api/controller` (fuel burn + RunPod stop/start). Called every 5 min by **Supabase pg_cron + pg_net**
  (Vercel Hobby crons are daily-only) and immediately by the webhook on donation.
- **Fuel**: $0.17/hr GPU + measured Claude cost; ledger in Supabase; pod stops at zero, wakes on donation.

## Checklist
1. [x] Commit loose less-filtering work (PR #7)
2. [x] Content line: everything except sexual content + NSFW classifier, minors block kept (PR #8)
3. [x] Persistence: strips + queue/state to disk and Supabase Storage, restore on restart, full-history export
4. [ ] Long-session stability: client strip window + pan refetch, WS reconnect backoff, Wake Lock, ambient mode, accelerated mock soak with memory tracking
5. [x] Supabase project + schema + RLS + RPCs + audit log
6. [ ] Accounts: magic-link login; anonymous watching; login required to submit/vote/chat
7. [ ] Crowd queue: idea pool, upvotes, one active idea/user, cooldown, Claude merges top ideas, autopilot fallback, handle attribution
8. [ ] Live chat with rate limits
9. [ ] Rate limiting & abuse: per-user/IP limits (ideas, votes, chat, boosts, Claude, WS conns), global Claude caps, payload limits, progressive cooldowns/mutes, admin ban/mute
10. [ ] Audit logging (append-only) + admin audit view
11. [ ] Fuel: Stripe Checkout tiers (test), webhook → ledger, fuel bar, donor wall, idea boosts
12. [ ] Controller: auto sleep at zero fuel / wake on donation (RunPod API), "out of fuel" page state
13. [ ] Consistent minimalist UI for all new surfaces
14. [ ] E2E test with Stripe test card 4242, screenshots `prod_*.png`
15. [ ] docs/PRODUCTION.md (architecture, env vars, runbook, go-live steps)
16. [ ] Pod stopped, final report
