// Live viewer: wires the stream, the strip/LOD stores, the camera, motion and renderer to the page chrome.
// Ported literally from the old static/client.js (same constants, same order of side effects); the scroll/render core
// now lives in its own modules (camera, live-follower, motion, renderer, strips, lod, timeline).
import "../core/globals";
import { DEFAULT_STREAM_CONFIG, stale, type ClientMsg, type Director, type GpuInfo, type LiveApi, type ServerMsg, type StreamConfig } from "../core/protocol";
import { credit, esc, fmtTime, fmtWhen, ideaTitle, srcLabel } from "../core/text";
import type { SubmitEvent2 } from "../chrome/forms";
import { Camera } from "./camera";
import { LiveFollower } from "./live-follower";
import { LodStore } from "./lod";
import { Motion } from "./motion";
import { COARSE, Renderer } from "./renderer";
import { StripStore } from "./strips";
import { Timeline } from "./timeline";
import { ZoomController } from "./zoom";
import { dragBy, releaseVelocity } from "./input";
import { renderQueueList } from "../chrome/queue";

type OdoEl = HTMLElement & { _odo?: { set(n: number): void } | null; _pre?: HTMLElement; _num?: HTMLElement; _post?: HTMLElement };
interface Gesture { x0: number; y0: number; t0: number; moved: number; wasIdle: boolean; armed: boolean; touch?: boolean; dead?: boolean; scrub?: boolean; hist: Array<[number, number]> }

export function startViewer(): void {
  window.TapestryCredit = credit;

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const canvas = $<HTMLCanvasElement>("view");
  const statusEl = $("status");
  const statusText = $("status-text");
  const DEBUG = /[?&]debug/.test(location.search);
  const liveBtn = $("live-btn");
  // Away from live: the "Return to live" pill takes the chat pill's place (crossfade); an open compose sheet closes, draft kept.
  { const dk = document.querySelector(".dock"); if (dk && liveBtn) dk.appendChild(liveBtn); liveBtn.classList.remove("hidden"); }
  // GPU offline (replay): the composer gives way to a quiet status pill in the same spot; nothing can be typed or sent.
  // The drawer's autopilot controls only talk to the pod, so they go inert too.
  const OFFLINE_MSG = "GPU is offline · You're watching a replay";
  let offline = false;
  function setOffline(on: boolean) {
    if (offline === on) return;
    offline = on;
    document.body.classList.toggle("gpu-off", on);
    $("cmd").inert = on;
    ($("offline-pill").querySelector(".msg") as HTMLElement).textContent = on ? OFFLINE_MSG : "";
    document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(".drawer-foot input, .drawer-foot button").forEach((el) => { el.disabled = on; });
    if (on && document.body.classList.contains("composing")) { $("cmd-input").blur(); document.body.classList.remove("composing"); }
  }
  function setAway(on: boolean) {
    if (document.body.classList.contains("away") === on) return;
    document.body.classList.toggle("away", on);
    if (on && document.body.classList.contains("composing")) { const i = $("cmd-input"); if (i) i.blur(); document.body.classList.remove("composing"); }
  }

  let config: StreamConfig = { ...DEFAULT_STREAM_CONFIG };
  let speedMult = 1;
  let speedMode = "auto";
  let manualSpeed = 30;
  let gpu: GpuInfo | null = null;
  let ws: WebSocket | null = null;
  let reconnectDelay = 1000, dropAt = 0;   // dropAt: when a visible, open stream dropped (ops telemetry)
  let everOpened = false;   // initial connect shows nothing, never "reconnecting"
  let connected = false;
  let clientPingTimer: number | null = null;
  let director: Director | null = null;

  let podWs: string | null = null;   // /api/live names the current pod (survives a RunPod migration without a rebuild)
  function wsUrl(): string {
    const q = new URLSearchParams(location.search).get("ws");
    const cfg = (window.TAPESTRY_CONFIG && window.TAPESTRY_CONFIG.wsUrl) || "";
    let url = q || podWs || cfg;
    if (!url) {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      return proto + "//" + location.host + "/ws";
    }
    if (url.startsWith("https://")) url = "wss://" + url.slice(8);
    if (url.startsWith("http://")) url = "ws://" + url.slice(7);
    if (!/\/ws\/?$/.test(url)) url = url.replace(/\/$/, "") + "/ws";
    return url;
  }
  function send(obj: ClientMsg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function httpBase() { return wsUrl().replace(/^ws/, "http").replace(/\/ws\/?$/, ""); }

  // Battery saver: drop to 1x resolution and ~30fps on low battery (Battery API) or data-saver (mobile.js flips it).
  const saver = { on: false };
  window.TapestrySaver = saver;

  // ---------- core modules ----------
  const SW = () => config.strip_width;
  const timeline = new Timeline({ httpBase, maxIndex: () => strips.maxIndex, prefetchL2: (c) => lod.tile(2, c, true), stripSeconds: () => (gpu && gpu.strip_seconds) || undefined,
    viewReady: () => renderer.coverage >= 1 || cam.zoom <= 0.3, lodPending: () => lod.pending() });
  const strips: StripStore = new StripStore({
    config: () => config, send, connected: () => connected, apiMissing: (a, b) => apiMissing(a, b),
    addStripScene: (i, sc) => timeline.addStripScene(i, sc),
    onFirstIndex: () => { cam.liveScroll = Math.max(0, strips.panoramaWidth() - cam.viewWorld() - SW() * 2); },
    liveScroll: () => cam.liveScroll,
  });
  const lod = new LodStore({ maxIndex: () => strips.maxIndex, lodBase: () => config.lod_base, httpBase });
  const cam = new Camera(canvas, { stripWidth: SW, paintHeight: () => config.height, maxOv: () => strips.maxOv, saver });
  const resize = () => cam.resize();
  window.addEventListener("resize", resize);
  resize();
  const follower = new LiveFollower(cam, strips);
  const motion: Motion = new Motion({
    cam, strips, lod, follower, setAway,
    refreshTimeline: () => { timeline.refresh(); },
    replay: () => replay, scrollSpeed: () => config.scroll_speed,
    coverage: () => renderer.coverage, gestureActive: () => gesture !== null,
  });
  const renderer: Renderer = new Renderer({
    cam, strips, lod, motion, follower, connected: () => connected, saver, paintHeight: () => config.height,
    afterFrame: () => updateTimeline(),
    beforeDraw: () => { if (zoom) zoom.step(); },
    hud: (speed, ahead) => updateHud(speed, ahead),
    ticks: () => timeline.ticks(),
  });
  renderer.gestureHeld = () => gesture !== null;
  // Zoom (on for everyone; ?zoom=0 turns it off): ctrl/trackpad-pinch wheel and two-finger touch pinch zoom about the
  // pointer, - / = / 0 keys. At zoom 1 the viewer is exactly the unzoomed one.
  const ZOOM = new URLSearchParams(location.search).get("zoom") !== "0";
  const zoom = ZOOM ? new ZoomController(cam, motion, () => (lod.macro() && strips.maxIndex > 0 ? strips.maxIndex + 1 : null)) : null;
  const viewLeft = () => motion.viewLeft();
  const viewWorld = () => cam.viewWorld();
  const centerIdx = () => cam.centerIdx(viewLeft());
  // Pointer / wheel / touch CSS px -> world px at the current zoom (== cam.pxToWorld() at zoom 1; see Camera.feel).
  const pxToWorld = () => cam.pxToWorldZ();

  // For the load-in: lets intro.js anchor its points to the same moving world as the canvas.
  window.TapestryView = { portrait: () => cam.portrait(), band: () => cam.band(), drawScale: () => cam.drawScale(), setSurround: (a: number) => { renderer.setSurround(a); }, left: () => viewLeft(), scale: () => cam.scale(), ready: () => strips.maxIndex >= 0, coverage: () => renderer.coverage, zoom: () => cam.zoom, canvas, center: () => centerIdx(), max: () => strips.maxIndex, live: () => motion.panMode === "live" };
  if (zoom) Object.assign(window.TapestryView as Record<string, unknown>, {
    zoomTo: (z: number, cssX?: number) => zoom.zoomTo(z, cssX),
    /** ?zoom only (tests): world x / CSS px per world px of the last drawn frame */
    worldAt: (cssX: number) => cam.screenToWorld(cssX).x,
    cssPerWorld: () => (cam.last ? cam.last.s : 0) / (canvas.width / Math.max(1, canvas.clientWidth)),
    /** tests: zoom floor, overview tiles still loading, loaded tiles per level */
    minZoom: () => zoom.minZoom(), lodPending: () => lod.pending(), lodStats: () => lod.stats(),
    /** world x of the painted live line (past it nothing is drawn yet), or null */
    liveWorld: () => (follower.livePos === null ? null : follower.livePos - cam.STAGE()),
  });

  // ---------- shared timeline clock ----------
  let viewers = 1;
  function onClock(m: import("../core/protocol").ClockMsg) {
    viewers = m.viewers || viewers;
    speedMode = m.mode; manualSpeed = m.manual; speedMult = m.multiplier;
    follower.onClock(m);
    syncSpeedUi();
  }

  // ---------- captions (scene under the centre of the view) ----------
  let histKey: string | null = null, histTime = "", swapT = 0;
  let swapR: ReturnType<Timeline["sceneAt"]> = null;   // scene the in-flight caption swap will show
  let swapAt = -1e9;   // when the caption last changed
  let liveCapKey: string | null = null;
  function wireTitleClick(el: HTMLElement | null) {
    if (!el || el.dataset.tipWired) return;
    el.dataset.tipWired = "1";
    let t = 0, long = false;
    el.addEventListener("click", (e) => { if (long) { long = false; return; } if (el.dataset.href) { e.stopPropagation(); window.open(el.dataset.href, "_blank", "noopener"); } });
    el.addEventListener("touchstart", () => { long = false; t = window.setTimeout(() => { long = true; el.classList.add("tip-on"); setTimeout(() => el.classList.remove("tip-on"), 1800); }, 450); }, { passive: true });
    el.addEventListener("touchend", () => clearTimeout(t), { passive: true });
    el.addEventListener("touchmove", () => clearTimeout(t), { passive: true });
  }
  wireTitleClick($("now-title"));
  wireTitleClick($("amb-title"));
  // On-stage title: tooltip with who suggested it, click opens the scene's share page (/s/<a>-<b>).
  function stageTitle(index: number, title: string, by: string, origin: string) {
    const c = credit(by, origin);
    const tip = c === "Auto" ? "Auto" : "Suggested by " + c;
    let b = index + 15;
    for (const r of timeline.scenes) if (r[0] > index) { b = r[0] - 1; break; }
    const href = (typeof index === "number" && index >= 0) ? `/s/${index}-${Math.min(b, index + 63)}` : "";
    for (const id of ["now-title", "amb-title"]) {
      const el = $(id); if (!el) continue;
      el.dataset.tip = tip;
      if (href) el.dataset.href = href; else delete el.dataset.href;
    }
  }
  function centerScene() {
    if (!timeline.scenes.length) return null;
    const r = timeline.sceneAt(Math.max(0, Math.min(strips.maxIndex, Math.round(centerIdx()))));
    return r ? { index: r[0], title: r[1], by: r[2], style: r[3], origin: r[4] } : null;
  }
  function emitCaption(r: ReturnType<typeof centerScene>) {
    if (!r) return;
    window.dispatchEvent(new CustomEvent("tapestry:caption", { detail: r }));
  }
  // Live: caption the strip under the centre of the view (what's actually on screen).
  function liveCaption() {
    const r0 = centerScene();
    if (!r0) return false;
    const key = r0.index + "|" + r0.title;
    if (key !== liveCapKey) {
      liveCapKey = key;
      const { title, by, style, origin } = r0;
      $("now-title").textContent = title || "—";
      stageTitle(r0.index, title, by, origin);
      const src = $("now-src");
      src.textContent = srcLabel(by, origin) + (style && style !== "none" && style !== "photo" ? " · " + style : "");
      src.className = "src" + (origin === "auto" ? " auto" : "");
      if (director) {
        const up = director.upcoming || director.items || [];
        const tg = director.target_scene;
        const nxt = (tg && tg.title !== title) ? tg : up.find((x) => x.title !== title);
        $("now-arrow").classList.toggle("hidden", !nxt);
        $("next-title").textContent = nxt ? (nxt.title as string) : "";
      }
      emitCaption(r0);
    }
    return true;
  }
  function histCaption() {
    if (motion.live || !timeline.scenes.length) {
      if (histKey !== null) { histKey = null; liveCapKey = null; document.body.classList.remove("hist-cap"); $("now-time").textContent = ""; if (director) showDirector(director); }
      liveCaption();
      return;
    }
    const idx = Math.max(0, Math.min(strips.maxIndex, Math.round(centerIdx())));
    const r = timeline.sceneAt(idx);
    const t = fmtTime(timeline.timeAt(idx));
    if (t !== histTime) { histTime = t; $("now-time").textContent = t; }
    if (!r) return;
    const key = r[0] + "|" + r[1];
    if (key === histKey) return;
    const first = histKey === null;
    histKey = key;
    document.body.classList.add("hist-cap");
    const cap = document.querySelector(".dock .now");
    swapR = r;
    const apply = () => {
      swapT = 0; swapAt = performance.now();
      const [i0, title, by, style, origin] = swapR as NonNullable<typeof swapR>;   // the latest scene when the fade lands
      $("now-title").textContent = title || "—";
      stageTitle(i0, title, by, origin);
      const src = $("now-src");
      const c = credit(by, origin);
      src.textContent = (c === "Auto" ? "✦ Auto" : by ? "by " + c : origin === "user" ? "Audience" : "Earlier") + (style && style !== "none" ? " · " + style : "");
      src.className = "src" + (origin === "auto" ? " auto" : "");
      $("now-arrow").classList.add("hidden"); $("next-title").textContent = "";
      cap && cap.classList.remove("swap");
    };
    // Rapid changes (fast pans) must not keep restarting the fade, or the title never lands: an in-flight swap just
    // picks up the newest scene when it fires.
    // Scenes changing faster than the fade (a fast pan / flight) swap at once; a settled view still crossfades.
    if (first || !cap || performance.now() - swapAt < 700) { clearTimeout(swapT); apply(); } else if (!swapT) { cap.classList.add("swap"); swapT = window.setTimeout(apply, 170); }
  }
  timeline.start();
  // The old bottom scrubber/wheel is gone (native scroll + swipe). The Back-to-live pill says how far back you are.
  let agoTxt = "";
  function agoLabel() {
    const t = timeline.timeAt(Math.max(0, Math.round(centerIdx()))), now = Date.now() / 1000;
    if (t == null) return "";
    const m = Math.max(0, (now - t) / 60);
    return m < 1.5 ? "" : m < 60 ? Math.round(m) + " min ago" : m < 36 * 60 ? (m / 60 < 10 ? (m / 60).toFixed(1).replace(/\.0$/, "") : Math.round(m / 60)) + " h ago" : fmtTime(t);
  }
  function updateTimeline() {
    if (strips.maxIndex < 1) return;
    if (!motion.live && liveBtn) {
      const a = agoLabel();
      if (a !== agoTxt) { agoTxt = a; const el = liveBtn.querySelector(".ago"); if (el) { el.textContent = a ? a + " · " : ""; } }
    }
    histCaption();
  }
  window.TapestryJump = (idx) => motion.jumpTo(idx);

  // ---------- HUD ----------
  // 'live · N watching' with an odometer for N; the prefix/suffix only re-render when they change.
  function setWatching(el: OdoEl | null, pre: string, post: string) {
    if (!el || !window.Odometer) { if (el) el.textContent = pre + viewers + post; return; }
    if (!el._odo) {
      el.textContent = "";
      el._pre = document.createElement("span"); el._num = document.createElement("span"); el._post = document.createElement("span"); el._num.classList.add("w-n"); el._post.classList.add("w-post");
      el.append(el._pre, el._num, el._post);
      el._odo = window.Odometer(el._num);
    }
    if (el._pre!.textContent !== pre) el._pre!.textContent = pre;
    if (el._post!.textContent !== post) el._post!.textContent = post;
    el._odo.set(viewers);
  }
  function resetWatching(el: OdoEl | null) { if (el && el._odo) { el._odo = null; } }
  function updateHud(speed: number, ahead: number) {
    const aheadStrips = Math.max(0, ahead / SW());
    statusEl.classList.toggle("off", !connected);
    statusEl.classList.toggle("warn", connected && motion.live && aheadStrips < 1);
    statusEl.classList.toggle("replaying", !connected && (replay || podDown));
    setOffline(!connected && (replay || podDown));
    if (!connected && (replay || podDown)) { resetWatching(statusText); resetWatching($("status-mini")); statusText.textContent = "replay"; const mi = $("status-mini"); if (mi) mi.textContent = "replay"; return; }
    if (!connected && (!liveChecked || !everOpened)) { statusText.textContent = ""; const mi = $("status-mini"); if (mi) mi.textContent = ""; return; }   // until /api/live answers
    if (!connected) { resetWatching(statusText); resetWatching($("status-mini")); statusText.textContent = "reconnecting"; const mi = $("status-mini"); if (mi) mi.textContent = "reconnecting"; return; }
    const parts: string[] = [];
    const S = window.TapestrySocial;
    if (!DEBUG && !(S && S.isAdmin())) {
      parts.push(replay ? "replay" : motion.live ? "live" : "rewound");
      setWatching(statusText, parts.join("  ·  ") + "  ·  ", " watching");
      setWatching($("status-mini"), parts.join("  ·  ") + "  ·  ", " watching");
      syncSpeedUi();
      return;
    }
    if (!motion.live) parts.push("history · strip " + Math.floor(viewLeft() / SW()) + "/" + strips.maxIndex);
    // GPU = time to paint one strip; stream = how fast viewers actually move (px/s and the matching s/strip).
    if (gpu && gpu.strip_seconds) parts.push("GPU " + gpu.strip_seconds.toFixed(1) + " s/strip");
    parts.push(aheadStrips.toFixed(1) + " ahead");
    parts.push(speed.toFixed(0) + " px/s" + (speed > 0.5 ? " (" + (SW() / speed).toFixed(1) + " s/strip)" : "") + (speedMult > 1 ? " · " + speedMult + "×" : ""));
    parts.push(viewers + (viewers === 1 ? " viewer" : " viewers"));
    resetWatching(statusText);
    statusText.textContent = parts.join("  ·  ");
    { const mi = $("status-mini"); if (mi) { resetWatching(mi); mi.textContent = parts.join("  ·  "); } }
    syncSpeedUi();
  }
  let paintMode: ((m: string) => void) | null = null;
  function syncSpeedUi() {
    if (typeof paintMode === "function") paintMode(speedMode);
    if (document.activeElement !== $("manual-speed")) { $<HTMLInputElement>("manual-speed").value = String(manualSpeed); $("manual-val").textContent = Math.round(manualSpeed) + " px/s"; }
    $("speed-btn").textContent = (speedMode === "auto" ? "Auto" : Math.round(manualSpeed) + " px/s");
  }

  // ---------- permalinks: ?at=<strip>[&to=<strip>] ----------
  window.TapestrySeek = (from, to) => motion.seekTo(from, to);
  {
    const q = new URLSearchParams(location.search);
    if (q.has("at")) motion.pendingSeek = [parseInt(q.get("at") as string, 10) || 0, q.has("to") ? parseInt(q.get("to") as string, 10) : null];
  }

  // ---------- arrow-key flight ----------
  addEventListener("blur", () => { motion.flyCancel(); if (motion.panMode === "fly") motion.panMode = "glide"; });
  window.addEventListener("keydown", (e) => {
    const ae = document.activeElement as HTMLElement;
    if (/INPUT|TEXTAREA|SELECT/.test(ae.tagName) || ae.isContentEditable) return;
    if ($("drawer").classList.contains("open")) return;
    if (motion.flyKey(e, true)) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => { motion.flyKey(e, false); });

  // ---------- gestures ----------
  // While live, input is "armed" rather than acted on: taps toggle the UI, small jiggles nudge the
  // view elastically and spring back, and only a deliberate backward drag/scroll/flick leaves live.
  const LEAVE_PX = 60;          // backward distance (CSS px) that commits to rewinding
  const FLICK_PX_MS = 0.6;      // or a fast backward flick (CSS px per ms) past FLICK_MIN_PX
  const FLICK_MIN_PX = 24;
  const NUDGE_MAX = 36;         // max elastic offset in CSS px while still live
  let activePointer: number | null = null, lastPX = 0;
  let gesture: Gesture | null = null;
  const cssToWorld = () => pxToWorld();
  function commitRewind() {
    // Leave live from wherever the nudge left us, then continue as a normal drag.
    motion.panPos = cam.liveScroll + cam.nudge; cam.nudge = 0; cam.nudgeVel = 0;
    motion.panMode = "live";
    motion.enterHistory();
    motion.panMode = "drag";
    motion.panVel = 0;
    motion.samples = [[performance.now(), motion.panPos]];
  }
  const EDGE_DEAD = 20;          // touch: leave the screen edges to iOS back/forward swipes
  const TOUCH_LOCK = 9;          // touch: px before we decide horizontal (scrub) vs anything else
  canvas.addEventListener("pointerdown", (ev) => {
    // A second finger (pinch) cancels a touch scrub that hasn't committed; a committed one just ends with momentum.
    if (activePointer !== null) { if (ev.pointerType === "touch" && gesture && gesture.touch) gesture.dead = true; return; }
    motion.wheelGlide = false;
    activePointer = ev.pointerId;
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
    if (ev.pointerType !== "touch") document.body.classList.add("dragging");
    lastPX = ev.clientX;
    const armed = motion.panMode === "live";
    // Touch: a tap toggles the UI; a clearly horizontal swipe scrubs time 1:1 with momentum (see pointermove).
    if (ev.pointerType === "touch") {
      gesture = { x0: ev.clientX, y0: ev.clientY, t0: performance.now(), moved: 0, wasIdle: document.body.classList.contains("idle"), armed, touch: true,
        dead: ev.clientX < EDGE_DEAD || ev.clientX > innerWidth - EDGE_DEAD, hist: [[performance.now(), ev.clientX]] };
      return;
    }
    gesture = { x0: ev.clientX, y0: ev.clientY, t0: performance.now(), moved: 0, wasIdle: document.body.classList.contains("idle"), armed, hist: [[performance.now(), ev.clientX]] };
    if (armed) return;
    motion.panPos = motion.shownPan();
    motion.panMode = "drag";
    motion.panVel = 0;
    motion.samples = [[performance.now(), motion.panPos]];
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (ev.pointerId !== activePointer || !gesture) return;
    const now = performance.now();
    gesture.moved = Math.max(gesture.moved, Math.hypot(ev.clientX - gesture.x0, ev.clientY - gesture.y0));
    gesture.hist.push([now, ev.clientX]);
    while (gesture.hist.length > 2 && now - gesture.hist[0][0] > 80) gesture.hist.shift();
    if (gesture.touch) {
      if (gesture.dead) return;
      const dx = ev.clientX - gesture.x0, dy = ev.clientY - gesture.y0;
      if (Math.hypot(dx, dy) < TOUCH_LOCK) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.3) { gesture.dead = true; return; }   // vertical-ish: not ours
      gesture.touch = false; gesture.scrub = true;
      if (gesture.armed && motion.panMode !== "live") gesture.armed = false;
      if (gesture.armed && dx > 0) { gesture.armed = false; commitRewind(); }     // swipe right at live = back in time, 1:1 from here
      else if (!gesture.armed) { motion.panPos = motion.shownPan(); motion.panMode = "drag"; motion.panVel = 0; motion.samples = [[now, motion.panPos]]; }
      lastPX = ev.clientX;
      if (gesture.armed) gesture.x0 = ev.clientX;                                 // swiping left at live: elastic nudge only
      return;
    }
    if (gesture.armed) {
      const back = ev.clientX - gesture.x0;   // dragging right = looking back in time
      const h0 = gesture.hist[0], v = (ev.clientX - h0[1]) / Math.max(1, now - h0[0]);
      if (back > LEAVE_PX || (back > FLICK_MIN_PX && v > FLICK_PX_MS)) {
        gesture.armed = false;
        commitRewind();
        lastPX = ev.clientX;
        return;
      }
      // elastic nudge, with resistance; forward is the live edge so it resists harder
      const d = -back, lim = NUDGE_MAX * cssToWorld();
      const raw = d * cssToWorld() * (d > 0 ? 0.25 : 0.45);
      const E = d > 0 ? cam.endSlack() : 0;   // deep zoom-out: a pull toward the future may bring the live end to the centre
      cam.nudge = E > 0 ? Math.min(E, d * cssToWorld() * 0.6) : Math.min(0, lim * Math.tanh(raw / lim)); cam.nudgeVel = 0;   // else never past live
      lastPX = ev.clientX;
      return;
    }
    const dxCss = ev.clientX - lastPX;
    lastPX = ev.clientX;
    dragBy(motion, cam, dxCss, now);
  });
  const endDrag = (ev: PointerEvent) => {
    if (ev.pointerId !== activePointer) return;
    activePointer = null;
    const g = gesture; gesture = null;
    const isTap = g && g.moved < 8 && performance.now() - g.t0 < 350;
    if (isTap && ev.type === "pointerup") {
      // A tap toggles the chrome. (Pointerdown already revealed it if it was hidden.)
      if (!g.wasIdle && COARSE) setTimeout(() => document.body.classList.add("idle"), 0);
    }
    if (g && g.touch) return;
    if (g && g.armed) {
      // A fast backward flick released before reaching LEAVE_PX still counts.
      const h = g.hist, a = h[0], b = h[h.length - 1];
      const back = ev.clientX - g.x0, v = (b[1] - a[1]) / Math.max(1, b[0] - a[0]);
      if (ev.type === "pointerup" && back > FLICK_MIN_PX && v > FLICK_PX_MS && performance.now() - b[0] < 80) {
        commitRewind();
        motion.panVel = Math.min(4000 * cam.feel(), v * 1000 * pxToWorld()) * -1;   // carry the flick's momentum back in time
        motion.panMode = "glide";
      }
      return;   // otherwise we never left live: the nudge springs back in frame()
    }
    motion.panVel = releaseVelocity(motion, cam, performance.now(), 8000);
    motion.panMode = "glide";
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  // Two-finger touch pinch = zoom about the fingers' midpoint. A one-finger scrub in progress ends (no fling).
  if (zoom) {
    const tp = new Map<number, { x: number; y: number }>();
    let pinch: { d0: number; z0: number } | null = null;
    const pair = () => { const v = [...tp.values()]; return { d: Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y), mx: (v[0].x + v[1].x) / 2 }; };
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      if (e.isPrimary) { tp.clear(); pinch = null; }   // a new touch sequence: forget fingers whose up never arrived
      tp.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (tp.size === 2) {
        pinch = { d0: Math.max(20, pair().d), z0: cam.zoomTarget };
        if (gesture) { gesture.dead = true; gesture.touch = true; gesture.moved = 1e9; }   // a pinch is never a tap
        if (motion.panMode === "drag") { motion.panMode = "glide"; motion.panVel = 0; }
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!tp.has(e.pointerId)) return;
      tp.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && tp.size === 2) { const p = pair(); zoom.zoomTo(pinch.z0 * p.d / pinch.d0, p.mx); }
    });
    const lift = (e: PointerEvent) => { tp.delete(e.pointerId); if (tp.size < 2) pinch = null; };
    canvas.addEventListener("pointerup", lift); canvas.addEventListener("pointercancel", lift);
  }
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((t) => canvas.addEventListener(t, () => document.body.classList.remove("dragging")));

  // Wheel / trackpad = time. Scroll DOWN travels back into history, UP comes forward (reaching the live edge re-joins
  // live). 1:1 like the phone's haptic dial; the OS supplies the momentum.
  let mwEndT = 0;
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey) { if (zoom) zoom.zoomBy(Math.exp(-ev.deltaY * 0.01), ev.clientX); return; }      // pinch-zoom gesture: ignored unless ?zoom
    const unit = ev.deltaMode === 1 ? 32 : ev.deltaMode === 2 ? innerHeight : 1;
    // Horizontal (trackpad swipe / shift+wheel) moves content with the fingers like a sideways page; vertical wheel down = back.
    const dx = ev.deltaX || (ev.shiftKey ? ev.deltaY : 0);
    const vert = !dx || (Math.abs(ev.deltaY) > Math.abs(dx) * 1.2 && !ev.shiftKey);
    const dCss = (vert ? -ev.deltaY : dx) * unit;   // + = forward in time
    if (!wheelHeld) wheelApi.wheelStart();
    wheelApi.wheelMove(-dCss);                    // same 1:1 wheel as the phone's haptic dial
    clearTimeout(mwEndT);
    mwEndT = window.setTimeout(() => wheelApi.wheelEnd(true), 90);   // 1:1, no extra glide: the OS sends momentum
  }, { passive: false });
  // 1:1 drag API (desktop horizontal scroll / shift+wheel / phone dial): drives the timeline in CSS px, then hands off to
  // the same glide/drift.
  let wheelHeld = false;
  const wheelApi = {
    offsetCss: () => viewLeft() / Math.max(1e-6, pxToWorld()),
    wheelStart() {
      if (motion.panMode === "live" || motion.panMode === "return") { motion.panPos = motion.panMode === "return" ? motion.shownPan() : cam.liveScroll + cam.nudge; cam.nudge = 0; cam.nudgeVel = 0; motion.panMode = "live"; motion.enterHistory(); }
      else motion.panPos = motion.shownPan();
      wheelHeld = true; motion.wheelGlide = false; motion.tlScrub = true; motion.panMode = "drag"; motion.panVel = 0; motion.turbo = 0; motion.samples = [[performance.now(), motion.panPos]];
    },
    wheelMove(dxCss: number) {
      dragBy(motion, cam, dxCss, performance.now());
    },
    wheelEnd(noFling?: boolean) {
      if (!wheelHeld) return;
      wheelHeld = false; motion.tlScrub = false;
      const panVel = noFling ? 0 : releaseVelocity(motion, cam, performance.now(), 90000);   // touch: plain release velocity (iOS-like); wheel: OS momentum already applied
      motion.panVel = panVel;
      motion.wheelGlide = Math.abs(panVel) > 40;
      motion.panMode = "glide";
    },
    scrubLabel() {
      const idx = Math.max(0, Math.min(strips.maxIndex, Math.round(centerIdx())));
      const r = timeline.sceneAt(idx), t = fmtTime(timeline.timeAt(idx));
      return [t, r && r[1]].filter(Boolean).join(" · ");
    },
    speedCss: () => Math.abs(cam.velS) / Math.max(1e-6, pxToWorld()),
    isLive: () => motion.panMode === "live",
    gliding: () => (motion.panMode === "glide" || motion.panMode === "fly") && Math.abs(motion.panVel) > 4,
  };
  Object.assign(window.TapestryView, wheelApi);
  function goLive() { motion.goLive(); }
  liveBtn.addEventListener("click", goLive);

  // ---------- auto-hide chrome ----------
  let idleTimer = 0;
  const drawer = $("drawer");
  function poke(ms?: unknown) {
    if (document.body.classList.contains("idle")) document.body.classList.remove("idle");   // no attribute write (and style recalc) per mousemove
    clearTimeout(idleTimer);
    // Don't count down during the load-in: the chrome hasn't even appeared yet.
    if (document.body.classList.contains("intro")) { idleTimer = window.setTimeout(poke, 400); return; }
    idleTimer = window.setTimeout(() => {
      const busy = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
      if (busy || drawer.classList.contains("open") || !$("speed-pop").classList.contains("hidden") || !$("export-pop").classList.contains("hidden")) return poke();
      document.body.classList.add("idle");
    }, typeof ms === "number" ? ms : 3500);
  }
  window.addEventListener("tapestry:revealed", () => poke(6000));
  ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"].forEach((e) =>
    window.addEventListener(e, () => poke(), { passive: true }));
  poke();

  // ---------- toast ----------
  let toastTimer = 0;
  function toast(html: string, ms = 4500) {
    const t = $("toast");
    t.classList.remove("nudge"); t.style.removeProperty("--nudge-top");
    t.innerHTML = html;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => t.classList.remove("show"), ms);
  }

  // ---------- command bar ----------
  let when = "end";
  document.querySelectorAll<HTMLButtonElement>(".seg[role=group] button").forEach((b) => b.addEventListener("click", () => {
    when = b.dataset.when as string;
    document.querySelectorAll(".seg[role=group] button").forEach((x) => x.classList.toggle("on", x === b));
    $("cmd-input").focus();
  }));
  let reqId = 0, ideaBusy = false, ideaKey: { text?: string; key?: string } = {};
  const pending = new Set<number>();
  const cmdSubmit = () => ($("cmd") as HTMLElement & { requestSubmit(): void }).requestSubmit();
  $("cmd").addEventListener("submit", (ev0) => {
    const ev = ev0 as SubmitEvent2;
    ev.preventDefault();
    if (offline) return;   // replay: no prompts (the composer is hidden and inert; this also covers Enter and scripted submits)
    const input = $<HTMLTextAreaElement>("cmd-input");
    const text = input.value.trim();
    const S = window.TapestrySocial;
    if (!text && !(S && S.hasRef && S.hasRef())) return;
    const hasImg = !!(S && S.hasRef && S.hasRef());
    // Production: ideas go to the shared pool. Image ideas always do (admins too): only the pool path uploads the
    // image and runs the vision step; the admin WS intent carries text only, so an image-only send arrived empty.
    if (S && S.enabled && (!S.isAdmin() || hasImg)) {
      // Feels instant: clear + collapse now (the submit listener below collapses), show "Sending…", one send at a time.
      if (ideaBusy) return;
      ideaBusy = true;
      if (ideaKey.text !== text) ideaKey = { text, key: (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)) };
      input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true }));
      $("cmd").classList.add("sending");
      toast(text ? `Sending <span class="muted">“${esc(text.length > 60 ? text.slice(0, 57) + "…" : text)}”</span>` : "Sending your image", 20000);
      Promise.resolve(S.submitIdea(text, ideaKey.key as string)).catch(() => false).then((ok) => {
        ideaBusy = false; $("cmd").classList.remove("sending");
        if (ok) { ideaKey = {}; return; }
        if (!input.value) { input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); }   // failed: give the text back to retry
      });
      return;
    }
    if (!text) return;   // the WS intent is text-only
    const req = ++reqId;
    pending.add(req);
    $("cmd").classList.add("busy");
    send({ type: "intent", text, when: ev.submitter && ev.submitter.dataset.when ? ev.submitter.dataset.when : when, req });
    input.value = "";
    toast(interpreterOn ? `Planning <span class="muted">“${esc(text)}”</span>…` : `Queued <span class="muted">“${esc(text)}”</span>`, 2500);
  });
  $("cmd-input").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.isComposing && !(ev.metaKey || ev.ctrlKey || ev.shiftKey)) { ev.preventDefault(); cmdSubmit(); return; }   // textarea: Enter sends
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey || ev.shiftKey)) {
      ev.preventDefault();
      const prev = when; when = "now";
      cmdSubmit();
      when = prev;
    }
  });
  $("skip").addEventListener("click", () => { send({ type: "skip" }); toast("Moving to the next scene"); });

  // ---------- speed popover ----------
  const pop = $("speed-pop");
  $("speed-btn").addEventListener("click", (e) => { e.stopPropagation(); pop.classList.toggle("hidden"); });
  document.addEventListener("pointerdown", (e) => { if (!pop.contains(e.target as Node) && e.target !== $("speed-btn")) pop.classList.add("hidden"); });
  paintMode = (m: string) => {
    document.querySelectorAll<HTMLElement>(".mode").forEach((x) => x.classList.toggle("on", x.dataset.mode === m));
    $("manual-row").classList.toggle("dim", m !== "manual");
  };
  function setMode(m: string) { speedMode = m; paintMode!(m); send({ type: "speed", mode: m }); }
  document.querySelectorAll<HTMLElement>(".mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode as string)));
  const ms = $<HTMLInputElement>("manual-speed");
  ms.value = String(manualSpeed); $("manual-val").textContent = manualSpeed + " px/s";
  ms.addEventListener("input", () => { manualSpeed = Number(ms.value); $("manual-val").textContent = manualSpeed + " px/s"; });
  ms.addEventListener("change", () => send({ type: "speed", mode: "manual", manual: manualSpeed }));
  paintMode(speedMode);

  window.addEventListener("keydown", (e) => {
    const ae = document.activeElement as HTMLElement;
    if (/INPUT|TEXTAREA/.test(ae.tagName)) {
      if (e.key === "Escape") ae.blur();
      return;
    }
    if (e.key === "/") { e.preventDefault(); $("cmd-input").focus(); }
    else if (e.key === "l" || e.key === "L") goLive();
    else if (e.key === "q" || e.key === "Q") toggleDrawer();
    else if (e.key === "e" || e.key === "E") toggleExport();
    else if (e.key === "Escape") { drawer.classList.remove("open"); pop.classList.add("hidden"); }
    else if (zoom && (e.key === "-" || e.key === "_")) zoom.zoomBy(0.5);
    else if (zoom && (e.key === "=" || e.key === "+")) zoom.zoomBy(2);
    else if (zoom && e.key === "0") zoom.reset();
  });

  // ---------- export ----------
  const xpop = $("export-pop");
  let exportScale = 0.5;
  function toggleExport(open?: boolean) {
    const show = open ?? xpop.classList.contains("hidden");
    xpop.classList.toggle("hidden", !show);
    if (show) {
      const n = strips.maxIndex + 1, w = n * SW();
      $("export-meta").textContent = `${n} strips · ${Math.round(w * exportScale).toLocaleString()} × ${Math.round(config.height * exportScale)} px`;
    }
  }
  $("export-btn").addEventListener("click", (e) => { e.stopPropagation(); pop.classList.add("hidden"); toggleExport(); });
  document.addEventListener("pointerdown", (e) => { if (!xpop.contains(e.target as Node) && !$("export-btn").contains(e.target as Node)) xpop.classList.add("hidden"); });
  document.querySelectorAll<HTMLButtonElement>("#export-scale button").forEach((b) => b.addEventListener("click", () => {
    exportScale = Number(b.dataset.s);
    document.querySelectorAll("#export-scale button").forEach((x) => x.classList.toggle("on", x === b));
    toggleExport(true);
  }));
  $("export-go").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("export-go");
    btn.disabled = true; btn.textContent = "Stitching…";
    try {
      const r = await fetch(httpBase() + "/export.png?scale=" + exportScale);
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `infinite-tapestry-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast("Tapestry exported · " + (blob.size / 1e6).toFixed(1) + " MB");
      xpop.classList.add("hidden");
    } catch (err) {
      toast("Export failed. Is the GPU server running?");
    } finally {
      btn.disabled = false; btn.textContent = "Download PNG";
    }
  });

  // ---------- drawer / queue ----------
  function toggleDrawer(open?: boolean) { drawer.classList.toggle("open", open); }
  $("queue-btn").addEventListener("click", () => toggleDrawer());
  $("drawer-close").addEventListener("click", () => toggleDrawer(false));
  $("autopilot").addEventListener("change", () => send({ type: "autopilot", enabled: $<HTMLInputElement>("autopilot").checked }));
  const vibe = $<HTMLInputElement>("vibe");
  vibe.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); send({ type: "autopilot", vibe: vibe.value.trim() }); vibe.blur(); toast(vibe.value.trim() ? "Autopilot will lean toward “" + esc(vibe.value.trim()) + "”" : "Autopilot vibe cleared"); }
  });
  $("hold").addEventListener("change", () => send({ type: "configure", hold: Number($<HTMLInputElement>("hold").value) }));
  $("blend").addEventListener("change", () => send({ type: "configure", blend: Number($<HTMLInputElement>("blend").value) }));
  $("clear").addEventListener("click", () => send({ type: "clear" }));

  let upSeq = -1;  // latest canonical upcoming snapshot rendered
  window.addEventListener("tapestry:social", () => { if (director) { upSeq = -1; renderQueue(director); } });
  function renderQueue(d: Director) {
    const list = $("queue-list");
    if (typeof d.upcoming_seq === "number") {
      if (d.upcoming_seq < upSeq && d.upcoming_seq > 0) return;  // stale snapshot (server restart resets to small numbers)
      upSeq = d.upcoming_seq;
    }
    list.classList.remove("skeleton");
    // Public queue = user ideas only (planned user scenes, then every waiting idea in pick order). Never Auto.
    const items = (d.upcoming || d.items || []).filter((x) => x.origin !== "auto");
    window.dispatchEvent(new CustomEvent("tapestry:pool", { detail: items.filter((x) => x.kind === "idea").length }));
    $("queue-count").textContent = items.length ? String(items.length) : "";
    $("queue-empty").classList.toggle("hidden", items.length > 0);
    $("queue-empty").innerHTML = d.autopilot && d.autopilot.enabled ? '<span class="spark">✦</span>No ideas waiting. Auto is improvising.' : "Nothing queued. Type a destination below.";
    const cur = d.current_scene || { title: d.current, prompt: d.current };
    const tgt = d.target_scene;
    // Now playing: only a user idea is shown (Auto never appears in the queue).
    const now = [tgt, cur].find((x) => x && x.origin === "user");
    const cc = $("current-card");
    cc.classList.toggle("hidden", !now);
    cc.innerHTML = now ? `<div class="k">${now === tgt ? "Up now" : "Now"}<span class="src">${esc(credit(now.by, "user", { guestNames: true }))}</span></div>` +
      `<div class="t">${esc(ideaTitle(now.source || now.title, now.by, now.image))}</div>` : "";
    // Keyed in-place diff (Preact): unchanged rows keep their node, so the sheet never flashes.
    renderQueueList(list, items, window.TapestrySocial);
  }
  window.TapestryIdeaTitle = ideaTitle;
  function showDirector(d: Director) {
    if (!d) return;
    director = d;
    const cur = d.current_scene || { title: d.current };
    const tgt = d.target_scene;
    const next = tgt || ((d.upcoming || d.items) && (d.upcoming || d.items)![0]);
    const stripCap = histKey === null && liveCaption();
    if (histKey === null && !stripCap) {
      $("now-title").textContent = (cur.title || d.current) as string;
      $("now-arrow").classList.toggle("hidden", !next);
      $("next-title").textContent = next ? (next.title as string) : "";
    }
    const prog = tgt ? (d.transition_progress || 0) : Math.min(1, (d.held || 0) / Math.max(1, d.hold_for || d.hold || 1));
    $("now-bar").style.width = (prog * 100).toFixed(0) + "%";
    if (document.activeElement !== $("hold")) $<HTMLInputElement>("hold").value = d.hold as unknown as string;
    if (document.activeElement !== $("blend")) $<HTMLInputElement>("blend").value = d.blend as unknown as string;
    const ap = d.autopilot;
    if (ap) {
      $<HTMLInputElement>("autopilot").checked = !!ap.enabled;
      if (document.activeElement !== vibe) vibe.value = ap.vibe || "";
      $("auto-status").textContent = !ap.enabled ? "off" : ap.busy ? "dreaming up what's next…" : ap.error ? "improvising" : "";
    }
    const shown = tgt && (d.transition_progress || 0) >= 0.5 ? tgt : cur;
    const srcEl = $("now-src");
    if (histKey === null && !stripCap) srcEl.textContent = shown.origin === "auto" ? "✦ Auto" : shown.origin === "user" ? (shown.by ? "by " + shown.by : "You") : "Now";
    if (histKey === null && !stripCap) srcEl.className = "src" + (shown.origin === "auto" ? " auto" : "");
    renderQueue(d);
  }

  // ---------- stream ----------
  let interpreterOn = false;
  let lastOwnText: string | null | undefined = null;
  function handleJson(msg: ServerMsg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.gpu) gpu = msg.gpu;
    if (msg.type === "strip_scene" && Array.isArray(msg.s)) { timeline.addStripScene(msg.i as number, msg.s); return; }
    if (msg.type === "strip") { lastFreshAt = performance.now(); if (replay) endReplay(); strips.onRef(msg as import("../core/protocol").StripRef, true); return; }
    if (msg.type === "strips") { (msg.items || []).forEach((r) => strips.onRef(r, false)); return; }
    if (msg.director) showDirector(msg.director);
    if (msg.type === "config") {
      wsConfigSeen = true;
      config = Object.assign(config, msg);
      interpreterOn = !!msg.interpreter;
      delete config.type;
      window.dispatchEvent(new CustomEvent("tapestry:config", { detail: msg }));
    } else if (msg.type === "ping") {
      send({ type: "pong" });
    } else if (msg.type === "clock") {
      onClock(msg as import("../core/protocol").ClockMsg);
    } else if (msg.type === "react") {
      window.dispatchEvent(new CustomEvent("tapestry:react", { detail: msg }));
    } else if (msg.type === "fuel" || msg.type === "activity" || msg.type === "auth") {
      window.dispatchEvent(new CustomEvent("tapestry:" + msg.type, { detail: msg }));
    } else if (msg.type === "notice") {
      pending.clear(); $("cmd").classList.remove("busy");
      toast(esc(msg.text), 3500);
    } else if (msg.type === "plan") {
      pending.delete(msg.req as number);
      lastOwnText = msg.text;
      if (!pending.size) $("cmd").classList.remove("busy");
      const p = msg.plan || {};
      const titles = (msg.scenes || []).map((s) => esc(s.title)).join(" → ");
      if (document.body.classList.contains("is-admin")) toast((p.source === "haiku" ? "Planned " : "Queued ") + titles +   // planner detail is admin-only; viewers just see the scene title
        (p.note ? `<br><span class="muted">${esc(p.note)}</span>` : ""), 6000);
    }
  }
  void lastOwnText;

  window.TapestryWS = { send: (o) => send(o), toast: (h, ms) => toast(h, ms), esc: (x) => esc(x) };
  // Read-only view hooks for reactions/clips (fun.js).
  Object.assign(window.TapestryView, { title: () => ($("now-title").textContent || "").trim(),
    by: () => ($("now-src").textContent || "").trim(),
    caption: () => centerScene() });
  function connect() {
    const url = wsUrl();
    const sock = new WebSocket(url + (url.includes("?") ? "&" : "?") + "v=2&bytes=1");   // bytes=1: live strip pixels ride the socket
    ws = sock;
    sock.binaryType = "arraybuffer";
    sock.onopen = () => {
      if (dropAt && window.TapestryOps) window.TapestryOps.report("reconnect", performance.now() - dropAt, { pod: podDown ? "down" : "running" });
      dropAt = 0;
      connected = true; everOpened = true;
      reconnectDelay = 1000;
      send({ type: "upcoming_request" });
      strips.clearRequested();
      lastMsgAt = performance.now();   // livePos is kept: the first clock eases toward the server instead of jumping
      if (clientPingTimer) clearInterval(clientPingTimer);
      clientPingTimer = window.setInterval(() => send({ type: "ping" }), 25000);
      send({ type: "status_request" });
      const S = window.TapestrySocial;
      if (S && S.token()) send({ type: "auth", token: S.token() as string });
      window.__tapestryWsOpen = true; window.dispatchEvent(new CustomEvent("tapestry:ws", { detail: { open: true } }));
    };
    sock.onmessage = (ev) => {
      lastMsgAt = performance.now();
      if (typeof ev.data === "string") {
        try { handleJson(JSON.parse(ev.data)); } catch (e) { console.warn("bad json", e); }
      } else {
        strips.onBinary(ev.data);
      }
    };
    sock.onclose = (ev) => onWsClose(ev);
    sock.onerror = () => { try { sock.close(); } catch (_) { /* ignore */ } };
  }
  function onWsClose(ev: { code?: number } | null) {
    if (connected && !document.hidden && window.TapestryOps) window.TapestryOps.report("disconnect", 0, { code: String((ev && ev.code) || 0), pod: podDown ? "down" : "running" });
    if (connected && !document.hidden) dropAt = performance.now();
    connected = false;
    window.__tapestryWsOpen = false; window.dispatchEvent(new CustomEvent("tapestry:ws", { detail: { open: false } }));
    if (clientPingTimer) clearInterval(clientPingTimer);
    const wait = reconnectDelay * (0.75 + Math.random() * 0.5);  // jitter
    setTimeout(connect, navigator.onLine === false ? 3000 : wait);
    reconnectDelay = Math.min(podDown ? 30000 : 4000, reconnectDelay * 1.6);
  }
  // Dead-socket watchdog: the server sends a clock/status/ping at least every 5 s, so ~10 s of silence means the TCP
  // path died without a close (mobile handoff, proxy idle-kill). Drop it and reconnect now instead of minutes later.
  let lastMsgAt = performance.now();
  setInterval(() => {
    if (!connected || !ws || document.hidden || performance.now() - lastMsgAt < 10000) return;
    const dead = ws; dead.onclose = null; dead.onmessage = null; dead.onerror = null;
    try { dead.close(); } catch (_) { /* ignore */ }
    onWsClose({ code: 4000 });
  }, 2000);

  window.addEventListener("online", () => { if (!connected) { reconnectDelay = 1000; try { ws && ws.close(); } catch (_) { /* ignore */ } } });

  // ---------- keep the screen awake ----------
  let wakeLock: WakeLockSentinel | null = null;
  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible" && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch (_) { /* denied or unsupported: fine */ }
  }
  document.addEventListener("visibilitychange", keepAwake);
  ["pointerdown", "keydown"].forEach((e) => window.addEventListener(e, keepAwake, { once: true }));
  keepAwake();

  // ---------- ambient mode: canvas only, full screen ----------
  function setAmbient(on: boolean) {
    document.body.classList.toggle("ambient", on);
    if (on) {
      drawer.classList.remove("open");
      document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
      toast("Ambient mode · press Esc or A to exit", 2200);
    } else if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }
  window.TapestryAmbient = setAmbient;
  window.addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA/.test((document.activeElement as HTMLElement).tagName)) return;
    if (e.key === "a" || e.key === "A") setAmbient(!document.body.classList.contains("ambient"));
    if (e.key === "Escape" && document.body.classList.contains("ambient")) setAmbient(false);
  });
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) document.body.classList.remove("ambient");
    resize();
  });
  // Fullscreen toggle (button or Shift+F) and "reveal": hide every piece of UI
  // while the pointer is held still on the canvas, or toggled with H.
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
  }
  const fsBtn = document.getElementById("fullscreen-btn");
  if (fsBtn) fsBtn.addEventListener("click", toggleFullscreen);
  const hideBtn = document.getElementById("hide-btn");
  if (hideBtn) hideBtn.addEventListener("click", () => { document.body.classList.add("reveal-lock"); toast("UI hidden · press H or tap to bring it back", 1800); });
  let holdTimer = 0, holdX = 0, holdY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    if (document.body.classList.contains("reveal-lock")) { document.body.classList.remove("reveal-lock"); return; }
    holdX = e.clientX; holdY = e.clientY;
    clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => document.body.classList.add("reveal"), 380);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (Math.hypot(e.clientX - holdX, e.clientY - holdY) > 6) clearTimeout(holdTimer);
  });
  const endHold = () => { clearTimeout(holdTimer); document.body.classList.remove("reveal"); };
  canvas.addEventListener("pointerup", endHold);
  canvas.addEventListener("pointercancel", endHold);
  window.addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA/.test((document.activeElement as HTMLElement).tagName)) return;
    if (e.key === "h" || e.key === "H") document.body.classList.toggle("reveal-lock");
    if (e.key === "F" && e.shiftKey) toggleFullscreen();
  });
  if (new URLSearchParams(location.search).has("ambient")) document.body.classList.add("ambient");

  // ---------- resilience: pod-independent bootstrap + replay fallback ----------
  // /api/live (Vercel + Supabase) serves the strip config and recent refs; strip images come from config.strip_base.
  // If live goes quiet (no new strip for a minute, or the pod is unreachable), quietly replay from a random spot in history.
  let podDown = false, liveChecked = false, podPollAt = performance.now();   // /api/live says the GPU is off or the stream is stale: calm "replay", not "reconnecting"
  let replayAt = 0, wsConfigSeen = false, replay = false, lastFreshAt = performance.now(), downSince = 0, replayBusy = false;

  // ---------- view date line (#amb-when, above the title): when the strip at the view centre was painted ----------
  // Polled 4x/s (no per-frame DOM work); the DOM is only touched when the text changes.
  {
    const whenEl = document.getElementById("amb-when");
    let whenTxt = "";
    const updateWhen = () => {
      if (!whenEl || document.hidden) return;
      let t = strips.maxIndex >= 0 ? timeline.whenAt(Math.max(0, Math.min(strips.maxIndex, Math.round(centerIdx())))) : null;
      if (t == null && motion.live && !replay && connected) t = Date.now() / 1000;   // following live with no index yet: live time
      const txt = fmtWhen(t);
      if (txt !== whenTxt) { whenTxt = txt; whenEl.textContent = txt; }
    };
    window.setInterval(updateWhen, 250);
  }
  // ---------- caption tick (10 Hz): keep the title on the strip at the view centre ----------
  // Scene titles come from strip refs (pod: WS history + /timeline; pod off: /api/live?start= 64-strip chunks, CDN
  // cached). Zoomed out or flying, the full-res strips (and so their refs) aren't requested, so the title used to
  // stay on the last known scene. Ask for the refs under the centre (and the next chunk in the pan direction) right
  // away, and dim the title while the centre strip's scene is unknown rather than show a neighbour's.
  {
    const titleEl = document.getElementById("amb-title");
    let pending = false;
    window.setInterval(() => {
      if (strips.maxIndex < 0 || document.hidden) return;
      const c = Math.max(0, Math.min(strips.maxIndex, Math.round(centerIdx())));
      const known = timeline.points.length > 0 || timeline.seen.has(c) || strips.has(c);
      if (!known) { if (connected) strips.requestMissing(Math.max(0, c - 8), c + 8); else apiMissing(c - 8, c + 8); }
      // Pod off: also fetch the refs the view will reach in the next ~0.8 s (fast pans), up to 6 chunks ahead.
      const sps = cam.velS / SW();
      if (!connected && Math.abs(sps) > 2) {
        const span = Math.min(6 * 64, Math.abs(sps) * 0.8), dir = Math.sign(sps);
        for (let d = 32; d <= span; d += 64) { const i = c + dir * d; if (i >= 0 && i <= strips.maxIndex && !timeline.seen.has(i) && !strips.has(i)) apiMissing(i - 8, i + 8); }
      }
      const p = !known && !motion.live;
      if (p !== pending && titleEl) { pending = p; titleEl.classList.toggle("cap-pending", p); }
    }, 100);
  }
  const apiReq = new Set<number>();
  function apiMissing(a: number, b: number) {
    a = Math.max(0, a); b = Math.min(b, strips.maxIndex);
    for (let c = Math.floor(a / 64) * 64; c <= b; c += 64) {
      if (apiReq.has(c)) continue;
      let need = false; for (let i = Math.max(a, c); i <= Math.min(b, c + 63); i++) if (!strips.has(i)) { need = true; break; }
      if (!need) continue;
      apiReq.add(c);
      fetch("/api/live?start=" + c + "&end=" + (c + 63)).then((r) => r.json()).then((j: LiveApi) => (j.items || []).forEach((r) => strips.onRef(r, false)))
        .catch(() => {}).finally(() => setTimeout(() => apiReq.delete(c), 5000));
    }
  }
  function bootFromApi() {
    fetch("/api/live?n=240").then((r) => r.json()).then((j: LiveApi) => {
      if (!j || !j.config) return;
      if (!wsConfigSeen) {
        config = Object.assign(config, j.config);
        window.dispatchEvent(new CustomEvent("tapestry:config", { detail: j.config }));
      }
      const it = j.items || [];
      liveChecked = true;
      if (j.pod && j.pod.ws && j.pod.ws !== wsUrl() && !new URLSearchParams(location.search).get("ws")) {
        podWs = j.pod.ws;
        if (!connected && ws) { try { ws.onclose = null; ws.close(); } catch (_) { /* ignore */ } connect(); }
      }
      podDown = !!(j.pod && (j.pod.status !== "running" || j.pod.desired === "off")) || stale(j);
      // Pod down at load: choose replay BEFORE the first strips land, so the camera starts at the replay position
      // and the load-in plays on the strips being replayed (no live-edge frame, then a backward jump).
      if (podDown && !connected && strips.maxIndex < 0 && it.length >= 40 && motion.panMode === "live" && !motion.pendingSeek && !/[?&]at=/.test(location.search)) {
        const start = window.TapestryReplayStart(it[it.length - 1].i);   // random spot across the whole history
        replay = true; motion.live = false;
        strips.onRef(it[it.length - 1], false);   // sets maxIndex so the pan range covers the start position
        motion.panPos = cam.zoom < 1 ? Math.max(motion.restMin(), Math.min(motion.maxPan(), start * SW() - cam.viewCenter())) : Math.max(0, start * SW() - viewWorld() / 2);   // zoomed out: start at the centre, never in the start slack motion.panVel = 0; motion.panMode = "glide";
        lastFreshAt = performance.now() - 61000;
        apiMissing(start - 12, start + 12);   // on-screen refs first (the bootstrap only carries the newest 240)
        lod.prefetch(start);
      }
      if (it.length) strips.onRef(it[it.length - 1], false);   // newest first: the live view initialises at the real edge
      it.forEach((r) => strips.onRef(r, false));
      if (!connected && stale(j)) lastFreshAt = performance.now() - 61000;
    }).catch(() => {}).finally(() => { liveChecked = true; });
  }
  function fadeSwap(fn: () => void, done?: () => void) {   // compositor-only fade around a jump (no pop-in, no seek blur)
    replayBusy = true;
    canvas.style.transition = "opacity .7s ease"; canvas.style.opacity = "0";
    setTimeout(() => {
      fn();
      const t0 = performance.now();
      const wait = (): unknown => (renderer.coverage >= 0.95 || performance.now() - t0 > 2500) ? (canvas.style.opacity = "", setTimeout(() => { canvas.style.transition = ""; replayBusy = false; done && done(); }, 750)) : setTimeout(wait, 80);
      setTimeout(wait, 120);
    }, 720);
  }
  function startReplay() {
    if (replayBusy || strips.maxIndex < 40) return;
    if (!replay && !replayAt) { replayAt = performance.now(); window.TapestryOps && window.TapestryOps.report("replay", 0, { pod: podDown ? "down" : "running" }); }
    const start = window.TapestryReplayStart(strips.maxIndex);   // random spot across the whole history (also on each loop)
    fadeSwap(() => {
      replay = true;
      motion.enterHistory(); setAway(false);
      motion.panPos = cam.zoom < 1 ? Math.max(motion.restMin(), Math.min(motion.maxPan(), start * SW() - cam.viewCenter())) : Math.max(0, start * SW() - viewWorld() / 2);   // zoomed out: start at the centre, never in the start slack motion.panVel = 0; motion.panMode = "glide";
    });
    lod.prefetch(start);
  }
  function endReplay() {
    if (!replay || replayBusy) return;
    if (replayAt && window.TapestryOps) window.TapestryOps.report("away_from_live", performance.now() - replayAt, { reason: "replay" });
    replayAt = 0;
    fadeSwap(() => { replay = false; motion.panMode = "live"; motion.live = true; setAway(false); });
  }
  ["pointerdown", "wheel", "keydown"].forEach((e) => canvas.addEventListener(e, () => { if (replay && !replayBusy) { replay = false; if (replayAt && window.TapestryOps) window.TapestryOps.report("away_from_live", performance.now() - replayAt, { reason: "user_took_over" }); replayAt = 0; } }, { capture: true, passive: true }));
  setInterval(() => {
    if (document.hidden || document.body.classList.contains("intro") || strips.maxIndex < 0) return;
    if (connected) downSince = 0; else if (!downSince) downSince = performance.now();
    if (!connected && performance.now() - (podPollAt || 0) > 60000) {   // GPU down: re-check its state and address
      podPollAt = performance.now();
      fetch("/api/live?n=1").then((r) => r.json()).then((j: LiveApi) => {
        if (!j || !j.pod) return;
        podDown = j.pod.status !== "running" || j.pod.desired === "off";
        if (j.pod.ws && j.pod.ws !== wsUrl() && !new URLSearchParams(location.search).get("ws")) podWs = j.pod.ws;
      }).catch(() => {});
    }
    // Pod known down: replay soon. Pod believed running (app restart/deploy is ~35-50 s, a proxy blip less): hold at
    // the live edge for 90 s instead of fading back into history, so a short drop never pulls viewers off live.
    const grace = podDown ? 15000 : 90000;
    const quiet = performance.now() - lastFreshAt > Math.max(60000, grace) || (downSince && performance.now() - downSince > grace);
    if (!quiet) return;
    if (motion.panMode === "live" && !replay) startReplay();
    else if (replay && motion.panMode === "live") startReplay();   // reached the end of the replay: loop
  }, 1000);
  bootFromApi();
  connect();
  requestAnimationFrame(renderer.frame);
}
