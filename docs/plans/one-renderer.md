# One renderer, one camera, one UI (PLAN)

Status: phases 0-1 built on branch `one-renderer` (2026-10-15). Hidden page `/one-3c9d1f.html`. Supersedes `unified-viewer.md` (two renderers + crossover). Nothing here is built.
Base: `main` @ e0dd089 (low-res fallback + `TapestryTimeline.hasAnyTexture`). Grain = PR #91.

## 0. The idea in one paragraph

There is no "live view" and no "timeline view". There is one WebGL canvas, one tile pyramid whose deepest level is
the full-res strips, one camera `{centerTime, zoom, followLive}` driven by one critically damped spring, and one
HTML UI layer that is always on screen and reads the camera. "Live" = `followLive && zoom == 0`. Everything that
looks like a transition (bar → scrub controls, header, Grain bloom, reflection height) is a pure function of
`zoomProgress`, so it can never desync, flash, or snap.

## 1. Inventory of current code

| File / function | Today | Verdict |
|---|---|---|
| `static/client.js` (1,759 lines) — `frame`, `draw`, `drawLod*`, `lodTile`, `ensureDecoded`, `evictFar`, `requestMissing`, `stepPan`, `stepFly`, `rubber`, `seekTo`, `startReturn`, `enterHistory`, `commitRewind` | Live 2D canvas, own strip cache, own scroll loop, own pan physics | **Delete** the renderer/cache/scroll/pan parts (≈900 lines) once phase 3 lands |
| `client.js` — `wsUrl`, `send`, `onStripBinary`, `onStripRef`, `decodeStrip`, `onClock`, `credit`, `srcLabel`, `stageTitle`, `liveCaption`/`histCaption`, chat/compose/toast/speed/`setMode`, `TapestryOps` | Socket, protocol, captions, chat, composer | **Keep → move** into `live-ingest.js` (socket/protocol) and `ui/` (chat, composer, caption). `credit()` keeps returning "Auto" |
| `client.js` — `publishBand`, `drawSurround`, `scale`, `BAND_ASPECT`, portrait band math | Band geometry | **Adapt** into `camera.js` layout (`bandRect(zoom)`) |
| `static/unified.js` (628) — GL pipeline, worker `loadBitmap`, `want`, `flushUploads`, `levelFor`, `stripUrl`, `tilesAt`, `draw`, `trueGaps`, `hourAt/unitTime/timeUnit/rateAt`, `hasAnyTexture` | Timeline tile renderer | **Keep, extract** into `tile-store.js` + `renderer.js`. This is the core |
| `unified.js` — `cam {cx,s,tcx,ts,vx}`, `zoomAt`, `scheduleSnap/snap/detents/stepDetent`, `step`, `kick`, `writeUrl/urlSoon` | Timeline camera | **Adapt** into `camera.js` (spring replaces ad-hoc lerps; detents stay only as "magnet to live") |
| `unified.js` — `enterTimeline`, `toLive`, `takeSnap`, `setTimelineUi`, `readLive`, `mode` | Handoff between the two renderers | **Delete** (root cause of flash/snap-back/black bars) |
| `unified.js` — `hud`, `regroup`, `placeMarks`, `buildCalendar`, `setPlay`, `stepPrompt`, `theme`, `?perf` overlay | Timeline HUD | **Adapt** into `ui/` modules; `?perf` overlay kept and extended |
| `static/refl.js` — `create(canvas, opts)`, `frame(V,…)` | Second WebGL2 canvas, 128×16 thumbnail | **Adapt** into `passes/reflection.js` on the same GL context (reads a downsampled FBO of the frame instead of `drawImage` from a 2D canvas) |
| `static/intro.js` — `introFrame`, `worldLeft`, `measureLevels`, `waitForPixels`, `startReveal`, `finish` | Stipple intro over the live canvas | **Adapt**: becomes "Grain everywhere at t=0, tiles resolve in" on the one renderer; skipped on deep links. `intro-levels.js` kept |
| `static/stipple-hook.js`, PR #91 `stipple-fill.js` (`createRenderer(gl)`), `stipple-slots.js` | Grain placeholders | **Keep** (UI Tapestry); wired as a pass driven by tile state (§3.6) |
| `static/mobile.js` (207) | Viewport/keyboard fixes, share | **Keep** |
| `static/u.css`, `scripts/unified_overlay.html` | Timeline pill, own Live button | **Delete** the pill/Live styles; overlay shrinks to the shared bar slots |
| `scripts/make_unified.js` | Build-time splice of overlay into `index.html`, `SWAP`, `classic-7f3e21.html` | **Keep** for rollout (§6); deleted after phase 5 when `index.html` is authored directly |
| `static/time-machine.*`, `tm-lab.*` | Older TM pages | Leave; delete after phase 5 |
| `scripts/tm/build_pyramid.py`, `build_index.js`, `web/api/tm.js` (cron `*/5`) | Index + pyramid L1–L7 (L1 64 px/unit 1024×256; L2+ h 64) to storage (R2 public bucket; Supabase for index) | **Keep**, small additions (§4) |
| `web/api/live.js` | Names current RunPod pod | Keep |

## 2. Target architecture

```
static/one/
  camera.js        spring camera, input → target, URL sync
  tile-store.js    pyramid metadata, fetch queue, worker decode, GPU budget, per-tile state
  live-ingest.js   websocket (from client.js), pushes strips into tile-store level 0
  renderer.js      one WebGL2 context (WebGL1 fallback), frame loop, pass list
  passes/          tiles.js  head.js (crystallizing edge)  reflection.js  glow.js  grain.js (#91)
  ui/              layer.js caption.js bar.js chat.js composer.js clock.js hints.js events.js
  main.js          wiring, intro, deep links, embed mode
```
Classic scripts, no bundler (as today); each file is an IIFE exporting onto `window.Tapestry.*`.

### 2.1 Camera (`Tapestry.camera`)
```js
state  { centerTime /*unit*/, zoom /*log2 px-per-unit vs live; 0 = full res, <0 out*/, followLive:boolean }
camera.get()                       -> {centerTime, zoom, followLive, zoomProgress, velocity}
camera.target({centerTime?, zoom?, followLive?, anchorX?})   // all inputs go here
camera.nudge({dTime?, dZoom?, anchorX?})                     // wheel/keys/drag deltas
camera.play()      // target zoom 0 at current centre, then followLive-at-playback-rate
camera.goLive()    // target newest edge + zoom 0, followLive=true
camera.on('change'|'settle'|'live', fn)
camera.zoomProgress // 0 at zoom 0 … 1 at Z_OUT (≈-1.5); the ONE value UI Tapestry's curves read
```
- One critically damped spring per axis (time, zoom) with ω shared; drag uses direct position + release velocity
  fed into the spring. Zoom is anchored at the pointer (`anchorX`) by solving centreTime alongside zoom each step.
- `followLive`: target centreTime = `ingest.headTime() - viewHalfWidth*margin`, advanced each frame at the live
  rate (replaces client.js `liveScroll` pacing; same visual speed).
- Magnetism only near live: if released within 0.15 zoom and N strips of the head, retarget to `goLive()`.
  No detents elsewhere.
- URL: `?t=<ISO|unit>&z=<zoom>` written debounced (250 ms, `replaceState`); read once at boot → camera set
  immediately, no intro.
- Input map: WASD = arrows (time ±, zoom ±), wheel/swipe = time, shift/ctrl+wheel & pinch = zoom, drag = pan at any
  zoom (single pointer handler on the canvas; fixes the reported drag issue by construction), Space = Play, L = Live.

### 2.2 Tile store (`Tapestry.tiles`)
```js
tiles.request(level, index, priority)   // idempotent
tiles.best(level, index) -> {tex, uvRect, level, alpha}   // best resident ancestor + fade alpha of finer
tiles.state(level, index) -> 'empty'|'coarse'|'sharp'
tiles.hasAnyTexture(rect /*CSS px viewport*/) -> boolean   // kept, same signature as main@e0dd089
tiles.coverage(rect) -> Float32Array of per-column states   // for Grain's mask
tiles.ingestStrip(unit, bitmap)          // level-0 insert from live-ingest
tiles.stats() -> {bytes, textures, queue, decodesInFlight}
```
- Levels: L0 = individual strips (128×512 raw, overlap 32 trimmed in shader), L1–L7 = current pyramid. Coarse
  levels L5–L7 kept resident permanently (few MB) so nothing is ever blank once the manifest loads.
- Priority = on-screen first (centre-out), then a lookahead strip in the direction of camera velocity, then
  one level coarser; requests cancelled (AbortController) when they leave the window.
- Decode in a worker (`createImageBitmap`, already in unified.js); uploads budgeted per frame (≤2 ms or 4
  textures); texture atlas pages for L0 (e.g. 2048×2048 = 16×4 strips) to cut draw calls.
- GPU budget: 192 MB desktop / 96 MB iPhone, LRU by (distance from viewport × level); never evict resident coarse.

### 2.3 Live ingest (`Tapestry.ingest`)
- Moves `wsUrl/send/onStripBinary/onStripRef/decodeStrip/onClock` from client.js verbatim.
- New strip → `tiles.ingestStrip(unit, bitmap)` and `head.begin(unit)` (crystallize effect). Also composited into
  the in-memory parent tiles (L1, L2) by drawing it downscaled into the cached L1/L2 texture via FBO, so zoomed-out
  views include the newest minutes before the cron catches up (≤5 min gap today).
- `ingest.headTime()`, `ingest.on('strip'|'caption'|'clock'|'viewers')`.

### 2.4 Renderer + passes (`Tapestry.renderer`)
```js
renderer.addPass({name, order, draw(gl, frameCtx)})   // frameCtx = {camera, tiles, W,H,dpr, t, fbo}
```
Order: `tiles` (per visible tile: draw best ancestor, then finer with alpha — one pass, one shader, `uvRect`
sub-sampling) → `grain` (only where `state==='empty'` at every level) → `head` (crystallizing edge shader at the
live head, fades out with zoomProgress) → `reflection` (downsample band FBO to 128×16, blur, mirror, 1/4 res; the
refl.js maths unchanged) → `glow`. Renders only when dirty (camera moving, uploads, fades, head animating, live
following); idle = zero GPU.

### 2.5 UI layer (`Tapestry.ui`)
Plain HTML over the canvas, created once, never swapped or auto-hidden. Every element reads `camera.get()` on
`change` and writes CSS custom properties only (`--zp: zoomProgress`) so motion is compositor-only.
- Header + real wall clock (always wall time).
- Chat always visible at every zoom.
- "Where next?" bar: same box, size, position. Contents interpolate on `--zp`: prompt text field (zp 0) ↔ scrub
  controls (⏮ / Play / ⏭ / calendar). The right-hand white circle is Send at live, Live when `!followLive`.
  UI Tapestry owns the curve shapes (`ui/bar.js` exposes `bar.setCurve(name, fn(zp)->0..1)`).
- Caption: date on one line, tabular numbers (`font-variant-numeric: tabular-nums`), title below.
- Hints bottom-right, subtle grey, fade after first use.
- Events/markers only when `zoom < Z_EVENTS` (≈-3).
- Strings: "Auto" never "Claude"; no owner credit; no upsells.

### 2.6 Hooks for other bots
- `Tapestry.tiles.hasAnyTexture(rect)` (and `window.TapestryTimeline.hasAnyTexture` alias kept) → boolean.
- `Tapestry.tiles.coverage(rect)` for a per-column Grain mask; Grain draws via `createRenderer(gl)` on the shared
  context as the `grain` pass.
- `Tapestry.camera.zoomProgress` + `camera.on('change')`, plus `--zp` on `:root`.
- Embed: `?embed=1` (bicrick.com iframe) hides header, keeps the bar, no intro; `postMessage({type:'tapestry:camera'})`
  per `embed-api.md`.

## 3. Data and tiling changes
1. **Deepest level = raw strips, not tiles.** Strips already exist at a stable URL (`stripUrl`), live strips arrive
   as strips, and tiling L0 would add a cron step and latency. Atlas them client-side.
2. **Live → pyramid latency:** client-side compositing into L1/L2 (§2.3) makes it 0 for viewers; server tiles stay
   on the 5-minute cron. Optional later: cron rebuilds only the last L1 tile each run (it largely does).
3. **Manifest:** add `l0: {strip_w:128, strip_h:512, overlap:32}` and `head_unit` to the pyramid manifest so the
   client knows the real newest edge without the socket (for embeds/offline).
4. **L1 height** 256 vs L0 512: fine (one mip step). No re-tiling needed.
5. No change to RunPod or the websocket protocol.

## 4. Phases (each on a hidden URL `/one-<slug>.html`, built by a `make_one.js` like `make_unified.js`)

Perf is measured with `?perf=1` (fps, p95 frame time, quads, tex MB) on: MacBook (Safari + Chrome, Low Power
Mode too) and iPhone (Safari), against prod `/` and `/classic-7f3e21.html` with the same scripted path
(load → live 10 s → zoom out to all-time → scrub → Play → Live). Budget: **p95 ≤ 16.7 ms, no frame > 33 ms during
zoom, main-thread JS ≤ 4 ms/frame, idle GPU 0**. Each phase must be no worse than prod on every row.

| # | Phase | Ships | Acceptance | Est. |
|---|---|---|---|---|
| 0 | Harness | `?perf` extended, scripted perf path (Playwright, `scripts/intro-capture.mjs` style), baseline numbers for prod recorded in this doc | Baseline table filled | 0.5 d |
| 1 | Extract core | `tile-store.js`, `renderer.js`, `camera.js` (spring) out of unified.js; hidden page = timeline only, no live | Same visuals as prod timeline; all inputs incl. drag on one spring; deep link opens without intro; never blank (L5–L7 resident) | 2 d |
| 2 | Live ingest into the pyramid | `live-ingest.js`, L0 atlas, followLive, head crystallize pass, L1/L2 client compositing | Zoom 0 on hidden page looks like prod live at the same pixel scale/band position; new strip appears ≤1 frame after decode; zoom out shows newest minutes; no flash anywhere (frame-by-frame capture of 10 zooms) | 3 d |
| 3 | Passes | reflection + glow on the same context; Grain pass (#91 rebased on phase 1 hooks) | Reflection visually matches prod (side-by-side screenshot diff); Grain only where `hasAnyTexture` false; one canvas in DOM | 2 d |
| 4 | One UI layer | header/clock, chat always visible, bar driven by `--zp`, Live in send spot, caption, hints, events threshold, composer at live; delete `u.css` pill | Same DOM at every zoom (snapshot test: no element added/removed on zoom); keyboard/a11y (`inert` when composer not usable); UI Tapestry's chosen curve wired; Patrick sign-off on look | 3 d |
| 5 | Intro + embed + cutover prep | intro on new renderer, `?embed=1`, deep links, OG/share links, about.html check (Grok Bot) | All §2 rules; bicrick.com iframe works; perf table green on all devices | 1.5 d |
| 6 | Cutover + cleanup | `/` = one renderer; delete client.js renderer parts, unified.js handoff, refl.js 2nd canvas, tm-lab | 48 h on prod with `TapestryOps` error/fps reports ≤ baseline; then cleanup PR | 1 d + soak |

Total ≈ 13 working days of build + soak. Phases 1–3 can be previewed by Patrick individually; nothing touches `/`
until phase 6.

## 5. Ownership
- **Tapestry:** camera, tile store, renderer, passes (tiles/head/reflection/glow), live ingest, data/manifest,
  UI-layer structure + hooks, perf harness, rollout.
- **UI Tapestry:** motion curves on `zoomProgress`, Grain pass (#91 → `passes/grain.js`), bar morph look, hints
  style.
- **Grok Bot:** keep `about.html` / homepage stippling consistent with the "coarse first, Grain only on nothing" rule;
  check bicrick.com embed.
- One branch (`one-renderer`), one hidden preview; others stack PRs onto it, no separate previews.

## 6. Rollout and rollback
- Phases 1–5: hidden `/one-<slug>.html`, `noindex`, built from `index.html` so chrome never drifts.
- Phase 6: `make_unified.js`-style swap flag `ONE = true` makes `/` the new page; current unified page kept at a
  hidden backup path, classic at `/classic-7f3e21.html` (unchanged).
- Runtime kill switch: `?classic=1` and a config flag in `config.js` redirect to the backup without a redeploy.
- Rollback = flip flag + redeploy (≈2 min) or promote previous Vercel deployment (instant).
- Delete old code only after 7 days clean on prod.

## 7. Risks
| Risk | Mitigation |
|---|---|
| iPhone GPU memory / Safari WebGL context loss | 96 MB budget, `webglcontextlost` handler rebuilds from resident coarse, atlas pages |
| Live visual parity (band scale, overlap blend, pacing) differs from the 2D canvas | Pixel diff vs classic at zoom 0 in phase 2; port overlap blend into the tile shader |
| Reflection port changes look | Keep refl.js maths, screenshot diff, Patrick sign-off |
| Socket logic regressions in the client.js split | Move verbatim, no protocol change; keep chat/composer tests |
| Decode stalls on iPhone (no OffscreenCanvas in workers on older iOS) | Fallback to main-thread `createImageBitmap` with upload budget (already in unified.js) |
| Scope creep from two other bots | One branch, hooks frozen after phase 1 |
| Cron gap (5 min) at mid zoom | Client compositing into L1/L2 |

## 8. Open questions for Patrick
1. Zoom 0 framing: keep the classic band (with reflection space above/below) or fill more of the screen?
2. Should scrolling while at live leave live immediately, or only after a small threshold (rubber band like today)?
3. Composer from history: still live-only (send button becomes Live away from live)?
4. Events threshold: which zoom (hours? days?) and which categories on by default?
5. OK to pause the current "same UI" patch and the four pending fixes stay unshipped, or ship those four to prod now
   while this is built?

## 9. Patrick's decisions (2026-10-15)
1. Zoom-0 band leaves room for the reflection (band 50% of height landscape / 42% portrait, centred at 42%).
2. Leaving live is instant: any scrub/drag/zoom-out drops `followLive` immediately. No rubber band.
3. Composer/prompt box only at live (phase 4).
4. Events: `Z_EVENTS = -6` (span of roughly an hour or more at desktop width), off by default.
5. Arrows = WASD (same code path), Play = spring zoom to 0 at the current spot then playback, top-left clock is always
   wall time, never the wireframe where any level is resident.

## 10. Phase 0 baseline (scripts/perf-path.mjs)
Box numbers: headless Chrome, SwiftShader (CPU GL, no GPU), 1440x900 @2x. They rank pages but are NOT device numbers;
the MacBook/iPhone rows still need running with `GPU=1` / Safari. Per segment: rAF p95 / max / frames > 33 ms.

| Segment | prod `/` (unified) | `/classic-7f3e21.html` | `/one-3c9d1f.html` (phase 1, no live socket yet) |
|---|---|---|---|
| live 10 s | 283 / 583 / 67 | 150 / 233 / 81 | 16.8 / 16.8 / 0 |
| zoom out (hold S 3.5 s) | 350 / 550 / 23 | 150 / 150 / 35 | 33.3 / 66.7 / 4 |
| scrub (wheel) | 217 / 400 / 95 | 150 / 200 / 103 | 16.8 / 16.8 / 0 |
| Play | 200 / 250 / 23 | 150 / 217 / 34 | 16.8 / 16.8 / 0 |
| Live (0) | 350 / 350 / 18 | 150 / 167 / 25 | 16.8 / 33.3 / 0 |

One-renderer main-thread JS per frame p95: 0.1-1.5 ms (max 22 ms, one texture-upload frame under SwiftShader during
zoom-out). Frames with bare background (true gaps) on the whole path: 0. Peak texture memory 85 MB (budget 192).
