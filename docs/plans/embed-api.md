# Embed API: read-only iframe and JSON (plan, not built)

Status: plan only, Oct 14, 2026.

## Principles

- **Read-only**, served only from **cache and R2**. Nothing in the embed path calls the GPU pod; the pod's WebSocket isn't exposed to embeds.
- **Scene titles only (decided).** Embeds show moderated scene titles, never idea text. The user said either is fine, so we picked the safer one. Titles have already passed input moderation ([SAFETY.md](../SAFETY.md)), and anything hidden, rejected or reported is excluded. There is **no submitter identity** at all: no handles, user ids or avatars.
- **Donor-only perk (decided).** **Any donation amount** through the existing Stripe Fuel flow unlocks embeds; nobody can apply for a key, and there's no keyless embed. **Only donations made after launch count**: donors from before launch don't get access (the grant runs only for donations after the launch timestamp).
- **Rate limited** per key, with the domain allowlist enforced.
- **No upsell spam.** The only mention on the main site is one quiet line on the Fuel page ("Donors can put a live piece of the tapestry on their own site."). There are no banners, pop-ups or nags in the viewer, Time Machine or composer.

## Surfaces

### 1. Iframe scroller: `https://infinitetapestry.app/embed`

- **Params**: `key=` (required, a public embed id bound to the donor's domains), `kind=ribbon|grid|badge|replay|still`, `mode=live|replay`, `h`, `speed=1|0.5`, `theme=dark|light|auto`, `at=<idx>`.
- **Runtime**: a stripped viewer bundle with just the canvas, reflection and title. There's no chat, composer, drawer or sound.
- **Live pacing** comes from a cached `GET /api/v1/now` poll (s-maxage 2–5 s) that projects the shared position locally (the same math as the viewer's `onClock`), plus strips from R2.
- **Offline fallback**: when the pod is down or `now` is stale (> 60 s), it plays a **replay loop** of the last N hours from R2 and shows a calm "replay" tag. That's the existing replay logic.
- **Donor badge**: every embed carries the donor's **own** small badge, "Infinite Tapestry · fueled by <display name>", linking to the site. The name is shown only when the donor opts in, and only their chosen display name (the same rule as the Hall of Heroes). Without the opt-in it reads "fueled by Someone". The owner account and @bicrick are never shown; the existing `OWNER` handle filter applies to badges too.
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
- **Per-key limits** are enforced in a tiny Vercel edge middleware with a counter store, either Upstash Redis free tier or a Supabase RPC with a 1-minute bucket (open question). Default per key: 2 req/s and 50k/day for JSON; embed page loads are effectively unlimited because they're edge-cached.
- **429s** carry `Retry-After`, with stale cached data served instead of errors wherever possible.

## Donor gallery (`/fuel/embed`, signed-in donors only)

One page, linked from the donor's account menu and the Fuel page's quiet line. Each card shows a **live preview** of an embed on the donor's own key, a size/theme picker, and a **copy-paste snippet** (iframe; a tiny `<script>` loader for auto-height; a plain `<img>` for the still card):

| Embed | What it is |
|---|---|
| **Ribbon scroller** | The live band drifting by, with optional reflection. Responsive width, 120–400 px tall. |
| **Recent creations grid** | 4–12 latest scene cards (thumbnail + moderated title + time); tap opens the moment on the site. |
| **Badge + live strip** | A pill-sized badge with a tiny moving strip (e.g. 240x40), for footers and sidebars. |
| **Replay loop** | A chosen moment or the donor's favourite day looping, with no live dependency (`at=`/`day=`). |
| **Still card** | A server-rendered image of the current scene (`/api/v1/card.png?key=`, refreshed every 5 min), for README/email/Notion where iframes aren't allowed. |
| **"This day" strip** | Today's ribbon squeezed into one line (from the TM v3 pyramid). |

There's also a per-key "Allowed domains" editor, usage stats, a regenerate button, and the badge name toggle on the same page.

## How donations map to embed keys

- **Webhook**: `stripe-webhook.js` already inserts into `donations` (idempotent on `stripe_session_id`, with `user_id` + `handle` from checkout metadata). Add one step after the insert: `rpc('grant_embed_access', {user_id, donation_id})`. It upserts an `embed_access` row and creates the donor's **3 keys** (e.g. "Main site", "Blog", "Spare"). The RPC ignores donations whose `created_at` is before `EMBED_LAUNCH_AT`. Guest donations (no `user_id`) get an email with a claim link that attaches the donation to an account on first sign-in.
- **Schema**:
  - `embed_access(user_id pk, status active|grace|lapsed|revoked, since, last_donation_at, active_until, show_name bool default false, display_name)`
  - `embed_keys(id, public_id, secret_hash, user_id, domains text[], created_at, last_used_at, revoked_at)`

  Each donor has **up to 3 keys** (cap enforced in the RPC), each **regenerable** from the gallery. Regenerating rotates the public id and secret, and the old ones stop after a 24 h overlap so live sites can be updated. The public id goes in iframes. The secret (shown once) is for JSON calls from servers. Secrets are stored hashed.
- **Domain allowlist**: up to 5 domains per key (wildcard subdomains allowed). The `/embed` response sets `Content-Security-Policy: frame-ancestors <domains>`, and JSON enforces CORS plus an `Origin` check. Local dev (`localhost`) is always allowed. Unknown origins get a neutral "This embed isn't enabled for this site" card, not an error page.
- **Term and lapse (still a proposal)**: any donation unlocks **12 months** from the latest donation, and a new donation extends it.
  - **Lapse**: a 30-day **grace** period, with one quiet email at lapse and none after.
  - **After grace**: embeds keep working in a reduced form, a static "replay loop" of their last day with a plain Infinite Tapestry badge, so donors' sites never break. JSON keys stop with 403.
  - **Refunds or chargebacks** revoke immediately.
  - The donor can re-activate any time by donating again, and the keys come back unchanged.
- **Abuse**: keys can be revoked from the admin (a new "Embeds" list in Configuration); usage is logged to `ops_events`, and a key showing up on many unrelated domains is flagged.

## Phases (rough effort)

1. **E1 (2 d)**: `/embed` bundle (ribbon, badge+strip, replay loop) on R2/cache only, with an offline replay fallback, `/api/v1/now` and `/recent`.
2. **E2 (1.5–2 d)**: `embed_access`/`embed_keys`, the webhook grant, the domain allowlist (CSP + CORS), lapse/grace handling, and admin revoke.
3. **E3 (1.5 d)**: the donor gallery page (previews, snippets, domains, badge name opt-in), the grid/still-card/"this day" embeds, and the one-line Fuel page mention.

**Total ≈ 5–5.5 days.** Hosting cost is negligible because everything is served from cache and R2.

## Open questions

Decided: any amount; 2–3 regenerable keys per donor (plan: 3); no access for donors from before launch; titles only.

1. Confirm the term: 12 months from the latest donation + 30-day grace (proposal).
2. Counter store: Upstash Redis (new dependency, free tier) or Supabase RPC (no new vendor, slower)?
