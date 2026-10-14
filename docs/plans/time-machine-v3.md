# Time Machine v3: one zoomable line through all of history (plan, not built)

Status: plan only, Oct 14, 2026 (revised with the user's answers). Nothing here is built.

## 1. Goal

The Time Machine becomes **its own immersive viewer**, not a replay mode of the live viewer. It's a place to *explore* the whole tapestry's history, **from the very first strip of the OG era** to (nearly) now, as **one horizontal line** you zoom continuously from "all time" down to individual strips.

Its own feel:
- a dark, quiet space where the line floats;
- smooth zoom-out "breathing" (the band thins into a colour ribbon as you pull back);
- landmarks that surface as you zoom;
- no chat, no composer, no live HUD.

On top sits a light navigation layer: date jump, step through prompts and ideas, landmarks, and a current-time / "jump to live" exit. The month calendar stays but opens only from a menu toggle.

Tapping a moment still offers "Open in the live viewer" (`/?at=<strip>`). By default, though, a tap zooms in and plays that stretch *inside* the Time Machine (a local "drift" playback at strip scale), so exploring never kicks you out.

It is performance-first. It works on throttled browsers (Low Power Mode, Energy Saver at ~30 fps, 6x CPU), and desktop behaves the same as mobile (pinch or trackpad zoom, drag).

## 2. What exists today (read from the code)

| Piece | Where | Notes |
|---|---|---|
| Strips | R2 public bucket `live-sdxl/strips/<idx>.webp` (`store.R2Public`), mirrored to Supabase Storage | 256 px wide (+192 px overlap) x 1024 tall. About **35k strips/day** at 2.8 s/strip. **57,411 strips** so far (since Oct 13). |
| Strip rows | Supabase `public.strips (session, idx, width, height, overlap, prompt, path, created_at, scene jsonb)`, PK `(session, idx)` | No index on `created_at`. `scene` = {title, style, origin, by}. |
| LOD tiles | `infinite_tapestry/lod.py`, built on the pod (1 thread) as chunks complete; mirrored to **Supabase Storage** `public:lod/<L>/<c>.jpg` | L1 = 16 strips @1/4 (1024x256). L2 = 64 strips @1/16 (1024x64). L3 = 256 strips @1/64 (1024x16). JPEG q72. Served to browsers through `/api/about?kind=tile` (a Vercel function proxying private storage, falling back to the pod). |
| History | `/api/about?kind=history` | Pages through **every** strip row (1000 per request) on each call, then groups by day. Measured just now: **3.9 s, 78 KB**. Cost grows linearly: ~12.6M rows after a year, so this breaks. |
| Pod timeline | `GET /timeline?points=300` | Index→time samples + scene runs, from the pod's local meta (the GPU box). |
| Time Machine v2 | `static/time-machine.{html,js,css}` (119 lines) | Calendar → day → 24 hour cards with lazy L2 thumbnails and idea chips → `/?at=`. |

## 3. Key decisions

0. **All of history, in eras.** The line starts at the very first strip ever painted and runs through every backend era: SD1.5 (OG, 512-tall strips, session `live`), any interim backends (Klein experiments), and SDXL (`live-sdxl`, Oct 13). Each era is a **segment** of the line with its own local strip index, placed end to end in a global "history coordinate". Era boundaries are landmarks.
1. **Within an era, the x-axis is strip index, not wall-clock time.** The art is continuous in index space, so there are no blank gaps when the GPU was off. A time ruler is drawn from an index→time map, and downtime appears as a thin labelled notch ("GPU off 2 h 10 m"). Time-proportional mode can be a later toggle.
2. **A new pyramid ("lod2") on R2**, public, immutable, behind the CDN. Browsers fetch tiles straight from R2 and never through a Vercel function or the pod. The existing L1/L2 stay for the live viewer's scrubbing.
3. **Anisotropic "line" levels.** Below 1/16 scale, tiles keep a minimum height of 64 px and only the x-axis keeps shrinking. Zoomed far out, the tapestry reads as a colour ribbon, a "spectrogram" of history, not a 4-px sliver.
4. **Precomputed metadata JSON on R2** replaces the full-table scan: a day index plus one file per day (times, scene runs, moderated ideas). Files are rewritten incrementally; finished days are immutable.
5. **One canvas renderer** with a float64 camera, time-based motion and parent-tile fallback, so the screen is never blank. DOM is used only for labels, updated at ≤10 Hz.
6. **A separate viewer**: its own page bundle (`/time-machine`), its own camera and physics, with no WebSocket to the pod. It shares only small utilities with the live viewer (tile loader, gesture normaliser, flight physics).
7. **Never the GPU.** Every Time Machine request is served from R2 and the CDN. It works when the pod is off.

## 4. UX layout (desktop and mobile are the same structure)

```
┌──────────────────────────────────────────────────────────────────────┐
│ ∞  Time Machine      [◀ prompt]  [ideas only ◻]  [prompt ▶]   📅 ☰   │  top bar (calendar via ☰ / 📅 toggle)
│ [Jump to date ▾]  All · Week · Day · Hour · Strips          ● Now →  │  zoom presets + date jump + "Now"
├──────────────────────────────────────────────────────────────────────┤
│ Oct 12        Oct 13         Oct 14        |                         │  adaptive time ruler (months→days→hours→minutes)
│▓▓▓▓▓▓▓▒▒▒▒░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓●  │  THE LINE (band), playhead at centre, Now pulse at the live edge
│      ┆ "Ribbed Lake"  ┆ idea: "frogs in rain" ┆ "Woven Pines"         │  scene/idea lane (clusters "+12" when dense)
├──────────────────────────────────────────────────────────────────────┤
│  Tue Oct 14 · 3:42 PM · Ribbed Lake at Dusk          [▶ Replay here] │  playhead readout + action
└──────────────────────────────────────────────────────────────────────┘
```

- **Band height** ~38% of the viewport on desktop, ~30% on phones in portrait. It fills the screen in landscape and fullscreen, where the chrome auto-hides like the viewer.
- **Playhead** is fixed at the centre and the world moves under it. The readout shows date · time · scene title.
- **Now indicator** is a pulsing dot at the live edge. A "Now →" button flies there, and a "live" pill appears when you reach it.
- **Prompt stepping**: ◀/▶ (keys `[` `]`) fly to the previous/next scene start, with an "ideas only" toggle. At low zoom the lane shows clustered chips; tapping a cluster zooms into it.
- **Date jump**: a native date input (plus "Today", "Yesterday" and recent days) flies to the first strip of that day, at the Day preset.
- **Calendar**: the existing month grid moves into a slide-over panel opened from ☰ or 📅. Picking a day flies the line there.
- **Tap or click a moment** to open a small card with a thumbnail, time, scene, "Replay from here" (`/?at=idx&to=idx+12`) and "Copy link". Long-press on mobile does the same.
- **Gestures**:
  - drag/flick pans, with momentum shared with the viewer's glide physics;
  - pinch zooms around the pinch centre (touch pointers and Safari `gesturechange`);
  - a trackpad pinch (`wheel` with `ctrlKey`) zooms;
  - two-finger horizontal scroll pans;
  - mouse wheel zooms when the band is hovered, otherwise pans;
  - double-tap or double-click zooms in 4x;
  - keys: ←/→ use the viewer's arrow flight, +/- zoom, `0` = All, `N` = Now.
- **No upsells**, and no submitter identity beyond what v2 shows today ("Someone" for the owner).

## 5. Zoom levels and the tile pyramid ("lod2")

World unit = 1 strip = 256 px at full scale. Zoom is continuous: `scale` = screen px per world px, from 1 (strips) down to roughly (screen width)/(total width).

Tiles are always **1024 px wide**. Level L covers `4^L` x 4 strips:

| Level | Strips/tile | x scale | Tile size (WxH) | Covers | Tiles per year* | Size per tile (WebP) |
|---|---|---|---|---|---|---|
| 0 | the strips themselves | 1 | 256x1024 each | 2 min | (existing) | ~60 KB |
| 1 | 16 | 1/4 | 1024x256 | ~45 s | 790k | ~45 KB |
| 2 | 64 | 1/16 | 1024x64 | 3 min | 197k | ~14 KB |
| 3 | 256 | 1/64 | 1024x64 (y 1/16) | 12 min | 49k | ~12 KB |
| 4 | 1,024 | 1/256 | 1024x64 | 48 min | 12.3k | ~12 KB |
| 5 | 4,096 | 1/1,024 | 1024x64 | 3.2 h | 3.1k | ~12 KB |
| 6 | 16,384 | 1/4,096 | 1024x64 | 12.7 h | 770 | ~12 KB |
| 7 | 65,536 | 1/16,384 | 1024x64 | 2.1 days | 192 | ~12 KB |
| 8 | 262,144 | 1/65,536 | 1024x64 | 8.5 days | 48 | ~12 KB |
| 9 | 1,048,576 | 1/262,144 | 1024x64 | 34 days | 12 | ~12 KB |

\*At 35k strips/day ≈ 12.6M strips/year.

- **Levels 1–2** match today's L1/L2 geometry. Rebuild them as WebP on R2, or keep serving the JPEGs and only add 3–9.
- **Level ≥3 is anisotropic**: height is fixed at 64 px and only x shrinks. Each level is built by box-downsampling four tiles of the level below in x, plus a 1/4 y-resize only from L2→L3.
- **Level choice**: `L = clamp(floor(log4(1/scale)), 0, 9)`. Draw with **trilinear-style blending**: cross-fade between L and L+1 over the last quarter of each step, so zooming never "pops".
- **The live tip** (the unfinished last tile of each level) is built from what exists, cached `max-age=60`, and overwritten on each rebuild. Finished tiles are `immutable`.
- **Colour summary (optional)**: a per-day 1-px-tall average-colour strip (`meta/colors/<day>.webp`, 1 px per 64 strips) for an instant first paint at "All" before any tile arrives.

### Client tile strategy

- **Visible set**: the visible range at level L, ±1 tile of prefetch in the direction of motion (or ±2 while flinging), plus the parent level always.
- **Decoding**: `fetch` → `createImageBitmap` (decoded off the main thread). There is an LRU of decoded bitmaps capped by bytes: ~96 MB desktop, ~48 MB mobile, ~24 MB in low-power. Bitmaps are closed on eviction.
- **Fallback**: draw the nearest loaded ancestor scaled up, then the target tile fades in over 150 ms. There are never holes.
- **Concurrency**: at most 6 fetches in flight, with priority to the centre outward. Requests for tiles that left the view are aborted (`AbortController`).
- **Rendering**: WebGL2 (one textured quad per tile; an atlas isn't needed at this count), with Canvas2D as the fallback. Overlap tiles by 1 px to avoid seams at fractional scales.

## 5b. Landmarks

Markers on the line. Each has a **minimum zoom** at which it appears, and labels collide-and-hide by priority (a higher priority wins when two overlap; the rest collapse into a "+3" cluster).

| Kind | Example | Source | Shows from |
|---|---|---|---|
| **Era** | "OG era (SD1.5)", "Klein tests", "SDXL launch · Oct 13" | era table (§5c) | All (always) |
| **Release** | "v1.0 · Oct 14 1:02 AM", "v1.1" | git tags → `landmarks.json` (CI step on tag) | All/Week |
| **Milestone** | strip #1, #10k, #50k, #100k… (and "1 million strips") | computed from counts | Week |
| **Busiest hour** | "Busiest hour: Oct 14 9–10 PM · 41 ideas" (per day and all-time) | ideas + viewer peaks per hour | Day (per day) / All (all-time top 3) |
| **Notable ideas** | the most-reacted user ideas per day (titles only, "Someone" for the owner) | reactions + votes (existing `strip_reactions`) | Day / Hour |
| **Long stories** | an Auto story arc spanning many scenes | `stories` table | Day |
| **Downtime** | "GPU off 2 h 10 m" | gaps in `created_at` | Day / Hour |
| **Personal** (later) | "your idea" markers for the signed-in user | the user's own ideas | Day |

- **Style**: era bands are tinted backgrounds behind the line. The others are thin ticks with small labels above the ruler. Tapping a landmark flies to it and opens its card.
- **`landmarks.json`** lives on R2 (global, small) and is rebuilt hourly by the meta writer. Releases and eras can also be hand-edited from the admin (a "Landmarks" list) for curation.

## 5c. Older eras: data formats and normalisation

The OG era predates today's storage layout, so the backfill must normalise it.

- **Sessions and prefixes**: each era is a `strips.session` value / storage prefix (e.g. `live` for SD1.5, `live-sdxl` for SDXL). An `eras` table/JSON lists `{id, session, label, model, strip_width, height, ext, first_idx, last_idx, t0, t1}`. It's built by scanning sessions once, then curated by hand.
- **Geometry**: SD1.5 strips were 128 px wide and 512 tall (config defaults), SDXL is 256x1024. The **pyramid normalises everything to the same tile geometry**: older strips are upscaled 2x in y for L1 and placed at their true relative width (or normalised to a common "strip unit", an open question). From L3 down everything is a 64-px-tall ribbon, so era differences vanish when zoomed out.
- **Formats**: JPEG (older) vs WebP, Supabase Storage vs R2, and possibly missing `scene` jsonb or `created_at` precision on early rows. The backfill reads from whichever store has the file (the existing `storagePrefixes()` fallback), re-encodes into the lod2 pyramid on R2, and records any **missing strips** as gaps (drawn as a dark notch, never a crash).
- **Metadata**: early rows may lack `scene`. Fall back to the `prompt` column (truncated, moderated) as the label, or "untitled" if it's empty.
- **One-off backfill job**: resumable and idempotent (skips existing tiles), runs on the pod's CPU thread or on the box. It also writes the era table and the first `landmarks.json`.

## 5d. Recommendation: should the newest content be included?

**Recommendation: include it up to a short delay (≈ 2–5 minutes behind live), with a clear "Jump to live →" exit at the right end.**

| | Include with a short delay (recommended) | Stop at end of the previous day / hour | Fully live edge |
|---|---|---|---|
| Pros | Feels current ("history up to a few minutes ago"); the right end connects naturally to the live viewer; the cost is small since tiles are finished and cacheable; no pod/WebSocket dependency | Simplest caching (everything immutable); no tip churn | Most "complete" |
| Cons | The last tile at each level churns (short 60 s cache, rebuilt ≤ every 30 s); needs a moving "end" marker | Feels stale (today missing); confusing next to a live site | Duplicates the live viewer; needs the pod's live clock; unfinished pixels at the tip; the most cost and complexity |

The delay means the Time Machine only ever shows **finished, published** strips and tiles. The right end shows a soft "Now · painting live" marker that opens the live viewer. Within the Time Machine, the end simply grows every few minutes.

## 6. Performance and throttle-proofing (same rules as the viewer fixes in c2a3ba0)

- **Time-based motion**: all camera motion (pan inertia, zoom springs, fly-to) integrates on `dt` from `performance.now()`, clamped at 100 ms. Fly-tos are parameterised by elapsed time, not frame count.
- **One rAF loop** that **sleeps when idle**: no rAF while the camera is still and nothing is fading, and it wakes on input. There is no `setInterval` in the render path.
- **Labels**: ruler ticks and lane chips are recomputed at most 10x/s and only when the camera moved more than 0.5 px. Chips are a pooled set of absolutely positioned elements moved with `transform` only, with no per-frame layout.
- **Gestures**: `pointer` events with `touch-action: none` on the band only, so page scroll elsewhere is native. Wheel deltas are normalised by `deltaMode`. Pinch uses the focal point, and zoom velocity carries on release.
- **Low power** (`body.lowpower`, the battery/data-saver flag from 2390b6b): DPR 1, prefetch ±0, a smaller LRU, and no level cross-fade.
- **`prefers-reduced-motion`**: fly-tos become a 200 ms cross-fade cut, and momentum is off.
- **Budgets**: first paint at "All" < 1 s on 4G (colour summary + ≤ 4 tiles). Steady state ≤ 2 ms main thread/frame on a mid phone, and no long tasks > 50 ms.

## 7. Backend: precompute, storage, cost

### Metadata on R2 (`<prefix>/meta/`)

- `days.json`: `[{day, a, b, t0, t1, scenes, ideas, gaps:[[idx,t_off,t_on]]}]` for every day in UTC, with the client converting to local time. Rewritten every 5 min (small: ~120 bytes/day).
- `day/<YYYY-MM-DD>.json`: `times` (idx,t every 64 strips, ~550 pairs), `scenes` (runs `[a,b,title,origin]`), `ideas` (`[a,b,text]` moderated; handle shown only as v2 does today, "Someone" for the owner). Finished days are immutable; today's file is rewritten every 5 min.
- `scenes/<YYYY-MM>.json`: a flat month list of scene starts for fast ◀/▶ stepping across day boundaries.

**Who writes them:** the pod's existing LOD thread (CPU only, `nice`, never blocks generation), from its local meta. A Vercel cron can rebuild from Supabase if the pod is off. Moderation: hiding or rejecting an idea triggers a rewrite of that day's file and a CDN purge (an admin action hook).

### Database

- `create index strips_created on public.strips (session, created_at)` for date jumps and the cron rebuild.
- Stop full scans: `/api/about?kind=history` reads `days.json` instead (v2 keeps working during the migration).

### Storage and cost (R2, $0.015/GB-month, class A writes $4.50/M, zero egress)

- **Pyramid per year of history**: L1 ~36 GB, L2 ~2.8 GB, L3–9 < 1 GB, so **≈ 40 GB/year ≈ $0.60/month** per year of history kept.
- **Writes** ≈ 1.05M tiles/year ≈ **$4.7/year**. Metadata is negligible.
- **For comparison**, the strips themselves are ~750 GB/year (~$11/month), and that cost exists already.
- **CPU**: building L1 from 16 strips takes ~150 ms, and higher levels ~20 ms each; one background thread on the pod is enough (it's at ~2.4 of 256 cores).
- **Backfill** of the 57k existing strips ≈ 4k tiles: minutes, run as a one-off script with resume.
- **Vercel**: only the `/api/tm/*` JSON is cached at the edge (s-maxage 60–300). Images never hit functions.

## 8. API endpoints (all read-only, CDN cached, never the GPU)

| Endpoint | Returns | Cache |
|---|---|---|
| `GET /api/tm/days` | `days.json` (proxied from R2 with an edge cache, or a redirect) | s-maxage 300 |
| `GET /api/tm/day?d=YYYY-MM-DD&tz=` | that day's meta | finished days: immutable; today: 60 s |
| `GET /api/tm/at?t=<iso>` | `{idx}`, the first strip at/after t (uses the new `created_at` index) | 3600 s |
| `GET /api/tm/scenes?from=<idx>&dir=next|prev&ideas=1` | the next/previous scene or idea start | 60 s |
| Tiles | `https://<r2>/live-sdxl/lod2/<L>/<c>.webp` direct | immutable, except live-tip tiles at 60 s |

## 9. Phases (rough effort, one engineer)

1. **P0, data foundation (1.5–2 d)**: the `created_at` index; the **era table** (scan sessions, curate); the meta writer (days/day/scenes JSON across eras) on the pod plus a cron fallback; `/api/tm/*`; switch v2's history call to `days.json` (an immediate 3.9 s → <100 ms win).
2. **P1, pyramid v2 + OG-era backfill (2.5–3.5 d)**: L1–L9 anisotropic WebP on R2; geometry/format normalisation for older eras (128x512 JPEG → common tiles); a resumable backfill with gap recording; live-tip handling (short delay); a moderation purge hook.
3. **P2, immersive renderer (3.5–4.5 d)**: its own page bundle; camera in global history coordinates (era segments); LOD selection, bitmap LRU, parent fallback and level cross-fade; gestures (drag, flick, pinch, trackpad, wheel, keys); time-based motion; in-Time-Machine "drift" playback at strip scale; low-power path.
4. **P3, navigation + landmarks (2.5–3.5 d)**: adaptive ruler with era bands; date jump; scene/idea lane with clustering and ◀/▶; the landmark layer (eras, releases, milestones, busiest hours, notable ideas, downtime) with collision/priority; `landmarks.json` builder + admin curation; "Now / Jump to live" exit; calendar slide-over; deep links `/time-machine?at=<era>:<idx>&z=L`.
5. **P4, hardening (1–1.5 d)**: tests at 6x CPU, a 30 fps cap and background-tab clamping, the iOS memory ceiling, pod-off mode, a11y, and INP budgets.

**Total ≈ 11–15 days** (up from 9–12 because of the OG-era backfill, the landmarks and the standalone viewer). P0 alone is worth shipping first.

## 10. Risks

- **Index vs time**: GPU downtime and pace changes make the time ruler non-linear. The gap notches and a "time-proportional" toggle address it later.
- **OG-era data**: different geometry/format/storage and possibly missing metadata or strips. Handled by the normalising backfill (§5c), with gaps drawn, not crashed on.
- **Live tip churn**: the last tile at each level changes constantly. Short-cache it and rebuild it at most every 30 s.
- **Moderation lag**: removed ideas must vanish from immutable day files. The purge hook covers this (or don't mark day files immutable until 24 h old).
- **Mobile memory**: iOS kills tabs above ~300–400 MB of decoded images. Keep the LRU byte cap and close bitmaps.
- **Gesture conflicts**: Safari pinch on desktop (`gesture*`) vs Chrome (`ctrlKey` wheel); trackpad inertia vs our momentum (don't double-apply, same as the viewer's wheel glide).
- **Seams and colour**: JPEG/WebP edges at fractional scales get a 1 px overlap and a premultiplied edge clamp.
- **Pod coupling**: the meta writer runs on the pod, but the cron fallback keeps the Time Machine current when it's off.

## 11. Open questions

Decided: start from the very beginning (all eras); a separate immersive viewer; newest content included up to a short delay with a "Jump to live" exit (recommendation, pending the user's OK).

1. **Era widths**: show older strips at their true relative width (SD1.5 strips are half as wide), or normalise every strip to one unit so each era's length reflects strip count?
2. Is index-space plus downtime notches enough, or do they also want a clock-time-proportional mode?
3. Retention: keep full-res L1 tiles forever for every era (≈90% of pyramid storage), or only L2+ for months older than N?
4. Should the scene/idea lane show submitter handles as v2 does, or titles only (as embeds)?
5. Which landmarks should be hand-curated (e.g. named moments) vs fully automatic?
