# Embed API: read-only iframe and JSON (plan, not built)

Status: plan only, Oct 14, 2026.

## Principles

- **Read-only**, served only from **cache and R2**. Nothing in the embed path calls the GPU pod; the pod's WebSocket isn't exposed to embeds.
- **Moderated titles only.** Scene titles and idea text have already passed input moderation ([SAFETY.md](../SAFETY.md)), and anything hidden, rejected or reported is excluded. There is **no submitter identity** at all: no handles, user ids or avatars.
- **Rate limited**, with **keys** for JSON and a free keyless iframe with a small badge.
- **No upsells in the main site.** Supporter perks are described only on the `/developers` page.

## Surfaces

### 1. Iframe scroller: `https://infinitetapestry.app/embed`

- **Params**: `mode=live|replay`, `h` (band height), `speed=1|0.5`, `theme=dark|light|auto`, `badge=1|0` (`0` only for supporter keys), `key=` (optional for iframes), `at=<idx>` (replay start).
- **Runtime**: a stripped viewer bundle with just the canvas, reflection and title. There's no chat, composer, drawer or sound.
- **Live pacing** comes from a cached `GET /api/v1/now` poll (s-maxage 2–5 s) that projects the shared position locally (the same math as the viewer's `onClock`), plus strips from R2.
- **Offline fallback**: when the pod is down or `now` is stale (> 60 s), it plays a **replay loop** of the last N hours from R2 and shows a calm "replay" tag. That's the existing replay logic.
- **Badge**: a small "Infinite Tapestry" link bottom-right. It's hidden for supporter keys that ask for `badge=0`.
- **Headers**: `/embed` sends `frame-ancestors *` (or the key's allowed origins), while the main site keeps `frame-ancestors 'none'`. Embeds get no cookies and no Supabase auth.

### 2. JSON (key required, CORS for the key's origins)

| Endpoint | Returns | Cache |
|---|---|---|
| `GET /api/v1/now` | `{live_edge, speed_px_s, server_time, scene:{title, style, started_at}, strip_base, pod:"on"\|"off"}` | 2–5 s |
| `GET /api/v1/recent?limit=20` | recent scenes `[{title, style, a, b, started_at, thumb_url, permalink}]` (moderated, no identity) | 60 s |
| `GET /api/v1/strip/<idx>` | `{idx, created_at, scene_title, url, permalink}` | immutable once finished |
| `GET /api/v1/day/<YYYY-MM-DD>` | the Time Machine day meta minus handles (shared with TM v3's `meta/day/*.json`) | finished days: 1 day |
| Images | direct R2 URLs (strips, `lod2` tiles, crops) | immutable |

`thumb_url` points at the existing crop endpoint output, cached on R2, never rendered on demand from the pod for embeds. Only crops that already exist are linked; missing ones fall back to an `lod2` L1 tile.

## Rate limiting and caching

- **The edge cache absorbs nearly everything**: identical URLs per window, with `s-maxage` + `stale-while-revalidate`.
- **Per-key limits** are enforced in a tiny Vercel edge middleware with a counter store, either Upstash Redis free tier or a Supabase RPC with a 1-minute bucket (open question). Defaults:
  - keyless iframe: per-IP 60 page loads/hour;
  - free key: 1 req/s, 20k/day;
  - supporter key: 5 req/s, 200k/day.
- **429s** carry `Retry-After`. Keys over limit fall back to cached responses, not errors, wherever possible.

## Access model

- **Keyless**: the iframe with the badge and IP rate limits. There's no JSON without a key.
- **Free key, "apply"**: a short form on `/developers` (email, site URL, intended use). It creates an `api_keys` row with `status=pending`, and the admin approves it in one click from a new "API keys" list in the admin's Configuration area. Light-touch approval mostly filters spam and abuse.
- **Supporters**: any donor through the existing Stripe flow (`donations`, matched by account or email) can turn on perks for their key: `badge=0`, higher limits, and early access to new endpoints. A perk lapses if a donation is refunded. No subscription is required in v1.
- **Schema sketch**: `api_keys(id, key_hash, owner_user_id, email, site_origins text[], purpose, tier free|supporter, status pending|active|revoked, limits jsonb, created_at, last_used_at)`. Store only key hashes; show the key once.
- **Abuse**: keys are origin-bound (the `Origin`/`Referer` check matters most for iframes, where keys are public); they can be revoked from the admin, and usage is logged to `ops_events`.

## Phases (rough effort)

1. **E1 (1.5–2 d)**: `/embed` bundle (live + replay fallback) + `/api/v1/now` + `/api/v1/recent`, keyless, with badge and IP limits.
2. **E2 (1–1.5 d)**: `api_keys` table + the apply form + admin approval + per-key limits + CORS by origin.
3. **E3 (0.5–1 d)**: supporter perks (Stripe link, `badge=0`, limits) + `/developers` docs page + `strip`/`day` endpoints (after TM v3 P0).

**Total ≈ 3–4.5 days.** Hosting cost is negligible because everything is served from cache and R2.

## Open questions

1. Should keyless iframes be allowed at all, or should every embed need an approved key?
2. Counter store: Upstash Redis (new dependency, free tier) or Supabase RPC (no new vendor, slower)?
3. Supporter threshold: any donation, or a minimum amount in a trailing window?
4. Should embeds show ideas' text, or scene titles only (safest)?
