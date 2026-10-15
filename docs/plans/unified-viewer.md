# Unified viewer: live + Time Machine on one page (PLAN, for approval)

Status: plan only, 2026-10-14. Nothing here is built. It builds on `time-machine-v3.md` (tm-lab: tile pyramid,
history index, landmarks, shared `static/refl.js`) and on the live viewer (`static/client.js`, about 1,760 lines).
Data jobs already moved to a Vercel cron (`/api/tm`, every 5 min). The cron folds new strips into the index and
extends the tile pyramid, with no GitHub Actions and no new secrets.

## 1. Goals and non-goals

**Goals**
- One page and one URL (`/`). Fully zoomed in, it **is** today's live viewer: prompting, chat, HUD, arrow-key
  flying, live pacing, idle ribbon and screensaver all stay the same. Zoom out and the same picture turns
  continuously into the Time Machine line (thin, true-aspect, with the shared reflection and event toggles). Zoom
  back in anywhere and you are in the viewer at that moment.
- Scrub with the scroll wheel or a swipe, zoom with shift+scroll, pinch or ctrl+wheel. Desktop and mobile feel the same.
- Deep links (`?t=…&z=…`) open at a given spot and zoom. Idea share links land there.
- Performance first: 60 fps target, still correct and usable when throttled (Mac Low Power Mode, 6× CPU).

**Non-goals (v1)**
- No redesign of either UI. No rewrite of the live renderer into WebGL. No change to the server's live pacing.
- No prompting from history: the composer works only at the live edge, as it does today.

## 2. UX spec per zoom level

`z = log2(px per unit ÷ live px per unit)`: z = 0 is the live viewer and negative values are zoomed out. One
unit is one strip (every era has equal width).

| Band | z | What you see | Chrome |
|---|---|---|---|
| **Live** | 0 (±0.15 breathe) | Today's viewer, unchanged (band or ribbon, reflection, HUD, composer, chat, viewer count) | Live UI |
| **Crossover** | −0.15 … −1 | The live band shrinks to the true-aspect line. Its vertical position eases from the live band to the line centre. The live canvas fades out over the WebGL line, both drawing the same pixels. Composer and chat fade and become `inert` | Live UI fades out, "Live →" pill fades in |
| **Strips** | −1 … −3 | Individual strips at full resolution (L0), scene titles above runs | Timeline HUD: time needle, date/time, Play here, ⏮/⏭ prompt step |
| **Hours** | −3 … −7 | L1–L3 tiles; hour ticks; (opt-in) idea/notable markers | + calendar in the menu |
| **Days/months** | −7 … −12 | L4–L6; day/month ticks; (opt-in) busiest hours, milestones, downtime notches | same |
| **All time** | −12 … min | L7; whole history from the first OG strip to now; (opt-in) eras and releases | same |

- **Transitions**: one continuous camera, with no mode switches visible to the user. Zoom is anchored at the
  pointer, the pinch midpoint, or the needle (keyboard). Level-of-detail swaps cross-fade over 150 ms, and the
  parent tile shows until the child is ready (as in tm-lab).
- **Leaving live**: any scrub or zoom-out calls the existing `enterHistory()`, and "Back to live" appears as today.
- **Rejoining live**: "Live →", or zooming in at the right edge, or scrubbing past the newest strip. Each eases
  back to z = 0 at the live edge and resumes live pacing.
- **Events/landmarks**: off by default and turned on per category in the menu. The choice is remembered locally,
  the same as tm-lab today.
- **Reduced motion**: zoom jumps go straight between bands with a 120 ms opacity fade and no camera tween.
  Autoplay/glide is off.

## 3. Input map

| Action | Desktop mouse | Desktop trackpad | Mobile | Keyboard |
|---|---|---|---|---|
| Scrub time | vertical wheel | two-finger horizontal | one-finger swipe (existing dial and momentum) | ←/→ hold = existing flying (scaled by 2^−z when zoomed out) |
| Zoom | **shift+wheel** | pinch (ctrl+wheel) | pinch (centred on midpoint, with simultaneous pan) | `+` / `−`, `0` = back to live |
| Jump | double-click: zoom in 2 steps | same | double-tap: zoom in 2 steps | `Home` = first strip, `End` = live |
| Step prompts | — | — | — | `[` / `]` (in timeline bands) |
| Play here | click the HUD button | same | tap | `Space` (timeline bands; inert while typing) |

Conflict rules:
1. Shift+wheel is horizontal scrub today and becomes zoom. The plain vertical wheel already scrubs, so mouse
   users lose nothing. This needs a one-line release note.
2. ctrl+wheel is ignored today so that browser zoom does not fire. Over the canvas only, we take it with
   `preventDefault`.
3. macOS momentum after a pinch: wheel events are ignored for 120 ms after a gesture ends, and ctrl momentum
   counts only as zoom.
4. iOS: one finger scrubs and two fingers zoom. A pinch that starts mid-glide stops the glide.
   `touch-action: none` applies only on the canvas, never on the composer or chat, so text zoom still works there.
5. Every key binding uses the existing input-focus guard, so nothing fires while typing.

## 4. URL and deep-link scheme

- `/` = live. `/?t=<t>&z=<z>` = an exact spot. `t` is an ISO time (`2026-10-14T21:05Z`) or `s<g>` for a global
  strip (`s61234`). `z` is a float rounded to 0.25. If `t` is missing, the view is live. If `z` is missing, z = 0.
- Optional `&e=ideas,milestones` turns on event categories for that link only (it does not override the stored choice).
- Aliases kept forever: `?at=<sdxl idx>&to=` → `?t=s<1269+idx>&z=0` (old permalinks and Time Machine replays).
  `/time-machine` → `/?z=-9&t=<today>` after launch.
- Idea share links: `?t=s<start>&z=0`, opening at the idea's first strip in the live look with history playback
  armed. The OG card stays the same.
- While moving, `history.replaceState` runs at about 4 Hz. Deliberate jumps (calendar, prompt step, share, Live)
  use `pushState`, so Back returns to where you were. `popstate` animates the camera.

## 5. Architecture

```
                  Camera { g: float64 unit, z, vg, vz, mode }  <->  URL
                 /                                           \
  live renderer (client.js, 2D canvas)              timeline renderer (timeline.js, WebGL)
  z >= -1: stream strips, crossfades, pacing,       z <= -0.15: pyramid L1..L7, full-res L0,
  motion blur, HUD, composer, chat                  tip atlas, landmarks layer, needle HUD
                 \                                           /
     shared: refl.js reflection · theme.js · header chrome · strip bitmap LRU · time index (/api/about?kind=tm)
```

Decision: **two renderers and one camera**, with a short crossover where both draw. The alternative, one WebGL
renderer for everything, would mean rewriting the live path (stream buffer, crossfades, pacing, LOD underlay,
motion blur, intro). That is the riskiest work and it would change the live look. Revisit only after launch.

- `timeline.js` is extracted from tm-lab.js with the API `mount(canvas)`, `setCamera(g, z)`, `draw(dt)`,
  `setTip(bitmaps)`, `destroy()`. The menu and landmark UI stay in a separate module.
- client.js gets a camera adapter: `TapestryView.camera()` reads `{g, z}` from `panPos/liveScroll/zoom`.
  `setCamera()` writes only through existing entry points (`enterHistory`, `seek`, `wheelStart/Move/End`).
- The reflection is already one module. In the crossover it samples whichever canvas is on top.

## 6. Data flow: live stream + tile pyramid

- **History**: the index (hour summaries, scenes, landmarks) and the tile pyramid live in Supabase Storage. A
  Vercel cron (`/api/tm?job=all`, every 5 min) builds them, and the CDN serves them through `/api/tm?tile=L/T`
  (immutable; the tip tile carries `&u=units`). The build is resumable and idempotent. Its cursor and lock are in
  the manifest.
- **The right edge is live.** The pyramid covers `[0, manifest.units)`. The tip `(manifest.units, liveMax]` is
  usually 5–15 minutes, or 50–300 strips. Zoomed in, the tip is drawn from the live viewer's own strip bitmaps.
  Zoomed out, it comes from a **tip atlas**: each live strip is downscaled once to 64 px/unit into a 2048×256
  texture ring as it arrives. So the line always reaches *now* and grows while you watch. If the tip ever exceeds
  the atlas (cron stalled), the next segment comes from `/api/live` thumbnails, and if that fails it shows as a
  dark gap with a "catching up" tick.
- **Full resolution** (z ≤ about −1): SDXL strips come from R2. OG strips come through `/api/about?kind=ogstrip`.
  Strips already decoded by the live viewer are reused from the shared LRU.

## 7. State machine

```
           scrub/zoom-out                       z < -0.15
  LIVE ───────────────────> HISTORY(z≈0) ───────────────────> TIMELINE(z<-0.15)
   ^  <── Back to live ───┘   │  ^  ←── z > -0.15 (zoom in) ──────┘ │
   │                          │  └── Play here / ?at= ──> PLAY ────┘ (play = history playback at z=0 or in place)
   └──── "Live →" / End / zoom-in at right edge / scrub past newest (eases to z=0 at liveMax) ────┘
  FLY (held arrows) is an overlay on LIVE/HISTORY/TIMELINE; idle/screensaver only from LIVE.
```

Layer opacity is `live = smoothstep(-1, -0.15, z)` and `timeline = 1 − live`. The live renderer stops drawing
when live = 0, and the timeline stops when timeline = 0. All motion is time-based (dt-scaled and clamped). No
frame-count or timer-paced logic is allowed.

## 8. Performance budget and throttled plan

| Budget | Target |
|---|---|
| Frame | 60 fps desktop and mobile; ≥ 50 fps at 6× CPU; correct speed at a 30 fps rAF cap (Low Power Mode) |
| Main thread per frame | ≤ 6 ms JS; texture upload ≤ 4 ms/frame (budgeted queue); decode always off-thread (worker `createImageBitmap`) |
| Memory | strip bitmap LRU ≤ 96 MB; pyramid textures ≤ 64 MB; tip atlas 2 MB |
| Network | first paint of any band ≤ 6 tiles; tiles are 8–80 KB WebP, CDN-immutable |
| Crossover | both renderers draw only in the crossover band; motion blur is off there |
| Reflection | the shared module is fed at about 30 Hz (already the case in tm-lab) |

Throttled plan: a quality governor (already in tm-lab) drops the render scale to 1× and then 0.75× when motion
cannot hold about 45 fps. When static, the page renders on demand (no rAF loop while idle). The idle timer
measures real time since the last input event and never fires on load. Fullscreen state comes from the
fullscreen API only. Current tm-lab numbers (software GL): 52–60 fps on mobile and 51–60 on desktop at 4×/6×
with the reflection on. The live viewer and the crossover must be measured again in phase 2. That is a gate.

## 9. Accessibility

- The canvas has `role="img"` with a live `aria-label` (for example "Oct 14, 9:05 PM, scene: …"). The time needle
  is an ARIA slider (`aria-valuetext` = time), so arrow keys and `Home`/`End` work.
- All controls (zoom ±, Live, Play, prompt step, menu, event toggles) are real buttons with focus rings, in a
  logical tab order. Composer and chat become `inert` when hidden.
- `prefers-reduced-motion`: no camera tweens, no glide, no reflection shimmer animation.
- Pinch-zoom on the page is still allowed outside the canvas. Text sizes follow the site's existing type scale,
  and contrast is checked in light and dark.

## 10. Migration, feature flag, rollback

- Flag: `?unified=1` (per session), then a localStorage opt-in, then a default-on server flag in `config.js`
  (`unified: true`).
- Old paths keep working throughout. `/time-machine` stays live until launch and then redirects. `?at=` permalinks
  never break.
- Rollback: flip `config.js unified:false` (one env change and a redeploy, about 2 min). The legacy code path stays
  in place for 2 weeks after launch before it is removed.
- Telemetry (no PII): fps buckets, governor steps, crossover count, deep-link opens. This uses the existing ops
  endpoint.

## 11. Phased milestones (honest effort; 1 dev-day = one focused agent day, including prod testing)

| # | Milestone | Ships | Effort |
|---|---|---|---|
| 0 | ✅ Data jobs on the Vercel cron; full pyramid rebuild running; R2 custom domain if r2.dev rate-limits | infra | done / 0.5 d |
| 1 | Extract `timeline.js`; client.js camera adapter (no behaviour change); measure the live viewer's perf again | invisible refactor | 2–3 d |
| 2 | `?unified=1`: timeline under the live canvas, crossover fade, vertical easing, reflection source switch; **perf gate** | flag | 3–4 d |
| 3 | Input map (§3), momentum filtering, flying scaled by zoom | flag | 2–3 d |
| 4 | Right edge: tip atlas, shared strip LRU, "Live →" | flag | 2 d |
| 5 | URL scheme, aliases, idea links, push/replaceState | flag | 1–1.5 d |
| 6 | Live UI gating by zoom, timeline HUD and menu only when zoomed out, idle only at live | flag | 1.5–2 d |
| 7 | Accessibility (§9), real-device passes, telemetry | flag | 2–3 d |
| 8 | Default on, redirect `/time-machine`, remove the flag after 2 weeks | release | 0.5–1 d |

**Total: about 15–20 dev-days.** User review comes after phases 2, 6 and 7. If phase 2 misses the perf gate, the
fallback is a hard cut at the crossover with a 150 ms fade, which saves about 3 days.

## 12. Test plan

- **Unit** (node): camera ↔ URL round-trip, `t` parsing (ISO and `s<g>`), alias mapping, unit ↔ time mapping
  across eras and gaps, level-of-detail level choice.
- **Headless e2e** (Playwright on prod or preview): load `/`, check the live viewer is unchanged (screenshot diff
  against baseline at 1280×800, 1024×590 and 390×844, light and dark). Zoom out through every band and check that
  no tile errors appear and that the needle time is right. Deep links land at the expected time. Back/forward work.
  "Live →" rejoins live and live pacing resumes (strip index advances at the live rate).
- **Perf gates**: Chrome trace at 1×, 4× and 6× CPU and a 30 fps cap, desktop and mobile. Pass means ≥ 50 fps
  median at 6× during pan, zoom and crossover, no frame over 50 ms after warm-up, and heap under budget.
- **Real devices**: iPhone Safari (pinch, momentum, composer text zoom), Android Chrome, Mac trackpad in Low
  Power Mode, mouse with shift+wheel.
- **Regression**: arrow flying, idle ribbon/screensaver, fullscreen, composer submit, chat and viewer count, all
  at z = 0.

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| client.js coupling (panMode, liveScroll, springs) | breaks live pacing or Back to live | read-mostly adapter; writes only through existing entry points; e2e on pacing |
| Two renderers in the crossover | fps dip on weak phones | short band, governor, hard-cut fallback |
| Desktop ribbon geometry ≠ timeline line | ugly in-between frames | design review of the morph in phase 2 |
| Pyramid falls behind (cron failure) | gap at the right edge | tip atlas covers hours; manifest `built` age alarm on the admin panel |
| iOS gesture edge cases | mis-zoom, stuck glide | real-device pass, conservative thresholds |
| Effort creep (chat/composer/screensaver "live-only" edge cases) | schedule | strict v1 non-goals |

## 14. Decisions needing approval

1. **Architecture**: two renderers with one camera and a crossover (recommended) vs one WebGL renderer (later, if ever).
2. **Shift+wheel → zoom** (drops shift-as-horizontal scrub for mouse users).
3. **Crossover band** at z −0.15 … −1 (live keeps a little breathe-room). The desktop ribbon morphs straight to the line.
4. **Leaving live by zooming out** leaves server pacing untouched and shows "Live →" at once.
5. **Events off by default** on the unified page too.
6. **Idea share links open at z = 0** (live look at that moment) rather than zoomed out with the span highlighted.
7. **URL format** `?t=<ISO|s<g>>&z=<z>`, with `?at=` kept as an alias and `/time-machine` redirecting at launch.
8. **Rollout**: flag → opt-in → default on, with a 2-week legacy fallback.
