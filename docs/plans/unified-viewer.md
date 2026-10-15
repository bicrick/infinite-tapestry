# Unified viewer: live + Time Machine on one page (PLAN)

Status: plan only, 2026-10-14. Builds on `time-machine-v3.md` (tm-lab: tile pyramid, index, landmarks) and the live
viewer (`static/client.js`, ~1,760 lines). Nothing here is built yet.

## Vision (user)

One page, one URL. Fully zoomed in it **is** today's live viewer: prompting, chat, HUD, arrow-key flying, live pacing,
idle ribbon, all unchanged. Zoom out and the same picture continuously becomes the Time Machine line (thin true-aspect
line, shared reflection, event toggles). Zooming back in lands you in the live viewer at that moment. Neither UI's
design changes; only the seam between them disappears.

| Input | Desktop | Mobile |
|---|---|---|
| Scrub time | scroll wheel / two-finger horizontal swipe | one-finger swipe |
| Zoom | shift+scroll, trackpad pinch (ctrl+wheel), +/- keys | pinch |
| Fly | held ←/→ (existing physics) | — |

## Key decisions (recommended)

1. **One world coordinate, two renderers, one camera.** Keep the live renderer (client.js 2D canvas + strips +
   shared `refl.js`) exactly as it is for zoom ≥ the live scale, and the tm-lab WebGL renderer for zoom below it.
   Both read the same camera `{g (global strip unit, float64), z (log zoom)}`. During a short crossover band
   (≈ 0.5×–1× of live scale) both draw, and the live canvas fades out over the WebGL one; above it only the live
   renderer runs, below it only the timeline. *Not* a single rewritten renderer: rewriting client.js's live path
   (stream buffer, crossfades, pacing, LOD underlay, motion blur, intro) into WebGL is the biggest risk and would
   change the live look. Revisit once the handoff is proven.
2. **Global unit = era g0 + idx** (already in `/api/about?kind=tm`). The live viewer's strip index is SDXL idx, so
   `g = 1269 + idx` today; the mapping lives in one helper so a future era changes nothing else.
3. **The right edge is the live stream.** The pyramid ends where tiles exist; the live viewer's in-memory strips
   (WebSocket stream + `/api/live` backfill) cover the tail. At timeline zoom, the newest ~N strips not yet in the
   pyramid are drawn from the live strip bitmaps (downscaled once into a small "tip atlas" texture, 64 px/unit),
   so the line always reaches *now* and grows live while you watch.
4. **URL is the state.** `?t=<ISO or strip>&z=<zoom>` (plus existing `?at=`/`&to=` permalinks kept as aliases).
   No `t` = live. No `z` = live zoom. `history.replaceState` while moving (throttled ~4 Hz), `pushState` only on
   deliberate jumps (calendar, step, share). Idea share links become `?t=<start strip>&z=1`.
5. **Live features only exist at live zoom.** Composer, chat, viewer count, "Back to live" stay mounted but are
   hidden/inert below the crossover (opacity + `inert`), so their DOM and sockets never restart.

## Architecture

```
            camera {g, z, mode: live|history|play}  (single source of truth; URL <-> camera)
             /                                    \
   live renderer (client.js)                  timeline renderer (tm-lab core, WebGL1)
   z >= Zx: strips, crossfades,              z < Zx: pyramid tiles L1..L7, full-res strips,
   pacing, motion blur, HUD                  tip atlas from live strips, landmarks layer
             \                                    /
          shared: refl.js reflection, theme.js, header chrome, strip cache (bitmaps), time index
```

- **Extraction first.** tm-lab.js becomes `timeline.js` exposing `{mount(canvas), setCamera(g, z), draw(),
  setTip(bitmaps), destroy()}`; landmarks/menu UI stays separate. client.js gains a tiny camera adapter:
  `TapestryView.camera()` / `setCamera()` mapping its `panPos/liveScroll/zoom` to `{g, z}`. No behaviour change.
- **Strip cache shared.** The live viewer already holds decoded bitmaps of nearby strips; the timeline's L0
  (full-res strips) reads them instead of refetching. One LRU, one memory budget.
- **Reflection.** Already shared (`static/refl.js`). In the crossover both renderers feed the *same* reflection
  instance from whichever canvas is on top (it samples its source canvas each frame).

## Zoom model

- `z = log2(px per unit / live px per unit)`. `z = 0` live; `z < 0` out; `z > 0` not allowed (live is max) except
  the existing small "breathe" zoom.
- Band height: live keeps its band/ribbon geometry; timeline uses true aspect (4 × px per unit). At the crossover
  the two heights are equal by construction (live band = 4 × live unit width), so the shape is continuous; only
  the vertical position eases from the live band top (`bandTopFor`) to the timeline line centre.
- Zoom anchor = pointer (desktop) or pinch midpoint; keyboard zoom anchors at the needle (centre).

## Live strip stream ↔ pyramid at the right edge

- Pyramid built up to `manifest.units` (cron, every 5 min once R2 secrets exist; today manual).
- Tip = `(manifest.units, liveMax]`, typically 50–300 strips. Drawn from the live viewer's bitmaps when zoomed
  in, and from the tip atlas (incrementally appended as strips land, ~64 px/unit, one 2048×256 texture ring) when
  zoomed out. Older than the atlas holds → fall back to `/api/live` thumbnails or a dark gap with a "catching up"
  tick.
- "Latest →" in the timeline becomes simply "zoom in at the live edge" = rejoin live.

## Existing features

| Feature | In the unified page |
|---|---|
| Arrow-key flying | Unchanged at live zoom. When zoomed out, ←/→ pan at a speed proportional to view width (same physics constants, scaled by 2^-z). |
| Live pacing (server buffer, speed) | Untouched; the camera only *reads* live position. Leaving live (any scrub/zoom) is the existing `enterHistory()`. |
| Back to live pill | Unchanged; also shown in timeline mode as "Live →" (zooms in to the live edge). |
| Time Machine replay (`?at=`) | `?at=` maps to `?t=` with `z=0`; replay = "Play here" in timeline, or live-viewer history mode at z=0. One implementation: the live viewer's history playback. |
| Idle ribbon / screensaver | Only at live zoom. Zooming out cancels idle; the timeline has its own render-on-demand idle. |
| Calendar / prompt stepping / events | Timeline menu, only visible at z < crossover. |
| Classic `/time-machine` | Kept until the unified page ships, then redirects to `/?z=<day zoom>&t=<day>`. |

## Input conflicts (honest list)

1. **Shift+scroll is taken today**: client.js treats shift+wheel as horizontal scrub (for mice without a
   horizontal wheel). Proposal: shift+wheel = zoom (user's ask), plain vertical wheel = scrub (already),
   horizontal deltaX = scrub (trackpads), ctrl+wheel (trackpad pinch) = zoom. Mouse users lose shift-as-horizontal,
   which plain vertical wheel already covers. Needs one release note.
2. **ctrl+wheel is ignored today** (`if (ev.ctrlKey) return;` so browser zoom doesn't fire). We take it for zoom and
   `preventDefault` it on the canvas only.
3. **iOS momentum**: one-finger swipe already drives the haptic dial (`wheelStart/Move/End`). Pinch currently
   cancels an uncommitted scrub. New rule: 2 fingers = zoom (with simultaneous pan from the midpoint), 1 finger =
   scrub; a pinch that starts during a glide stops the glide. Safari page-zoom must stay disabled on the canvas
   (`touch-action: none` there, already) but not on the composer/chat (text zoom accessibility).
4. **Trackpad inertia vs zoom**: macOS sends momentum wheel events after a pinch ends; ignore wheel for ~120 ms after
   a gesture end and treat `ctrlKey` momentum as zoom only.
5. **Keyboard**: +/- zoom must not fire while typing in the composer/chat (existing input-focus guard).
6. **Native horizontal page scroll**: the live page has no document scroll (overflow hidden); unchanged.

## State model

```
camera  { g: float64, z: float, vg, vz }        // velocities for glide/zoom springs, time-based
mode    live | history | play | fly             // existing client.js panMode, extended with "timeline" sub-state by z
layers  liveOpacity = smoothstep(Zx-0.5, Zx, z) // crossover band
url     derived from camera (throttled), parsed once on load + popstate
```
All motion stays time-based (dt-scaled, clamped), already true in both codebases; no frame-count timers.

## Perf budget and throttled browsers

- Target 60 fps desktop/mobile; ≥ 50 fps at 6× CPU throttle; Mac Low Power Mode (rAF capped at 30) must stay
  correct-speed (time-based) and never lose input.
- Only one renderer active outside the crossover band; in the band both draw, so the band is short (≈ 0.25 s of a
  typical zoom gesture) and the live renderer drops motion blur there.
- Memory: one shared strip LRU (≤ 96 MB textures/bitmaps), pyramid textures ≤ 64 MB.
- Governor (already in tm-lab): drops render scale to 1× then 0.75× when motion can't hold ~45 fps; extend it to
  the live canvas in the crossover.
- Measured today (tm-lab, software GL, this box): 52–60 fps mobile at 4×/6×, 51–60 desktop at 4×/6× with the
  reflection. Live viewer numbers must be re-measured with the camera adapter in place (phase 1 gate).

## Phases (honest effort; 1 dev-day = focused agent day incl. testing on prod)

| # | Phase | Ships | Effort |
|---|---|---|---|
| 0 | Prereqs: R2 secrets in GitHub (tile cron), R2 custom domain (r2.dev is rate-limited), re-tile OG era + tip with the viewer-correct composition | infra | 0.5 d + user action |
| 1 | Extract timeline core (`timeline.js`) from tm-lab; camera adapter in client.js (`camera()/setCamera()`), no behaviour change; perf re-measure of live viewer | refactor, invisible | 2–3 d |
| 2 | Unified page behind `?unified=1`: mount timeline under the live canvas, crossover fade, vertical position easing, shared reflection source switch | flag | 3–4 d |
| 3 | Input: shift/ctrl+wheel zoom, pinch zoom on mobile, keyboard +/-, arrow flying scaled by zoom; conflict rules above; momentum filtering | flag | 2–3 d |
| 4 | Right edge: tip atlas from live strips, shared strip LRU, "Live →" = zoom in at edge | flag | 2 d |
| 5 | URL/deep links: `?t&z`, `?at` alias, idea share links, pushState/replaceState, popstate | flag | 1–1.5 d |
| 6 | Live UI gating by zoom (composer/chat/HUD inert below crossover, idle/screensaver only at live zoom), timeline menu only when zoomed out | flag | 1.5–2 d |
| 7 | Hardening: real-device passes (iPhone Safari, Android Chrome, Mac LPM), a11y (focus, reduced motion = no crossfade motion), perf gates at 4×/6×, analytics | flag | 2–3 d |
| 8 | Launch: default on, `/time-machine` → redirect, remove flag after a week | release | 0.5–1 d |

**Total ≈ 15–20 dev-days** after phase 0, plus user review between phases. Phases 1–2 are the de-risking gate:
if the crossover can't hold 50 fps at 6× on a phone, fall back to a hard cut (snap) at the crossover with a 150 ms
fade, which is ~3 d cheaper.

## Risks

- **client.js coupling** (largest): panMode/liveScroll/nudge/ribbon/zoom springs interact; a camera adapter that
  misreads one of them breaks live pacing or "Back to live". Mitigation: adapter is read-mostly; writes go through
  existing entry points (`enterHistory`, `seek`, `wheelStart/Move/End`); e2e checks on prod for live pacing.
- **Two renderers in the crossover** double fill-rate on weak phones; mitigated by short band + governor; fallback
  is a hard cut.
- **Live band vs timeline geometry mismatch** (ribbon mode on desktop is 0.6× height and offset): the crossover
  must morph ribbon → line; needs design review of the in-between frames.
- **Tile freshness**: without R2 secrets the pyramid stops; the tip atlas hides up to a few hundred strips, beyond
  that you see a gap. Phase 0 is a hard prerequisite for launch.
- **Gesture regressions on iOS** (momentum + pinch + composer text zoom) are hard to test headless; need real
  devices.
- **Effort creep**: chat/composer/screensaver each have edge cases tied to "being live".

## Open questions

1. Crossover zoom: where exactly does "live" end, at the live viewer's current scale or one notch out (so the
   live band can still breathe)? Recommendation: crossover at 0.5×–1× live scale.
2. Should leaving live by zooming out keep the server-side live pacing untouched (yes, recommended) and show
   "Live →" immediately?
3. Desktop ribbon mode: morph ribbon → thin line, or first expand to the full band then thin out?
4. Shift+wheel repurpose: OK to drop shift-as-horizontal-scrub for mouse users?
5. Events toggles: keep them off by default in the unified page too (as in tm-lab now)?
6. Do idea share links open at z=0 (live viewer look at that moment, recommended) or slightly zoomed out with the
   idea's span highlighted?
