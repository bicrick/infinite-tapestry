// Composer and chat are plain <div>s, not <form>s (iOS shows its password/card/address bar for anything form-like).
// Give them form-style submit: requestSubmit(submitter) fires a cancelable "submit" event; [data-submit] buttons call it.
for (const id of ["cmd", "chat-form"]) {
  const el = document.getElementById(id);
  if (!el || el.tagName === "FORM") continue;
  el.requestSubmit = (submitter) => { const ev = new Event("submit", { cancelable: true }); ev.submitter = submitter || null; el.dispatchEvent(ev); };
  el.addEventListener("pointerdown", (e) => { if (e.target.closest && e.target.closest("[data-submit]")) e.preventDefault(); });   // keep focus (and the keyboard) on send
  el.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("[data-submit]"); if (b && el.contains(b)) { e.preventDefault(); el.requestSubmit(b); } });
}
const chatIn = document.getElementById("chat-input");
if (chatIn) chatIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); document.getElementById("chat-form").requestSubmit(); } });
/**
 * Infinite Tapestry browser client.
 * - Backend WS URL: ?ws=... > window.TAPESTRY_CONFIG.wsUrl > page origin (/ws).
 * - Auto speed follows GPU throughput; auto-planned scene queue; drag to pan.
 */
// Reliability telemetry: sampled (1 in 2 tabs), anonymous (random per-tab id), batched, beacon on hide.
(function () {
  const on = Math.random() < 0.5 && !/[?&]noops/.test(location.search), q = [];
  const sid = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);
  const build = String((window.TAPESTRY_CONFIG || {}).buildId || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
  const flush = () => {
    if (!q.length) return;
    const body = JSON.stringify({ sid, events: q.splice(0, 10) });
    try { if (!(navigator.sendBeacon && navigator.sendBeacon("/api/ops", new Blob([body], { type: "application/json" })))) fetch("/api/ops", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {}); } catch (_) {}
  };
  setInterval(flush, 30000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  addEventListener("pagehide", flush);
  window.TapestryOps = { report(type, ms, d) { if (!on || q.length > 30) return; q.push({ type, at: Date.now() - (ms || 0), ms: ms == null ? null : Math.round(ms), d: Object.assign({ build, hidden: document.hidden ? "1" : "0" }, d || {}) }); }, flush };
})();
(function () {
  "use strict";
  // Who suggested a scene: '@handle', 'a guest' or 'Auto'. The owner is never credited (shown as Auto).
  // Owner/system handles are never shown: they read as "Someone" (a user idea is never labelled Auto).
  const HIDDEN = new Set(["bicrick", "auto"]);
  function credit(by, origin, opts) {
    if (origin === "auto") return "Auto";
    const all = String(by || "").split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);
    const hs = all.filter((h) => !HIDDEN.has(h.toLowerCase()));
    if (!hs.length) return all.length ? "Someone" : (origin === "user" ? "a guest" : "Auto");
    const guestNames = opts && opts.guestNames;
    return hs.map((h) => (/^[a-z]+-\d{4}$/.test(h) ? (guestNames ? h : "a guest") : "@" + h)).filter((v, i, a) => a.indexOf(v) === i).join(", ");
  }
  window.TapestryCredit = credit;

  const $ = (id) => document.getElementById(id);
  const canvas = $("view");
  const ctx = canvas.getContext("2d", { alpha: false });
  // Missing image data never shows as black: stippled wireframe in the gaps, halftone bloom when pixels land (stipple-viewer.js).
  const fill = window.TapestryStipple ? window.TapestryStipple.create() : null;
  // Quiet (no wireframe, no blooms) under the intro and while the unified timeline covers this view or hands off to it,
  // so the frame it uncovers is exactly the plain live frame.
  const fillQuiet = () => { const c = document.body.classList; return c.contains("intro") || c.contains("u-tl") || c.contains("u-hold"); };
  const statusEl = $("status");
  const statusText = $("status-text");
  const DEBUG = /[?&]debug/.test(location.search);
  const liveBtn = $("live-btn");
  // Away from live: the "Return to live" pill takes the chat pill's place (crossfade); an open compose sheet closes, draft kept.
  { const dk = document.querySelector(".dock"); if (dk && liveBtn) dk.appendChild(liveBtn); liveBtn.classList.remove("hidden"); }
  function setAway(on) {
    if (document.body.classList.contains("away") === on) return;
    document.body.classList.toggle("away", on);
    if (on && document.body.classList.contains("composing")) { const i = $("cmd-input"); if (i) i.blur(); document.body.classList.remove("composing"); }
  }

  const MAGIC = "ITAP";
  const HEADER_SIZE = 16;
  const KEEP_DECODED = 48; // decoded bitmaps kept around the view

  let config = {
    height: 512, strip_width: 128, overlap: 32, scroll_speed: 30,
    scroll_speed_min: 8, buffer_target: 6, buffer_min: 2,
  };

  /** index -> {index, overlap, blob, bitmap, decoding, prompt} */
  const strips = new Map();
  let maxIndex = -1;
  let liveScroll = 0; // world px of the live view's left edge
  let panX = 0;
  let live = true;
  let speedMult = 1;
  let speedMode = "auto";
  let manualSpeed = 30;
  let gpu = null; // {px_per_sec, strips_per_sec, strip_seconds}
  let curSpeed = 0, smoothDesired = 0;
  let lastTs = 0;
  let ws = null;
  let reconnectDelay = 1000, dropAt = 0;   // dropAt: when a visible, open stream dropped (ops telemetry)
  let everOpened = false;   // initial connect shows nothing, never "reconnecting"
  let bufferDepth = 0;
  let bufferLow = false;
  let lastAckIndex = -1;
  let connected = false;
  let clientPingTimer = null;
  let ackTimer = 0;
  let director = null;
  const requested = new Set();
  let liveInitialized = false;

  let podWs = null;   // /api/live names the current pod (survives a RunPod migration without a rebuild)
  function wsUrl() {
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

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // Battery saver: drop to 1x resolution and ~30fps on low battery (Battery API) or data-saver.
  const saver = { on: false };
  window.TapestrySaver = saver;
  function resize() {
    const dpr = saver.on ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
  }
  window.addEventListener("resize", resize);
  resize();

  const SW = () => config.strip_width;
  // Portrait phones: the tapestry is a centred horizontal band (letterboxed), not a zoomed-in slice.
  const RIBBON = 0.6; let ribbon = innerHeight > innerWidth * 1.15 ? 1 : RIBBON, ribbonAnchor = 1;
  const portrait = () => canvas.height > canvas.width * 1.15;
  const BAND_ASPECT = 1.25;   // band width : height
  const scale = () => (portrait() ? Math.min(canvas.height, canvas.width / BAND_ASPECT) : canvas.height) / Math.max(1, config.height);
  let coverage = 0;
  let ambCv = null, ambCtx = null, surroundA = 1, bandCache = "";
  // Theme: follow the OS. Surround tint (rgb) + empty-canvas fill.
  const lightMq = window.matchMedia ? matchMedia("(prefers-color-scheme: light)") : null;
  let SURR = "5,5,6", EMPTY = "#050505", SURR_GLOW = 0.55;
  const applyTheme = () => { const l = !!(lightMq && lightMq.matches); SURR = l ? "244,239,231" : "5,5,6"; EMPTY = l ? "#f4efe7" : "#050505"; SURR_GLOW = l ? 0.7 : 0.55; };
  applyTheme(); if (lightMq && lightMq.addEventListener) lightMq.addEventListener("change", applyTheme);
  // Portrait band: centre at ~40% of the visible height, but never under the header row.
  const bandTopFor = (h, bh) => Math.max(Math.min(h - bh, 58 * (window.devicePixelRatio || 1)), Math.min(h - bh, h * 0.40 - bh / 2));
  function publishBand(top, bh, h) {
    const k = canvas.clientHeight / Math.max(1, h), t = Math.round(top * k), b = Math.round((top + bh) * k);
    const key = t + ":" + b;
    if (key === bandCache) return;
    bandCache = key;
    const r = document.documentElement.style;
    r.setProperty("--band-top", t + "px"); r.setProperty("--band-bot", b + "px");
  }
  function drawSurround(w, h, yOff, bandH) {
    // Plain field around the band; the colour comes from the drifting blob layer (#amb-blobs), not a per-frame mirror.
    if (yOff < 1) return;
    ctx.fillStyle = `rgb(${SURR})`;
    ctx.fillRect(0, 0, w, yOff); ctx.fillRect(0, yOff + bandH, w, h - yOff - bandH);
    const a = (Math.round(surroundA * 20) / 20).toFixed(2);
    if (a !== drawSurround.a) { drawSurround.a = a; document.documentElement.style.setProperty("--amb-a", a); }
    if (refl && drawSurround.v) refl.frame(drawSurround.v, yOff, bandH, w, h, surroundA);
  }
  // Reflection: shared module (static/refl.js), same tech in the live viewer and the Time Machine.
  const refl = window.TapestryReflection ? window.TapestryReflection.create(canvas, { surr: () => SURR, coarse: () => COARSE }) : null;
  const pastVeil = document.createElement("div"); pastVeil.id = "past-veil"; pastVeil.setAttribute("aria-hidden", "true"); canvas.after(pastVeil);
  // Reflection: a few soft colour blobs above/below the band, sampled from the strips on screen every ~2.5 s
  // (one tiny 6x2 readback), colours eased by CSS, motion by compositor-only transform animations.
  const ambBlobs = (() => {
    const root = document.createElement("div"); root.id = "amb-blobs"; root.setAttribute("aria-hidden", "true");
    root.innerHTML = '<div class="ab ab-top"><i></i><i></i><i></i></div><div class="ab ab-bot"><i></i><i></i><i></i></div>';
    canvas.after(root);
    return [...root.querySelectorAll("i")];
  })();
  setInterval(() => {
    const V = drawSurround.v; if (refl || !V || document.hidden) return;
    if (!ambCv) { ambCv = document.createElement("canvas"); ambCv.width = 6; ambCv.height = 2; ambCtx = ambCv.getContext("2d", { willReadFrequently: true }); }
    ambCtx.clearRect(0, 0, 6, 2); let any = false;
    for (let i = V.fi; i <= V.li; i++) { const e = strips.get(i); if (!e || !e.bitmap) continue; any = true;
      ambCtx.drawImage(e.bitmap, e.overlap || 0, 0, SW(), config.height, (i * SW() - V.left) / V.ww * 6, 0, SW() / V.ww * 6, 2); }
    if (!any) return;
    const d = ambCtx.getImageData(0, 0, 6, 2).data;
    ambBlobs.forEach((el, n) => { const row = n < 3 ? 0 : 1, x = (n % 3) * 2 + 1, o = (row * 6 + x) * 4;
      el.style.setProperty("--c", `rgb(${d[o]},${d[o + 1]},${d[o + 2]})`); });
  }, 2500);

  const viewWorld = () => canvas.width / scale();
  // Windowed: nudge up 3% to clear the dock. Fullscreen: true vertical centre (the lift left a big gap under the band).
  const ribbonTop = (h, bh) => (h * (1 - (document.fullscreenElement ? 0 : 0.06) * (1 - ribbon) / (1 - RIBBON)) - bh) / 2;
  // For the load-in: lets intro.js anchor its points to the same moving world as the canvas.
  window.TapestryView = { portrait: () => portrait(), band: () => { const s0 = scale(); if (portrait()) { const bh = config.height * s0; return { top: bandTopFor(canvas.height, bh), height: bh }; } const bh = config.height * s0 * ribbon; return { top: ribbonTop(canvas.height, bh), height: bh }; }, drawScale: () => scale() * (portrait() ? 1 : ribbon), setSurround: (a) => { surroundA = a; }, left: () => viewLeft(), scale: () => scale(), ready: () => maxIndex >= 0, coverage: () => coverage, zoom: () => zoom, canvas, center: () => centerIdx(), max: () => maxIndex, live: () => panMode === "live" };
  // Live may run right up to the newest strip (the server keeps a buffer ahead). Gating livePos on decode/hold-back
  // made it stop-and-go every strip (the jerk/pop-in reported after 0b04308), so the boundary is the painted edge again.
  const readyEdge = () => panoramaWidth();
  // Off-screen staging buffer: 2 strips + the inpaint context band, so repaints and arrivals happen out of view.
  // Calibrated hold-back: one full strip (the next arrival) + the inpaint band it repaints over its predecessor (+32px margin).
  // Together with the decode-aware limit below, the visible right edge only ever shows final pixels.
  let maxOv = 128, drawExcess = 0, drawCenter = null;
  const BAND = () => maxOv + 32;
  const STAGE = () => 2 * SW() + BAND();   // + one more full strip of margin (user-calibrated)
  const panoramaWidth = () => (maxIndex + 1) * SW();
  let nudge = 0, nudgeVel = 0;   // small elastic offset while live: jiggles move the view a little, never leave live
  const viewLeft = () => (panMode === "live" ? liveScroll + nudge : shownPan());

  function decodeStrip(buf) {
    const view = new DataView(buf);
    let magic = "";
    for (let i = 0; i < 4; i++) magic += String.fromCharCode(view.getUint8(i));
    if (magic !== MAGIC) return null;
    const index = view.getUint32(4);
    const overlap = view.getUint16(12);
    const promptLen = view.getUint16(14);
    const prompt = new TextDecoder().decode(new Uint8Array(buf, HEADER_SIZE, promptLen));
    const jpeg = buf.slice(HEADER_SIZE + promptLen);
    return { index, overlap, prompt, jpeg };
  }

  function onStripBinary(buf) {
    const m = decodeStrip(buf);
    if (!m) return;
    const prev = strips.get(m.index);
    if (prev && (prev.blob || !prev.url)) return;   // bytes only fill a CDN miss
    const entry = {
      index: m.index, overlap: m.overlap, prompt: m.prompt,
      blob: new Blob([m.jpeg], { type: config.strip_mime || "image/jpeg" }), bitmap: null, decoding: false,
    };
    strips.set(m.index, entry);
    requested.delete(m.index);
    if (m.index > maxIndex) {
      maxIndex = m.index;
      if (!liveInitialized) {
        // Start the live view near the newest strips on (re)connect.
        liveInitialized = true;
        liveScroll = Math.max(0, panoramaWidth() - viewWorld() - SW() * 2);
      }
    }
  }

  // v2 stream: the server sends small JSON refs; the JPEG comes from the public CDN.
  function onStripRef(r, live) {
    if (!r || typeof r.i !== "number") return;
    if (Array.isArray(r.s)) addStripScene(r.i, r.s);
    const base = config.strip_base;
    if (strips.has(r.i) || !base) return;
    const ext = config.strip_ext || "jpg";
    if (r.o > maxOv) maxOv = r.o;
    strips.set(r.i, { index: r.i, overlap: r.o || 0, prompt: r.p || "",
      url: base + String(r.i).padStart(8, "0") + "." + ext, blob: null, bitmap: null, decoding: false, tries: 0,
      fresh: !!live, readyAt: live ? performance.now() + 3500 : 0 });
    requested.delete(r.i);
    const e = strips.get(r.i);
    // Live refs are broadcast before the R2 upload finishes. Hold CDN fetches for ~3.5s so the
    // first request rarely 404s; history refs prefetch immediately.
    // History refs: prefetch only the newest few (the strips the first frame shows); the rest load as they come into
    // view. Prefetching all ~240 bootstrap refs at once queued the visible strips behind them on slow networks.
    if (!live && r.i >= Math.max(maxIndex, r.i) - 14) setTimeout(() => ensureDecoded(e), 0);
    if (r.i > maxIndex) {
      maxIndex = r.i;
      if (!liveInitialized) {
        liveInitialized = true;
        liveScroll = Math.max(0, panoramaWidth() - viewWorld() - SW() * 2);
      }
    }
  }

  function ensureDecoded(e) {
    if (e.bitmap || e.decoding) return;
    if (!e.blob) {
      if (!e.url || e.retryAt > performance.now()) return;
      if (e.readyAt && performance.now() < e.readyAt) { e.retryAt = e.readyAt; return; }
      e.decoding = true;
      fetch(e.url, { mode: "cors" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then((b) => { e.blob = b; e.decoding = false; ensureDecoded(e); })
        .catch(() => {
          // Fresh live strips are always .webp on R2 and may simply not have landed yet: retry R2 only (no .jpg / Supabase probes).
          if (e.fresh) {
            e.decoding = false; e.tries = (e.tries || 0) + 1;
            e.retryAt = performance.now() + Math.min(4000, 600 * e.tries);
            if (e.tries === 6) send({ type: "history", start: e.index, end: e.index, bytes: true });
            return;
          }
          // New uploads are .webp; pre-switch history is still .jpg on the CDN.
          if (e.url && e.url.endsWith(".webp") && !e.triedJpg) {
            e.triedJpg = true;
            e.url = e.url.slice(0, -5) + ".jpg";
            e.decoding = false;
            e.retryAt = 0;
            ensureDecoded(e);
            return;
          }
          e.decoding = false;
          e.tries = (e.tries || 0) + 1;
          e.retryAt = performance.now() + Math.min(8000, 700 * e.tries);
          // Not on the CDN yet (just painted) or an old strip never mirrored: ask the pod for bytes.
          if (e.tries === 3) send({ type: "history", start: e.index, end: e.index, bytes: true });
        });
      return;
    }
    e.decoding = true;
    createImageBitmap(e.blob).then((bm) => { e.bitmap = bm; e.decoding = false; },
      () => { e.decoding = false; });
  }

  // Long sessions: keep decoded bitmaps only near the view and compressed
  // blobs only within KEEP_BLOBS strips of the view or the live edge; anything
  // else is dropped and re-fetched from the server when panned to.
  const KEEP_BLOBS = 360;
  let evictTick = 0;
  function evictFar(firstIdx, lastIdx) {
    const liveIdx = Math.floor(liveScroll / SW());
    const sweepBlobs = (++evictTick % 60) === 0;
    for (const [i, e] of strips) {
      if (e.bitmap && (i < firstIdx - KEEP_DECODED || i > lastIdx + KEEP_DECODED)) {
        e.bitmap.close && e.bitmap.close();
        e.bitmap = null;
      }
      if (sweepBlobs && Math.abs(i - firstIdx) > KEEP_BLOBS && Math.abs(i - liveIdx) > KEEP_BLOBS) {
        if (e.bitmap) { e.bitmap.close && e.bitmap.close(); }
        strips.delete(i);
      }
    }
  }

  function requestMissing(firstIdx, lastIdx) {
    if (!connected) { apiMissing(firstIdx, lastIdx); return; }
    let start = -1;
    for (let i = Math.max(0, firstIdx); i <= Math.min(lastIdx, maxIndex); i++) {
      if (!strips.has(i) && !requested.has(i)) {
        if (start < 0) start = i;
        requested.add(i);
      } else if (start >= 0) {
        send({ type: "history", start, end: i - 1 });
        start = -1;
      }
    }
    if (start >= 0) send({ type: "history", start, end: Math.min(lastIdx, maxIndex) });
  }

  // ---------- shared timeline ----------
  // The server owns one global scroll position (`pos` = world-x of the live
  // view's RIGHT edge) and speed, driven by a smoothed control loop that
  // follows the GPU. We extrapolate locally each frame and gently correct
  // toward the server's broadcast so every viewer sees the same place.
  let livePos = null;       // our estimate of the shared right-edge position
  let srvSpeed = 0;
  let clockOffset = 0;      // server_time - local_time (s)
  let viewers = 1;
  let shared = { mode: "auto", manual: 30, multiplier: 1 };

  function onClock(m) {
    const localNow = performance.now() / 1000;
    clockOffset = m.now - Date.now() / 1000;
    srvSpeed = m.speed;
    viewers = m.viewers || viewers;
    shared = { mode: m.mode, manual: m.manual, multiplier: m.multiplier };
    speedMode = m.mode; manualSpeed = m.manual; speedMult = m.multiplier;
    syncSpeedUi();
    // Server pos is as of m.ts; project to now.
    const projected = m.pos + m.speed * Math.max(0, m.now - m.ts);
    if (livePos === null || Math.abs(projected - livePos) > SW() * 6) livePos = projected;
    else corr = projected - livePos;
    lastClockAt = localNow;
  }
  let corr = 0, lastClockAt = 0;

  const COARSE = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
  const PHONE = matchMedia("all");   // desktop mirrors the phone experience
  let wheelGlide = false, landAt = 0;    // haptic-wheel flick: long, low-friction coast (iOS picker feel)
  let zoom = 1, zoomVel = 0, velS = 0, prevCenter = null, blurCv = null, blurCtx = null;

  // ---------- LOD tiles (served from the GPU box, mirrored in Storage) ----------
  const LOD_N = { 1: 16, 2: 64, 3: 256 };
  const lodCache = new Map();
  function lodTile(level, c) {
    const key = level + ":" + c;
    let t = lodCache.get(key);
    if (!t) {
      if ((c + 1) * LOD_N[level] > maxIndex) return null;   // chunk still filling
      t = { img: new Image(), ok: false, used: 0 };
      t.img.crossOrigin = "anonymous";
      t.img.onload = () => { t.ok = true; };
      const pod = `${httpBase()}/lod/${level}/${c}.jpg`;
      // CDN first; a tile not mirrored yet falls back to the pod once (which builds and mirrors it).
      const fbTile = null;   // R2 only: no Supabase fallback (it 400s for anything not mirrored there)
      t.img.onerror = () => {
        if (fbTile && !t.fbTried && t.img.src !== pod) { t.fbTried = true; t.img.src = fbTile; }
        else if (t.img.src !== pod && !t.podTried) { t.podTried = true; t.img.src = pod; } else t.failed = true;
      };
      t.img.src = config.lod_base ? `${config.lod_base}${level}/${String(c).padStart(6, "0")}.jpg` : pod;
      lodCache.set(key, t);
      if (lodCache.size > 400) { const oldest = [...lodCache.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 100); oldest.forEach(([k]) => lodCache.delete(k)); }
    }
    t.used = performance.now();
    return t.ok ? t.img : null;
  }
  function lodDraw(img, key, x, tw, left, quarter) {   // quarter: draw one quarter of a coarser tile
    const a = fill ? fill.paint(x, x + tw, key, img, quarter == null ? null : [quarter / 4, 0, (quarter + 1) / 4, 1]) : 1;
    if (a <= 0) return;
    if (a < 1) ctx.globalAlpha = a;
    if (quarter == null) ctx.drawImage(img, x - left, 0, tw, config.height);
    else { const part = img.width / 4; ctx.drawImage(img, quarter * part, 0, part, img.height, x - left, 0, tw, config.height); }
    ctx.globalAlpha = 1;
  }
  function drawLodChunk(level, c, left) {
    const tw = LOD_N[level] * SW();
    const img = lodTile(level, c);
    if (img) { lodDraw(img, "L" + level + ":" + c, c * tw, tw, left); return; }
    // Gap: the L2 overview is prefetched for all history, so slice it (blurry beats blank);
    // from L3 also try finer tiles (needed at the still-filling live edge).
    if (level !== 2) {
      const p = LOD_N[2], cc = Math.floor(c * LOD_N[level] / p), t2 = lodTile(2, cc);
      if (t2 && level === 1) { lodDraw(t2, "L2:" + cc + ":" + (c % 4), c * tw, tw, left, c % 4); return; }
    }
    if (level > 1) for (let k = 0; k < 4; k++) drawLodChunk(level - 1, c * 4 + k, left);   // finer tiles fill the gap
  }
  let thumbCv = null, thumbCtx = null, zoneCv = null, zoneCtx = null, zoneMask = null;
  function stripThumb(e) {   // 8x24 colour sample per strip, computed once (cheap dot colours, no canvas readback per frame)
    if (e.th !== undefined) return e.th;
    if (!e.bitmap) return null;
    if (!thumbCv) { thumbCv = document.createElement("canvas"); thumbCv.width = 8; thumbCv.height = 24; thumbCtx = thumbCv.getContext("2d", { willReadFrequently: true }); }
    try { thumbCtx.drawImage(e.bitmap, e.overlap || 0, 0, SW(), config.height, 0, 0, 8, 24); e.th = thumbCtx.getImageData(0, 0, 8, 24).data; } catch (_) { e.th = null; }
    return e.th;
  }
  function drawLod(left, span, z) {
    const level = z > 0.55 ? 1 : z > 0.14 ? 2 : 3;
    const tw = LOD_N[level] * SW();
    const c0 = Math.max(0, Math.floor(left / tw)), c1 = Math.floor((left + span) / tw);
    for (let c = c0; c <= c1; c++) drawLodChunk(level, c, left);
    // prefetch a few tiles ahead in the direction of travel (more when moving fast)
    const n = Math.abs(velS) > 20000 ? 4 : 2;
    for (let k = 1; k <= n; k++) { const ahead = velS > 0 ? c1 + k : c0 - k; if (ahead >= 0) lodTile(level, ahead); }
  }

  // ---------- timeline scrubber ----------
  let tlPoints = [], tlScrub = false, tlScenes = [], histKey = null, histTime = "", swapT = 0;
  // Live captions while scrubbing: the caption follows the scene under the centre of the view.
  function sceneAt(idx) {
    let lo = 0, hi = tlScenes.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (tlScenes[m][0] <= idx) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans < 0 ? null : tlScenes[ans];
  }
  // Append live per-strip scene labels (server sends one after each strip).
  // Strip refs arrive live (WS) and out of order from /api/live (bootstrap newest-first, history ranges), so
  // insert in index order: replay and history get the same per-strip titles as live, with or without the pod.
  function addStripScene(i, sc) {
    if (!sc || !sc[0]) return;
    const same = (r) => r && r[1] === sc[0] && r[2] === sc[1] && r[3] === sc[2] && r[4] === sc[3];
    let lo = 0, hi = tlScenes.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tlScenes[m][0] < i) lo = m + 1; else hi = m; }
    const prev = tlScenes[lo - 1], next = tlScenes[lo];
    if (next && next[0] === i) return;            // already known
    if (same(prev)) return;                       // inside a known run of this scene
    if (same(next)) { next[0] = i; return; }      // the run starts earlier than we knew
    tlScenes.splice(lo, 0, [i, sc[0], sc[1], sc[2], sc[3]]);
  }
  let liveCapKey = null;
  function wireTitleClick(el) {
    if (!el || el.dataset.tipWired) return;
    el.dataset.tipWired = "1";
    let t = 0, long = false;
    el.addEventListener("click", (e) => { if (long) { long = false; return; } if (el.dataset.href) { e.stopPropagation(); window.open(el.dataset.href, "_blank", "noopener"); } });
    el.addEventListener("touchstart", () => { long = false; t = setTimeout(() => { long = true; el.classList.add("tip-on"); setTimeout(() => el.classList.remove("tip-on"), 1800); }, 450); }, { passive: true });
    el.addEventListener("touchend", () => clearTimeout(t), { passive: true });
    el.addEventListener("touchmove", () => clearTimeout(t), { passive: true });
  }
  wireTitleClick($("now-title"));
  wireTitleClick($("amb-title"));
  function srcLabel(by, origin) { const c = credit(by, origin); return c === "Auto" ? "✦ Auto" : by ? "by " + c : origin === "user" ? "Audience" : "Now"; }
  // On-stage title: tooltip with who suggested it, click opens the scene's share page (/s/<a>-<b>).
  // Wire both #now-title (dock) and #amb-title (visible ambient title); mobile.js only mirrors text.
  function stageTitle(index, title, by, origin) {
    const c = credit(by, origin);
    const tip = c === "Auto" ? "Auto" : "Suggested by " + c;
    let b = index + 15;
    for (const r of tlScenes) if (r[0] > index) { b = r[0] - 1; break; }
    const href = (typeof index === "number" && index >= 0) ? `/s/${index}-${Math.min(b, index + 63)}` : "";
    for (const id of ["now-title", "amb-title"]) {
      const el = $(id); if (!el) continue;
      el.dataset.tip = tip;
      if (href) el.dataset.href = href; else delete el.dataset.href;
    }
  }
  function centerScene() {
    if (!tlScenes.length) return null;
    const r = sceneAt(Math.max(0, Math.min(maxIndex, Math.round(centerIdx()))));
    return r ? { index: r[0], title: r[1], by: r[2], style: r[3], origin: r[4] } : null;
  }
  function emitCaption(r) {
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
        $("next-title").textContent = nxt ? nxt.title : "";
      }
      emitCaption(r0);
    }
    return true;
  }
  function histCaption() {
    if (live || !tlScenes.length) {
      if (histKey !== null) { histKey = null; liveCapKey = null; document.body.classList.remove("hist-cap"); $("now-time").textContent = ""; if (director) showDirector(director); }
      liveCaption();
      return;
    }
    const idx = Math.max(0, Math.min(maxIndex, Math.round(centerIdx())));
    const r = sceneAt(idx);
    const t = fmtTime(timeAt(idx));
    if (t !== histTime) { histTime = t; $("now-time").textContent = t; }
    if (!r) return;
    const key = r[0] + "|" + r[1];
    if (key === histKey) return;
    const first = histKey === null;
    histKey = key;
    document.body.classList.add("hist-cap");
    const cap = document.querySelector(".dock .now");
    const apply = () => {
      const [i0, title, by, style, origin] = r;
      $("now-title").textContent = title || "—";
      stageTitle(i0, title, by, origin);
      const src = $("now-src");
      const c = credit(by, origin);
      src.textContent = (c === "Auto" ? "✦ Auto" : by ? "by " + c : origin === "user" ? "Audience" : "Earlier") + (style && style !== "none" ? " · " + style : "");
      src.className = "src" + (origin === "auto" ? " auto" : "");
      $("now-arrow").classList.add("hidden"); $("next-title").textContent = "";
      cap && cap.classList.remove("swap");
    };
    clearTimeout(swapT);
    if (first || !cap) apply(); else { cap.classList.add("swap"); swapT = setTimeout(apply, 170); }
  }
  // One timer, ever. The old version re-armed a 2 s retry while the load-in was up AND kept a 60 s interval, so a tab
  // that never left the intro (hidden/background tabs don't draw) stacked a new 2 s loop every minute and hammered
  // /timeline. Now: wait for the load-in, skip hidden tabs, refresh every 60 s, refetch on becoming visible if stale.
  let tlAt = 0, tlTimer = 0, tlBusy = false;
  async function refreshTimeline() {
    clearTimeout(tlTimer); tlTimer = 0;
    if (document.body.classList.contains("intro") || document.hidden) { tlTimer = setTimeout(refreshTimeline, document.hidden ? 60000 : 2000); return; }
    if (tlBusy) return;
    tlBusy = true;
    try { const r = await fetch(httpBase() + "/timeline?points=300"); const j = await r.json(); tlPoints = j.points || []; tlScenes = j.scenes || tlScenes; tlAt = Date.now(); } catch (_) {}
    tlBusy = false;
    // the whole history at 1/16 is small: prefetch it so flights never hit an empty frame
    for (let c = 0; (c + 1) * LOD_N[2] <= maxIndex && c < 300; c++) lodTile(2, c);   // cached; only new tiles load
    tlTimer = setTimeout(refreshTimeline, 60000);
  }
  tlTimer = setTimeout(refreshTimeline, 1500);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - tlAt > 60000 && !tlBusy) refreshTimeline(); });
  function timeAt(idx) {
    const P = tlPoints;
    if (!P.length) return null;
    if (idx <= P[0][0]) return P[0][1];
    for (let k = 1; k < P.length; k++) if (P[k][0] >= idx) {
      const [i0, t0] = P[k - 1], [i1, t1] = P[k];
      return t0 + (t1 - t0) * ((idx - i0) / Math.max(1, i1 - i0));
    }
    const [il, tl] = P[P.length - 1];
    return tl + (idx - il) * (gpu && gpu.strip_seconds ? gpu.strip_seconds : 2);
  }
  function fmtTime(t) {
    if (t == null) return "";
    const d = new Date(t * 1000), now = new Date();
    const hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + hm;
  }
  // Centre of what's actually drawn (render offset + ribbon anchor included), as a strip index; strip i covers
  // [i*SW - overlap, (i+1)*SW - overlap), and the -0.5 makes callers' Math.round() pick the strip under the centre.
  function centerIdx() { const c = drawCenter != null ? drawCenter : viewLeft() + viewWorld() / 2; return (c + maxOv) / SW() - 0.5; }
  // The old bottom scrubber/wheel is gone (native scroll + swipe). The Back-to-live pill says how far back you are.
  let agoTxt = "";
  function agoLabel() {
    const t = timeAt(Math.max(0, Math.round(centerIdx()))), now = Date.now() / 1000;
    if (t == null) return "";
    const m = Math.max(0, (now - t) / 60);
    return m < 1.5 ? "" : m < 60 ? Math.round(m) + " min ago" : m < 36 * 60 ? (m / 60 < 10 ? (m / 60).toFixed(1).replace(/\.0$/, "") : Math.round(m / 60)) + " h ago" : fmtTime(t);
  }
  function updateTimeline() {
    if (maxIndex < 1) return;
    if (!live && liveBtn) {
      const a = agoLabel();
      if (a !== agoTxt) { agoTxt = a; const el = liveBtn.querySelector(".ago"); if (el) { el.textContent = a ? a + " · " : ""; } }
    }
    histCaption();
  }
  function jumpTo(idx) {
    enterHistory();
    const target = Math.max(0, Math.min(maxPan(), idx * SW() - viewWorld() / 2));
    seek = { from: shownPan(), to: target, t0: performance.now(), dur: Math.min(1600, 500 + Math.sqrt(Math.abs(target - shownPan())) * 6) };
    panMode = "seek"; panVel = 0;
  }
  window.TapestryJump = jumpTo;

  function frame(ts) {
    // ~30fps cap on 60 Hz+ displays. Threshold 24 ms (not 30): when the browser itself already throttles rAF to ~30 fps
    // (macOS Low Power Mode / Chrome Energy Saver) frames land at 28-36 ms, and a 30 ms gate dropped every other one (≈15 fps).
    if (saver.on && lastTs && ts - lastTs < 24) { requestAnimationFrame(frame); return; }
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    if (livePos !== null) {
      // Advance at the shared speed, bleed in the correction over ~1s,
      // and never run past what we've actually received.
      const fix = corr * Math.min(1, dt * 1.5);
      corr -= fix;
      // Soft limit: the visible edge may only reach strips that are received AND decoded (+ the staging zone).
      // Ease the speed down as the buffer thins instead of stopping, so new pixels never surface on screen.
      let k = Math.max(0, Math.floor((livePos - STAGE() + drawExcess + BAND()) / SW())); while (k <= maxIndex) { const e = strips.get(k); if (!e || !e.bitmap) break; k++; }
      const limit = Math.min(panoramaWidth() - drawExcess, k * SW() - BAND() + STAGE() - drawExcess);   // visible edge stays BAND short of strip k's repaint zone
      const ease = Math.max(0, Math.min(1, (limit - livePos) / (0.75 * SW())));
      if (livePos < limit) livePos = Math.min(limit, livePos + srvSpeed * dt * ease + Math.min(fix, Math.max(0, limit - livePos)));
      liveScroll = livePos - viewWorld();
    }
    stepPan(dt);
    if (!gesture && (nudge !== 0 || nudgeVel !== 0)) {   // spring the nudge back to the live edge
      const k = 220, c = 2 * Math.sqrt(k);
      nudgeVel += (-k * nudge - c * nudgeVel) * dt;
      nudge += nudgeVel * dt;
      if (Math.abs(nudge) < 0.3 && Math.abs(nudgeVel) < 3) { nudge = 0; nudgeVel = 0; }
    }
    {
      const L = viewLeft() - (panMode === "live" ? nudge : 0) + viewWorld() / 2;
      if (prevCenter !== null && dt > 0) {
        const v = (L - prevCenter) / dt;
        velS += (v - velS) * Math.min(1, dt * 10);
      }
      prevCenter = L;
      // Zoom out with speed: ~0.5x at 3k world px/s, ~0.05x when humming through hours.
      const zt = 1;   // no zoom-out while scrubbing anywhere (blur + wheel label instead)
      // Desktop ribbon: while the chrome is up the band eases down to a ribbon; idle -> full bleed.
      const b = document.body.classList;
      const rt = !portrait() && !b.contains("immersive") ? RIBBON : 1;   // ribbon always; full only via the fullscreen button
      ribbon += (rt - ribbon) * (1 - Math.exp(-dt * 4.2));
      if (Math.abs(ribbon - rt) < 0.0008) ribbon = rt;
      ribbonAnchor += ((panMode === "live" || panMode === "return" ? 1 : 0) - ribbonAnchor) * Math.min(1, dt * 5);
      // Spring zoom: out quickly as speed builds, snappy (slightly underdamped) back in on settle.
      if (zt < zoom) { zoom += (zt - zoom) * Math.min(1, dt * 6); zoomVel = 0; }
      else { const k = 90, c = 1.6 * Math.sqrt(k); zoomVel += (k * (zt - zoom) - c * zoomVel) * dt; zoom = Math.min(1.015, zoom + zoomVel * dt); }
      if (Math.abs(zoom - 1) < 0.001 && Math.abs(zoomVel) < 0.01) { zoom = 1; zoomVel = 0; }
    }
    // During the load-in the view is hidden behind the loader (opacity 0 until it resolves): paint it every other frame.
    // (only halve it on fast displays: at a throttled ~30 fps every frame is needed or the hand-over stutters)
    if (!(document.body.classList.contains("intro") && canvas.style.opacity === "" && dt < 0.02 && (frame.k = (frame.k || 0) + 1) % 2)) draw();
    updateTimeline();
    hudTimer += dt;
    if (hudTimer > 0.5) { hudTimer = 0; updateHud(srvSpeed, livePos === null ? 0 : panoramaWidth() - livePos); }
    requestAnimationFrame(frame);
  }
  let hudTimer = 1;

  function draw() {
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = EMPTY;
    ctx.fillRect(0, 0, w, h);
    if (maxIndex < 0) {
      if (fill) {   // no strips yet: the whole band is wireframe
        const s = scale() * zoom * ribbon, bh = config.height * s;
        const yOff = portrait() ? bandTopFor(h, config.height * scale()) + (config.height * scale() - bh) / 2 : ribbonTop(h, bh);
        fill.begin(fillQuiet()); fill.end(ctx, { left: 0, span: w / s, s, yOff, bandH: bh });
      }
      ctx.fillStyle = "rgba(255,255,255,.4)";
      ctx.font = `${14 * (window.devicePixelRatio || 1)}px Inter, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(connected ? "Painting the first strips…" : "Connecting…", w / 2, h / 2);
      return;
    }
    if (pendingSeek && maxIndex >= 0) {
      const ps = pendingSeek; pendingSeek = null;
      setTimeout(() => seekTo(ps[0], ps[1]), document.body.classList.contains("intro") ? 2400 : 300);
    }
    const s0 = scale();
    const s = s0 * zoom * ribbon;
    const center = viewLeft() + viewWorld() / 2 - STAGE();   // render offset: the newest 2 strips + the inpaint band stay off-screen (staging zone)
    // Never show blank canvas past the painted edge when the ribbon widens the view.
    const fullRight = viewLeft() + viewWorld() - STAGE();
    // Never let the drawn right edge pass the staged live line (centring a wide ribbon used to reveal the hold-back);
    // only an explicit rubber-band overscroll may peek past it.
    const left = Math.max(0, Math.min((center - (w / s) / 2) * (1 - ribbonAnchor) + (fullRight - w / s) * ribbonAnchor, fullRight - w / s));   // fullRight already carries any overscroll
    // Portrait band sits slightly above centre (optical centre); full-bleed otherwise.
    if (window.__probe) window.__probe.push(left);
    drawCenter = left + w / s / 2;
    {   // Past the live line (only during a rubber-band overscroll): veil it — blurred, dimmed — via one small CSS overlay.
      const ov = livePos !== null && panMode !== "live" ? Math.max(0, left + w / s - (livePos - STAGE())) : 0;
      if (window.__ov) __ov.push(ov);
      const px = Math.round(ov * s / (window.devicePixelRatio || 1));
      if (px !== draw.ovPx) { draw.ovPx = px; pastVeil.style.width = px + "px"; pastVeil.style.opacity = px > 0 ? "1" : "0"; }
    }
    if (livePos !== null) { drawExcess = Math.max(0, left + w / s - (livePos - STAGE())); window.__dx = drawExcess / SW(); }   // how far the drawn right edge reaches past the nominal staged edge (ribbon / zoom / portrait centring)
    const yOff = portrait() ? bandTopFor(h, config.height * s0) + (config.height * s0 - config.height * s) / 2 : ribbonTop(h, config.height * s);
    publishBand(yOff, config.height * s, h);
    const firstIdx = Math.max(0, Math.floor(left / SW()) - 1);
    const lastIdx = Math.ceil((left + w / s) / SW()) + 1;
    const fast = Math.abs(velS) > 1600;
    ctx.save();
    ctx.translate(0, yOff);
    ctx.scale(s, s);
    if (fill) fill.begin(fillQuiet());
    // Overview layer: LOD tiles under everything while zoomed out or when strips aren't loaded yet.
    const lodOn = !window.__nolod && (zoom < 0.97 || fast || coverage < 1); let fading = 0;
    if (lodOn) drawLod(left, w / s, zoom);   // LOD underlay until strips are in (never blank)
    {
      let want = 0, have = 0;
      const stripLayer = zoom > 0.3;
      for (let i = Math.max(firstIdx, 0); stripLayer && i <= Math.min(lastIdx, maxIndex); i++) {
        want++;
        const e = strips.get(i);
        if (!e) { continue; }
        if (!fast) ensureDecoded(e);
        if (!e.bitmap) continue;
        have++;
        const x0 = i * SW() - e.overlap;
        const ba = fill ? fill.paint(x0, x0 + e.bitmap.width, "s" + i, e.bitmap) : 1;   // < 1 only while it blooms out of the wireframe
        if (ba < 1 && e.seenAt == null) e.seenAt = -1e9;   // the bloom replaces the plain crossfade
        if (ba <= 0) continue;
        if (e.seenAt == null) e.seenAt = (x0 < left + w / s) ? performance.now() : -1e9;
        const fa = Math.min(1, (performance.now() - e.seenAt) / 1000);                                      // then crossfade it in over ~1 s
        if (fa < 1) { ctx.globalAlpha = fa * fa * (3 - 2 * fa); fading = (fa * 20 | 0) + 1; }
        if (ba < 1) { ctx.globalAlpha = ba; fading = 1; }
        ctx.drawImage(e.bitmap, x0 - left, 0);   // no live-edge clip: the old particle-era clip hid the next strip's inpaint band until it popped in
        ctx.globalAlpha = 1;
      }
      coverage = want ? have / want : 0;
    }
    if (fill) fill.end(ctx, { left, span: w / s, s, yOff, bandH: config.height * s });
    if (mark) {
      const age = (performance.now() - mark.t0) / 1000;
      const a = age < 0.6 ? age / 0.6 : age > 5.5 ? Math.max(0, 1 - (age - 5.5) / 1.5) : 1;
      if (a <= 0) mark = null;
      else {
        const x0 = mark.from * SW() - left, x1 = (mark.to + 1) * SW() - left, H = config.height;
        ctx.fillStyle = `rgba(0,0,0,${0.42 * a})`;
        ctx.fillRect(-10, 0, Math.max(0, x0 + 10), H);
        ctx.fillRect(x1, 0, Math.max(0, w / s - x1 + 10), H);
        ctx.fillStyle = `rgba(255,255,255,${0.75 * a})`;
        ctx.fillRect(x0, 6, x1 - x0, 1.2);
      }
    }
    ctx.restore();
    drawSurround.v = { left, ww: w / s, fi: Math.max(0, firstIdx), li: Math.min(lastIdx, maxIndex), cov: coverage, lod: lodOn, fading };
    if (portrait()) drawSurround(w, h, Math.max(0, yOff), config.height * s);
    else if (ribbon < 0.999) {   // desktop ribbon: same reflection/glow as the phone band, fading out as it expands
      const sa = surroundA, k = (1 - ribbon) / (1 - RIBBON); surroundA = sa * k * k * (3 - 2 * k);
      drawSurround(w, h, Math.max(0, yOff), config.height * s); surroundA = sa;
    } else if (drawSurround.a !== "0.00") { drawSurround.a = "0.00"; document.documentElement.style.setProperty("--amb-a", "0"); if (refl) refl.off(); }
    // Motion blur that scales with scrub velocity (cheap: smear the frame onto itself).
    const blur = (true ? Math.min(12, Math.max(0, (Math.abs(velS) - 500) / 420))
      : Math.min(28, Math.max(0, (Math.abs(velS) - 1400) / 260))) * (window.devicePixelRatio || 1);
    {   // Speed blur as a GPU-composited CSS filter (the old canvas readback smear dropped frames while scrubbing).
      const px = window.__noblur || !COARSE ? 0 : Math.round(Math.min(6, blur / (window.devicePixelRatio || 1) / 2) * 2) / 2;
      if (px !== draw.blurPx) { draw.blurPx = px; canvas.style.transition = px > 0.5 ? "none" : ""; canvas.style.filter = px > 0.5 ? `blur(${px}px)` : ""; }
    }
    if (!fast && zoom > 0.9) requestMissing(firstIdx - 8, lastIdx + 3);
    for (let i = lastIdx + 1; i <= Math.min(maxIndex, lastIdx + 3); i++) { const e = strips.get(i); if (e) ensureDecoded(e); }   // pre-decode the next strips so they never pop in
    evictFar(firstIdx, lastIdx);
  }

  // 'live · N watching' with an odometer for N; the prefix/suffix only re-render when they change.
  function setWatching(el, pre, post) {
    if (!el || !window.Odometer) { if (el) el.textContent = pre + viewers + post; return; }
    if (!el._odo) {
      el.textContent = "";
      el._pre = document.createElement("span"); el._num = document.createElement("span"); el._post = document.createElement("span"); el._num.classList.add("w-n"); el._post.classList.add("w-post");
      el.append(el._pre, el._num, el._post);
      el._odo = window.Odometer(el._num);
    }
    if (el._pre.textContent !== pre) el._pre.textContent = pre;
    if (el._post.textContent !== post) el._post.textContent = post;
    el._odo.set(viewers);
  }
  function resetWatching(el) { if (el && el._odo) { el._odo = null; } }
  function updateHud(speed, ahead) {
    const aheadStrips = Math.max(0, ahead / SW());
    statusEl.classList.toggle("off", !connected);
    statusEl.classList.toggle("warn", connected && live && aheadStrips < 1);
    statusEl.classList.toggle("replaying", !connected && (replay || podDown));
    if (!connected && (replay || podDown)) { resetWatching(statusText); resetWatching($("status-mini")); statusText.textContent = "replay"; const mi = $("status-mini"); if (mi) mi.textContent = "replay"; return; }
    if (!connected && (!liveChecked || !everOpened)) { statusText.textContent = ""; const mi = $("status-mini"); if (mi) mi.textContent = ""; return; }   // until /api/live answers
    if (!connected) { resetWatching(statusText); resetWatching($("status-mini")); statusText.textContent = "reconnecting"; const mi = $("status-mini"); if (mi) mi.textContent = "reconnecting"; return; }
    const parts = [];
    const S = window.TapestrySocial;
    if (!DEBUG && !(S && S.isAdmin())) {
      parts.push(replay ? "replay" : live ? "live" : "rewound");
      setWatching(statusText, parts.join("  ·  ") + "  ·  ", " watching");
      setWatching($("status-mini"), parts.join("  ·  ") + "  ·  ", " watching");
      syncSpeedUi();
      return;
    }
    if (!live) parts.push("history · strip " + Math.floor(viewLeft() / SW()) + "/" + maxIndex);
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
  function syncSpeedUi() {
    if (typeof paintMode === "function") paintMode(speedMode);
    if (document.activeElement !== $("manual-speed")) { $("manual-speed").value = manualSpeed; $("manual-val").textContent = Math.round(manualSpeed) + " px/s"; }
    $("speed-btn").textContent = (speedMode === "auto" ? "Auto" : Math.round(manualSpeed) + " px/s");
  }

  // ---------- pan physics: drag / wheel momentum, rubber-band, spring back ----------
  // panPos is the raw (unclamped) left edge while browsing history. Bounds are
  // [0, liveScroll]; beyond them the view rubber-bands. Releasing past the
  // live edge springs into live mode.
  let panPos = 0, panVel = 0;            // world px, world px/s
  let panMode = "live";                  // live | drag | glide | wheel | return
  let samples = [];                      // [t, x] pointer history for velocity
  let wheelIdleAt = 0;
  let ret = null;                        // {from, t0, dur}
  const FRICTION = 3.2;                  // 1/s, exponential decay of glide velocity
  const pxToWorld = () => (canvas.width / Math.max(1, canvas.clientWidth)) / scale();
  const minPan = () => 0;
  const maxPan = () => Math.max(0, liveScroll);

  const OVER_MAX = () => Math.min(viewWorld() * 0.08, SW() * 0.5);
  function rubber(x) {
    // iOS-style: resistance grows with overscroll distance.
    const lo = minPan(), hi = maxPan(), d = viewWorld() * 0.5;
    const f = (o) => (1 - 1 / (o / d * 0.55 + 1)) * d;
    if (x < lo) return lo - f(lo - x);
    if (x > hi) return hi + Math.min(OVER_MAX(), f(x - hi) * 0.35);   // small rubber-band past live (springs back; staged pixels stay hidden)
    return x;
  }
  function shownPan() { return rubber(panPos); }

  function enterHistory() {
    if (panMode === "live" || panMode === "return") {
      panPos = panMode === "return" ? shownPan() : Math.max(0, liveScroll);
      ret = null;
    }
    if (live && typeof refreshTimeline === "function") refreshTimeline();   // fresh scene index for captions
    live = false;
    setAway(true);
  }

  // ---------- permalinks: ?at=<strip>[&to=<strip>] ----------
  let mark = null, seek = null;
  function seekTo(from, to) {
    wheelGlide = false;
    if (maxIndex < 0) { pendingSeek = [from, to]; return; }
    from = Math.max(0, Math.min(from, maxIndex)); to = Math.max(from, Math.min(to ?? from + 8, maxIndex));
    enterHistory();
    const span = (to - from + 1) * SW();
    const target = Math.max(0, from * SW() - Math.max(0, (viewWorld() - span) / 2));
    seek = { from: shownPan(), to: target, t0: performance.now(), dur: Math.min(2200, 600 + Math.sqrt(Math.abs(target - shownPan())) * 12) };
    panMode = "seek"; panVel = 0;
    mark = { from, to, t0: performance.now() + seek.dur * 0.6 };
  }
  let pendingSeek = null;
  window.TapestrySeek = seekTo;
  {
    const q = new URLSearchParams(location.search);
    if (q.has("at")) pendingSeek = [parseInt(q.get("at"), 10) || 0, q.has("to") ? parseInt(q.get("to"), 10) : null];
  }

  function startReturn() {
    wheelGlide = false;
    enterHistory();
    const dist = Math.abs(maxPan() - shownPan());
    ret = { from: shownPan(), t0: performance.now(), dur: Math.min(1100, 420 + Math.sqrt(dist) * 9) };
    panMode = "return";
    panVel = 0;
    setAway(false);
  }
  // Gentle spring: easeOutBack with a small overshoot.
  const easeSpring = (t) => 1 - Math.pow(1 - t, 3);   // ease-out, no overshoot (overshoot carried the view past live)

  let driftVel = 0, driftAcc = 0, driftArm = 0, turbo = 0;
  function holdDrift() { driftVel = 0; driftAcc = 0; driftArm = 0; }
  // ---------- arrow-key flight ----------
  // Hold ← / → : slow, sustained acceleration that keeps building (exponential ramp, capped) until you're flying.
  // Opposite arrow while moving = hard brake (quick deceleration, not a dead stop); keep holding and it reverses.
  // Release: hand the velocity to the glide with loose (turbo) friction, which settles and drifts back to live pace.
  // Driven by the main rAF loop (stepPan); wheel / drag / touch cancel it instantly so it never fights native scroll.
  const fly = { dir: 0, keys: new Set() };
  const FLY_BASE = () => SW() * 0.9;       // world px/s² at a standstill
  const FLY_GROW = 0.55;                    // 1/s: acceleration grows with speed -> long, building ramp
  const FLY_MAX = () => SW() * 60;          // ~60 strips/s top speed
  const FLY_BRAKE = 7.0;                    // 1/s exponential brake + a linear floor below
  function flyKey(e, down) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const d = e.key === "ArrowRight" ? 1 : -1;
    if (down) fly.keys.add(d); else fly.keys.delete(d);
    const prev = fly.dir;
    fly.dir = fly.keys.has(d) && down ? d : fly.keys.has(-d) ? -d : fly.keys.has(d) ? d : 0;
    if (fly.dir && !prev) {
      if (fly.dir > 0 && (panMode === "live" || panMode === "return")) { fly.dir = 0; return true; }   // already at the live edge
      wheelGlide = false; tlScrub = false;
      if (panMode === "live" || panMode === "return") enterHistory();
      if (panMode !== "fly") { panVel = panMode === "glide" ? panVel : 0; panMode = "fly"; }
    }
    if (!fly.dir && panMode === "fly") { turbo = Math.min(1, Math.abs(panVel) / (SW() * 8)); panMode = "glide"; }
    return true;
  }
  function flyCancel() { fly.keys.clear(); fly.dir = 0; }
  addEventListener("blur", () => { flyCancel(); if (panMode === "fly") panMode = "glide"; });
  function stepFly(dt) {
    const hi = maxPan(), lo = minPan(), d = fly.dir;
    if (!d) { panMode = "glide"; return; }
    if (panVel * d < 0) {                   // braking against the motion
      const v = Math.abs(panVel), nv = Math.max(0, v * Math.exp(-FLY_BRAKE * dt) - SW() * 6 * dt);
      panVel = Math.sign(panVel) * nv;
    } else {
      const v = Math.abs(panVel);
      panVel = d * Math.min(FLY_MAX(), v + (FLY_BASE() + FLY_GROW * v) * dt);
    }
    panPos += panVel * dt;
    if (panPos >= hi && panVel > 0) { panPos = hi; panVel = 0; flyCancel(); panMode = "live"; live = true; setAway(false); return; }
    if (panPos <= lo && panVel < 0) { panPos = lo; panVel = 0; }
    if (performance.now() - landAt > 250) {   // prefetch ahead of the flight
      landAt = performance.now();
      const land = (panPos + panVel * 0.6 + viewWorld() / 2) / SW();
      const a0 = Math.max(0, Math.floor(land) - 8), b0 = Math.min(maxIndex, Math.ceil(land) + 8);
      if (b0 >= a0) requestMissing(a0, b0);
      for (let L = 1; L <= 2; L++) { const c = Math.floor(land / LOD_N[L]); for (let k = -1; k <= 1; k++) if (c + k >= 0) lodTile(L, c + k); }
    }
  }
  window.addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable) return;
    if (document.getElementById("drawer").classList.contains("open")) return;
    if (flyKey(e, true)) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => { flyKey(e, false); });

  function stepPan(dt) {
    if (panMode === "live") return;
    if (panMode === "fly") { if (gesture || tlScrub) { flyCancel(); panMode = "drag"; } else { stepFly(dt); return; } }
    if (panMode !== "glide" || gesture || tlScrub) holdDrift();   // held / scrubbing / seeking: no drift
    const lo = minPan(), hi = maxPan();
    if (panMode === "seek") {
      const t = Math.min(1, (performance.now() - seek.t0) / seek.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;   // ease in-out cubic
      panPos = seek.from + (Math.min(seek.to, hi) - seek.from) * e;
      if (t >= 1) { panMode = "glide"; panVel = 0; }
      return;
    }
    if (panMode === "return") {
      const t = Math.min(1, (performance.now() - ret.t0) / ret.dur);
      panPos = ret.from + (hi - ret.from) * easeSpring(t);   // target tracks the moving live edge
      if (t >= 1) { panMode = "live"; live = true; }
      return;
    }
    if (panMode === "glide" || (panMode === "wheel" && performance.now() - wheelIdleAt > 140)) {
      panMode = "glide";
      const out = panPos < lo ? lo - panPos : panPos > hi ? hi - panPos : 0;
      if (out !== 0) {
        // Critically damped spring back to the bound.
        const k = 140, c = 2 * Math.sqrt(k);
        panVel += (k * out - c * panVel) * dt;
        panPos += panVel * dt;
        if (Math.abs(out) < 0.5 && Math.abs(panVel) < 5) {
          panPos = panPos > hi ? hi : Math.max(lo, panPos); panVel = 0;
          if (panPos >= hi - 0.5) { panMode = "live"; live = true; setAway(false); }
        }
      } else {
        // Friction: firm at normal speeds (~0.4-0.7s glide), loose once in turbo so it hums.
        if (performance.now() - wheelIdleAt > 250) turbo *= Math.exp(-1.2 * dt);
        panVel *= Math.exp(-(wheelGlide ? 2.0 : 7.5 - 6.3 * turbo) * dt);   // wheelGlide ≈ iOS 0.998/ms deceleration
        if (wheelGlide && performance.now() - landAt > 250) {   // prefetch where the coast will land
          landAt = performance.now();
          const land = (panPos + panVel / 2.0 + viewWorld() / 2) / SW();
          const a = Math.max(0, Math.floor(land) - 8), b = Math.min(maxIndex, Math.ceil(land) + 8);
          if (b >= a) requestMissing(a, b);
          for (let L = 1; L <= 2; L++) { const c = Math.floor(land / LOD_N[L]); for (let d = -1; d <= 1; d++) if (c + d >= 0) lodTile(L, c + d); }
        }
        panPos += panVel * dt;
        if (Math.abs(panVel) < 4) { panVel = 0; wheelGlide = false; }
        if (panPos >= hi - SW() * 0.25 || (Math.abs(panVel) < 60 && hi - panPos < viewWorld() * 0.5)) { startReturn(); return; }   // near the front: magnetic ease into live
        // Drift: once settled and the high-res strips are in, resume the slow forward drift with a
        // gelatinous spring ramp (0 → drift speed over ~1-1.5s, slight overshoot), never a jump.
        if (Math.abs(panVel) < 4 && !gesture && !tlScrub) {
          if (!driftArm && coverage >= 0.95) driftArm = performance.now();
          if (driftArm && performance.now() - driftArm > 300) {
            const target = Math.max(0, srvSpeed || (replay ? config.scroll_speed || 60 : 0)), k = 9, c = 2 * 0.72 * Math.sqrt(k);
            driftAcc += (k * (target - driftVel) - c * driftAcc) * dt;
            driftVel += driftAcc * dt;
            panPos += Math.max(0, driftVel) * dt;
            if (panPos >= hi) { panPos = hi; holdDrift(); panMode = "live"; live = true; setAway(false); return; }
          }
        } else holdDrift();
        // Gliding into the live edge with speed: just hand over to live.
        if (panPos >= hi && panVel > 0) { panPos = hi; panVel = 0; panMode = "live"; live = true; setAway(false); }
      }
    }
  }

  // ---------- gestures ----------
  // While live, input is "armed" rather than acted on: taps toggle the UI, small jiggles nudge the
  // view elastically and spring back, and only a deliberate backward drag/scroll/flick leaves live.
  const LEAVE_PX = 60;          // backward distance (CSS px) that commits to rewinding
  const FLICK_PX_MS = 0.6;      // or a fast backward flick (CSS px per ms) past FLICK_MIN_PX
  const FLICK_MIN_PX = 24;
  const NUDGE_MAX = 36;         // max elastic offset in CSS px while still live
  let activePointer = null, lastPX = 0;
  let gesture = null;           // {x0, t0, moved, wasIdle, armed, hist: [[t, x]]}
  const cssToWorld = () => pxToWorld();
  function commitRewind() {
    // Leave live from wherever the nudge left us, then continue as a normal drag.
    panPos = liveScroll + nudge; nudge = 0; nudgeVel = 0;
    panMode = "live";
    enterHistory();
    panMode = "drag";
    panVel = 0;
    samples = [[performance.now(), panPos]];
  }
  const EDGE_DEAD = 20;          // touch: leave the screen edges to iOS back/forward swipes
  const TOUCH_LOCK = 9;          // touch: px before we decide horizontal (scrub) vs anything else
  canvas.addEventListener("pointerdown", (ev) => {
    // A second finger (pinch) cancels a touch scrub that hasn't committed; a committed one just ends with momentum.
    if (activePointer !== null) { if (ev.pointerType === "touch" && gesture && gesture.touch) gesture.dead = true; return; }
    wheelGlide = false;
    activePointer = ev.pointerId;
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    if (ev.pointerType !== "touch") document.body.classList.add("dragging");
    lastPX = ev.clientX;
    const armed = panMode === "live";
    // Touch: the painting is never a scrubber. Taps toggle the UI; scrubbing is the timeline's job.
    // Touch: a tap toggles the UI; a clearly horizontal swipe scrubs time 1:1 with momentum (see pointermove).
    if (ev.pointerType === "touch") {
      gesture = { x0: ev.clientX, y0: ev.clientY, t0: performance.now(), moved: 0, wasIdle: document.body.classList.contains("idle"), armed, touch: true,
        dead: ev.clientX < EDGE_DEAD || ev.clientX > innerWidth - EDGE_DEAD, hist: [[performance.now(), ev.clientX]] };
      return;
    }
    gesture = { x0: ev.clientX, y0: ev.clientY, t0: performance.now(), moved: 0, wasIdle: document.body.classList.contains("idle"), armed, hist: [[performance.now(), ev.clientX]] };
    if (armed) return;
    panPos = shownPan();
    panMode = "drag";
    panVel = 0;
    samples = [[performance.now(), panPos]];
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
      if (gesture.armed && panMode !== "live") gesture.armed = false;
      if (gesture.armed && dx > 0) { gesture.armed = false; commitRewind(); }     // swipe right at live = back in time, 1:1 from here
      else if (!gesture.armed) { panPos = shownPan(); panMode = "drag"; panVel = 0; samples = [[now, panPos]]; }
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
      nudge = Math.min(0, lim * Math.tanh(raw / lim)); nudgeVel = 0;   // never past live
      lastPX = ev.clientX;
      return;
    }
    const dx = (ev.clientX - lastPX) * pxToWorld();
    lastPX = ev.clientX;
    // Apply drag in "shown" space so overscroll resists the finger.
    const lo = minPan(), hi = maxPan();
    const resist = panPos < lo || panPos > hi ? 0.45 : 1;
    panPos -= dx * resist;
    samples.push([now, panPos]);
    while (samples.length > 2 && now - samples[0][0] > 100) samples.shift();
  });
  const endDrag = (ev) => {
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
        panVel = Math.min(4000, v * 1000 * pxToWorld()) * -1;   // carry the flick's momentum back in time
        panMode = "glide";
      }
      return;   // otherwise we never left live: the nudge springs back in frame()
    }
    const now = performance.now();
    const s0 = samples[0], s1 = samples[samples.length - 1];
    const span = (s1[0] - s0[0]) / 1000;
    panVel = now - s1[0] > 80 || span <= 0 ? 0 : (s1[1] - s0[1]) / span;
    panVel = Math.max(-8000, Math.min(8000, panVel));
    panMode = "glide";
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((t) => canvas.addEventListener(t, () => document.body.classList.remove("dragging")));

  // Wheel / trackpad = time. Scroll DOWN travels back into history, UP comes forward (reaching the
  // live edge re-joins live). Each event is an impulse; impulses stack and accelerate with speed, so
  // repeated flicks build up to "humming" through hours, then friction lets it coast down.
  let wheelAcc = 0, wheelAccAt = 0;
  const WHEEL_MIN = 10;          // CSS px of same-direction scroll before engaging (ignores accidental deltas)
  const VMAX = 260000;           // world px/s ceiling in full turbo (~hours of history in seconds)
  const VNORM = 4500;            // ceiling for ordinary scrolling
  const TURBO_RATE = 1600;       // CSS px/s of wheel input (300ms window) that counts as turbo
  const wheelHist = [];
  let mwEndT = 0;
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey) return;      // pinch-zoom gesture: ignore
    const unit = ev.deltaMode === 1 ? 32 : ev.deltaMode === 2 ? innerHeight : 1;
    // Horizontal (trackpad swipe / shift+wheel) moves content with the fingers like a sideways page; vertical wheel down = back.
    const dx = ev.deltaX || (ev.shiftKey ? ev.deltaY : 0);
    const vert = !dx || (Math.abs(ev.deltaY) > Math.abs(dx) * 1.2 && !ev.shiftKey);
    const dCss = (vert ? -ev.deltaY : dx) * unit;   // + = forward in time
    const TV = window.TapestryView;
    if (!wheelHeld) TV.wheelStart();
    TV.wheelMove(-dCss);                    // same 1:1 wheel as the phone's haptic dial
    clearTimeout(mwEndT);
    mwEndT = setTimeout(() => TV.wheelEnd(true), 90);   // 1:1, no extra glide: the OS sends momentum
  }, { passive: false });
  // 1:1 drag API (desktop horizontal scroll / shift+wheel): drives the timeline in CSS px, then hands off to the same glide/drift.
  let wheelHeld = false;
  Object.assign(window.TapestryView, {
    offsetCss: () => viewLeft() / Math.max(1e-6, pxToWorld()),
    wheelStart() {
      if (panMode === "live" || panMode === "return") { panPos = panMode === "return" ? shownPan() : liveScroll + nudge; nudge = 0; nudgeVel = 0; panMode = "live"; enterHistory(); }
      else panPos = shownPan();
      wheelHeld = true; wheelGlide = false; tlScrub = true; panMode = "drag"; panVel = 0; turbo = 0; samples = [[performance.now(), panPos]];
    },
    wheelMove(dxCss) {
      const lo = minPan(), hi = maxPan(), resist = panPos < lo || panPos > hi ? 0.45 : 1;
      panPos -= dxCss * pxToWorld() * resist;
      const now = performance.now();
      samples.push([now, panPos]);
      while (samples.length > 2 && now - samples[0][0] > 100) samples.shift();
    },
    wheelEnd(noFling) {
      if (!wheelHeld) return;
      wheelHeld = false; tlScrub = false;
      const now = performance.now(), s0 = samples[0], s1 = samples[samples.length - 1];
      const span = (s1[0] - s0[0]) / 1000;
      panVel = now - s1[0] > 80 || span <= 0 ? 0 : (s1[1] - s0[1]) / span;
      const cap = 90000;
      panVel = noFling ? 0 : Math.max(-cap, Math.min(cap, panVel));   // touch: plain release velocity (iOS-like); wheel: OS momentum already applied
      wheelGlide = Math.abs(panVel) > 40;
      panMode = "glide";
    },
    scrubLabel() {
      const idx = Math.max(0, Math.min(maxIndex, Math.round(centerIdx())));
      const r = sceneAt(idx), t = fmtTime(timeAt(idx));
      return [t, r && r[1]].filter(Boolean).join(" · ");
    },
    speedCss: () => Math.abs(velS) / Math.max(1e-6, pxToWorld()),
    isLive: () => panMode === "live",
    gliding: () => (panMode === "glide" || panMode === "fly") && Math.abs(panVel) > 4,
  });
  function goLive() { if (!live || panMode !== "live") startReturn(); }
  liveBtn.addEventListener("click", goLive);

  // ---------- auto-hide chrome ----------
  let idleTimer = 0;
  const drawer = $("drawer");
  function poke(ms) {
    if (document.body.classList.contains("idle")) document.body.classList.remove("idle");   // no attribute write (and style recalc) per mousemove
    clearTimeout(idleTimer);
    // Don't count down during the load-in: the chrome hasn't even appeared yet.
    if (document.body.classList.contains("intro")) { idleTimer = setTimeout(poke, 400); return; }
    idleTimer = setTimeout(() => {
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
  function toast(html, ms = 4500) {
    const t = $("toast");
    t.classList.remove("nudge"); t.style.removeProperty("--nudge-top");
    t.innerHTML = html;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), ms);
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- command bar ----------
  let when = "end";
  document.querySelectorAll(".seg[role=group] button").forEach((b) => b.addEventListener("click", () => {
    when = b.dataset.when;
    document.querySelectorAll(".seg[role=group] button").forEach((x) => x.classList.toggle("on", x === b));
    $("cmd-input").focus();
  }));
  let reqId = 0, ideaBusy = false, ideaKey = {};
  const pending = new Set();
  $("cmd").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = $("cmd-input");
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
      Promise.resolve(S.submitIdea(text, ideaKey.key)).catch(() => false).then((ok) => {
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
    if (ev.key === "Enter" && !ev.isComposing && !(ev.metaKey || ev.ctrlKey || ev.shiftKey)) { ev.preventDefault(); $("cmd").requestSubmit(); return; }   // textarea: Enter sends
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey || ev.shiftKey)) {
      ev.preventDefault();
      const prev = when; when = "now";
      $("cmd").requestSubmit();
      when = prev;
    }
  });
  $("skip").addEventListener("click", () => { send({ type: "skip" }); toast("Moving to the next scene"); });

  // ---------- speed popover ----------
  const pop = $("speed-pop");
  $("speed-btn").addEventListener("click", (e) => { e.stopPropagation(); pop.classList.toggle("hidden"); });
  document.addEventListener("pointerdown", (e) => { if (!pop.contains(e.target) && e.target !== $("speed-btn")) pop.classList.add("hidden"); });
  function paintMode(m) {
    document.querySelectorAll(".mode").forEach((x) => x.classList.toggle("on", x.dataset.mode === m));
    $("manual-row").classList.toggle("dim", m !== "manual");
  }
  function setMode(m) { speedMode = m; paintMode(m); send({ type: "speed", mode: m }); }
  document.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  const ms = $("manual-speed");
  ms.value = manualSpeed; $("manual-val").textContent = manualSpeed + " px/s";
  ms.addEventListener("input", () => { manualSpeed = Number(ms.value); $("manual-val").textContent = manualSpeed + " px/s"; });
  ms.addEventListener("change", () => send({ type: "speed", mode: "manual", manual: manualSpeed }));
  paintMode(speedMode);

  window.addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      if (e.key === "Escape") document.activeElement.blur();
      return;
    }
    if (e.key === "/") { e.preventDefault(); $("cmd-input").focus(); }
    else if (e.key === "l" || e.key === "L") goLive();
    else if (e.key === "q" || e.key === "Q") toggleDrawer();
    else if (e.key === "e" || e.key === "E") toggleExport();
    else if (e.key === "Escape") { drawer.classList.remove("open"); pop.classList.add("hidden"); }
  });

  // ---------- export ----------
  const xpop = $("export-pop");
  let exportScale = 0.5;
  function httpBase() { return wsUrl().replace(/^ws/, "http").replace(/\/ws\/?$/, ""); }
  function toggleExport(open) {
    const show = open ?? xpop.classList.contains("hidden");
    xpop.classList.toggle("hidden", !show);
    if (show) {
      const n = maxIndex + 1, w = n * SW();
      $("export-meta").textContent = `${n} strips · ${Math.round(w * exportScale).toLocaleString()} × ${Math.round(config.height * exportScale)} px`;
    }
  }
  $("export-btn").addEventListener("click", (e) => { e.stopPropagation(); pop.classList.add("hidden"); toggleExport(); });
  document.addEventListener("pointerdown", (e) => { if (!xpop.contains(e.target) && !$("export-btn").contains(e.target)) xpop.classList.add("hidden"); });
  document.querySelectorAll("#export-scale button").forEach((b) => b.addEventListener("click", () => {
    exportScale = Number(b.dataset.s);
    document.querySelectorAll("#export-scale button").forEach((x) => x.classList.toggle("on", x === b));
    toggleExport(true);
  }));
  $("export-go").addEventListener("click", async () => {
    const btn = $("export-go");
    btn.disabled = true; btn.textContent = "Stitching…";
    try {
      const r = await fetch(httpBase() + "/export.png?scale=" + exportScale);
      if (!r.ok) throw new Error(r.status);
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
  function toggleDrawer(open) { drawer.classList.toggle("open", open); }
  $("queue-btn").addEventListener("click", () => toggleDrawer());
  $("drawer-close").addEventListener("click", () => toggleDrawer(false));
  $("autopilot").addEventListener("change", () => send({ type: "autopilot", enabled: $("autopilot").checked }));
  $("vibe").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); send({ type: "autopilot", vibe: $("vibe").value.trim() }); $("vibe").blur(); toast($("vibe").value.trim() ? "Autopilot will lean toward “" + esc($("vibe").value.trim()) + "”" : "Autopilot vibe cleared"); }
  });
  $("hold").addEventListener("change", () => send({ type: "configure", hold: Number($("hold").value) }));
  $("blend").addEventListener("change", () => send({ type: "configure", blend: Number($("blend").value) }));
  $("clear").addEventListener("click", () => send({ type: "clear" }));

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  let editingId = null;
  let dragId = null;

  let upSeq = -1;  // latest canonical upcoming snapshot rendered
  window.addEventListener("tapestry:social", () => { if (director) { upSeq = -1; renderQueue(director); } });
  function renderQueue(d) {
    const list = $("queue-list");
    if (typeof d.upcoming_seq === "number") {
      if (d.upcoming_seq < upSeq && d.upcoming_seq > 0) return;  // stale snapshot (server restart resets to small numbers)
      upSeq = d.upcoming_seq;
    }
    list.classList.remove("skeleton");
    // Public queue = user ideas only (planned user scenes, then every waiting idea in pick order). Never Auto.
    const items = (d.upcoming || d.items || []).filter((x) => x.origin !== "auto");
    window.dispatchEvent(new CustomEvent("tapestry:pool", { detail: items.filter((x) => x.kind === "idea").length }));
    $("queue-count").textContent = items.length || "";
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
    // Keyed in-place diff: reuse unchanged rows so the sheet never flashes.
    const old = new Map([...list.children].map((li) => [li.dataset.id, li]));
    let prev = null;
    items.forEach((s, i) => {
      const key = String(s.id);
      const voted = !!(window.TapestrySocial && window.TapestrySocial.myVotes && window.TapestrySocial.myVotes().has(s.idea_id));
      const sig = JSON.stringify([i, s.title, s.origin, s.by, s.kind, s.prompt, s.votes, s.eta, voted]);
      let li = old.get(key);
      if (li && li.dataset.sig === sig) {
        old.delete(key);
        if (li.previousElementSibling !== prev) list.insertBefore(li, prev ? prev.nextSibling : list.firstChild);
        prev = li;
        return;
      }
      if (li) { old.delete(key); }
      const fresh = document.createElement("li");
      if (li) li.replaceWith(fresh);
      li = fresh;
      li.dataset.sig = sig;
      li.className = "item " + (s.origin === "auto" ? "auto" : "user") + (s.kind === "idea" ? " idea" : "");
      li.dataset.id = key;
      if (s.kind === "idea") {
        const c = credit(s.by, "user", { guestNames: true }), eta = s.eta != null && window.TapestrySocial && window.TapestrySocial.etaLabel ? window.TapestrySocial.etaLabel(s.eta) : "soon";
        li.innerHTML = `<span class="n">${i + 1}</span><div class="body"><div class="t" data-tip="${esc("Suggested by " + c)}">${esc(ideaTitle(s.prompt || s.title, s.by, s.image))}</div>` +
          `<div class="meta">${esc(c)} · Waiting · ${esc(eta)}</div><div class="p"><a class="open-s" href="/s/${s.idea_id}" target="_blank" rel="noopener">Open ↗</a><button class="linkish" type="button" data-report="${s.idea_id}">Report</button></div></div>` +
          (window.TapestrySocial && window.TapestrySocial.heart ? window.TapestrySocial.heart(s.idea_id, s.votes) : "");
        list.insertBefore(li, prev ? prev.nextSibling : list.firstChild);
        prev = li;
        return;
      }
      // View-only queue: no reorder, drag, edit or remove controls. Planned user scene (already picked, plays next).
      const cs = credit(s.by, "user", { guestNames: true });
      li.innerHTML = `<span class="n">${i + 1}</span><div class="body"><div class="t" data-tip="${esc("Suggested by " + cs)}">${esc(ideaTitle(s.source || s.title, s.by, s.ref))}</div>` +
        `<div class="meta">${esc(cs)} · ${i === 0 ? "Up next" : "Planned"}</div></div>`;
      list.insertBefore(li, prev ? prev.nextSibling : list.firstChild);
      prev = li;
    });
    old.forEach((li) => li.remove());
  }

  // Image-only ideas read "an image from X"; text ideas show the user's own words.
  function ideaTitle(text, by, image) {
    const t = String(text || "").trim();
    if (!t || /^inspired by this image$/i.test(t)) return "an image from " + credit(by, "user", { guestNames: true });
    return t.length > 120 ? t.slice(0, 119) + "…" : t;
  }
  window.TapestryIdeaTitle = ideaTitle;
  function srcName(sc) {
    const o = sc && sc.origin;
    return o === "auto" ? "Auto" : o === "user" ? (sc.by ? esc(sc.by) : "You") : "";
  }
  function srcTag(sc) {
    const o = sc && sc.origin;
    return o === "auto" ? '<span class="tag auto">✦ Auto</span>' : o === "user" ? `<span class="tag">${sc.by ? esc(sc.by) : "You"}</span>` : "";
  }
  function showDirector(d) {
    if (!d) return;
    director = d;
    const cur = d.current_scene || { title: d.current };
    const tgt = d.target_scene;
    const next = tgt || ((d.upcoming || d.items) && (d.upcoming || d.items)[0]);
    const stripCap = histKey === null && liveCaption();
    if (histKey === null && !stripCap) {
      $("now-title").textContent = cur.title || d.current;
      $("now-arrow").classList.toggle("hidden", !next);
      $("next-title").textContent = next ? next.title : "";
    }
    const prog = tgt ? (d.transition_progress || 0) : Math.min(1, (d.held || 0) / Math.max(1, d.hold_for || d.hold || 1));
    $("now-bar").style.width = (prog * 100).toFixed(0) + "%";
    if (document.activeElement !== $("hold")) $("hold").value = d.hold;
    if (document.activeElement !== $("blend")) $("blend").value = d.blend;
    const ap = d.autopilot;
    if (ap) {
      $("autopilot").checked = !!ap.enabled;
      if (document.activeElement !== $("vibe")) $("vibe").value = ap.vibe || "";
      $("auto-status").textContent = !ap.enabled ? "off" : ap.busy ? "dreaming up what's next…" : ap.error ? "improvising" : "";
    }
    const shown = tgt && (d.transition_progress || 0) >= 0.5 ? tgt : cur;
    const srcEl = $("now-src");
    if (histKey === null && !stripCap) srcEl.textContent = shown.origin === "auto" ? "✦ Auto" : shown.origin === "user" ? (shown.by ? "by " + shown.by : "You") : "Now";
    if (histKey === null && !stripCap) srcEl.className = "src" + (shown.origin === "auto" ? " auto" : "");
    renderQueue(d);
  }

  let interpreterOn = false;
  let lastOwnText = null;
  function handleJson(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.buffer) {
      bufferDepth = msg.buffer.depth ?? bufferDepth;
      bufferLow = !!msg.buffer.low;
    }
    if (msg.gpu) gpu = msg.gpu;
    if (msg.type === "strip_scene" && Array.isArray(msg.s)) { addStripScene(msg.i, msg.s); return; }
    if (msg.type === "strip") { lastFreshAt = performance.now(); if (replay) endReplay(); onStripRef(msg, true); return; }
    if (msg.type === "strips") { (msg.items || []).forEach((r) => onStripRef(r, false)); return; }
    if (msg.director) showDirector(msg.director);
    if (msg.type === "config") {
      wsConfigSeen = true;
      config = Object.assign(config, msg);
      {   // R2 serves CORS and holds every strip/tile; if the pod still advertises the Supabase bucket, read R2 instead (no 400s).
        const cdn = (window.TAPESTRY_CONFIG || {}).cdnBase, re = /^https:\/\/[^/]+supabase\.co\/storage\/v1\/object\/public\/[^/]+\//;
        if (cdn) for (const k of ["strip_base", "lod_base"]) if (re.test(config[k] || "")) config[k] = config[k].replace(re, cdn.replace(/\/$/, "") + "/");
        delete config.strip_base_fb; delete config.lod_base_fb;
      }
      interpreterOn = !!msg.interpreter;
      delete config.type;
      window.dispatchEvent(new CustomEvent("tapestry:config", { detail: msg }));
    } else if (msg.type === "ping") {
      send({ type: "pong" });
    } else if (msg.type === "clock") {
      onClock(msg);
    } else if (msg.type === "react") {
      window.dispatchEvent(new CustomEvent("tapestry:react", { detail: msg }));
    } else if (msg.type === "fuel" || msg.type === "activity" || msg.type === "auth") {
      window.dispatchEvent(new CustomEvent("tapestry:" + msg.type, { detail: msg }));
    } else if (msg.type === "notice") {
      pending.clear(); $("cmd").classList.remove("busy");
      toast(esc(msg.text), 3500);
    } else if (msg.type === "activity") {
      if (msg.text !== lastOwnText) toast(`Someone added ${msg.text && msg.text.trim() ? `<span class="muted">“${esc(msg.text)}”</span>` : "an image"} → ${(msg.titles || []).map(esc).join(" → ")}`, 4500);
    } else if (msg.type === "plan") {
      pending.delete(msg.req);
      lastOwnText = msg.text;
      if (!pending.size) $("cmd").classList.remove("busy");
      const p = msg.plan || {};
      const titles = (msg.scenes || []).map((s) => esc(s.title)).join(" → ");
      if (document.body.classList.contains("is-admin")) toast((p.source === "haiku" ? "Planned " : "Queued ") + titles +   // planner detail is admin-only; viewers just see the scene title
        (p.note ? `<br><span class="muted">${esc(p.note)}</span>` : ""), 6000);
    }
  }

  window.TapestryWS = { send: (o) => send(o), toast: (h, ms) => toast(h, ms), esc: (x) => esc(x) };
  // Read-only view hooks for reactions/clips (fun.js).
  Object.assign(window.TapestryView, { title: () => ($("now-title").textContent || "").trim(),
    by: () => ($("now-src").textContent || "").trim(),
    caption: () => centerScene() });
  function connect() {
    const url = wsUrl();
    ws = new WebSocket(url + (url.includes("?") ? "&" : "?") + "v=2");
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (dropAt && window.TapestryOps) TapestryOps.report("reconnect", performance.now() - dropAt, { pod: podDown ? "down" : "running" });
      dropAt = 0;
      connected = true; everOpened = true;
      reconnectDelay = 1000;
      send({ type: "upcoming_request" });
      requested.clear();
      livePos = null;
      if (clientPingTimer) clearInterval(clientPingTimer);
      clientPingTimer = setInterval(() => send({ type: "ping" }), 25000);
      send({ type: "status_request" });
      const S = window.TapestrySocial;
      if (S && S.token()) send({ type: "auth", token: S.token() });
      window.__tapestryWsOpen = true; window.dispatchEvent(new CustomEvent("tapestry:ws", { detail: { open: true } }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try { handleJson(JSON.parse(ev.data)); } catch (e) { console.warn("bad json", e); }
      } else {
        onStripBinary(ev.data);
      }
    };
    ws.onclose = (ev) => {
      if (connected && !document.hidden && window.TapestryOps) TapestryOps.report("disconnect", 0, { code: String((ev && ev.code) || 0), pod: podDown ? "down" : "running" });
      if (connected && !document.hidden) dropAt = performance.now();
      connected = false;
      window.__tapestryWsOpen = false; window.dispatchEvent(new CustomEvent("tapestry:ws", { detail: { open: false } }));
      if (clientPingTimer) clearInterval(clientPingTimer);
      const wait = reconnectDelay * (0.75 + Math.random() * 0.5);  // jitter
      setTimeout(connect, navigator.onLine === false ? 3000 : wait);
      reconnectDelay = Math.min(podDown ? 30000 : 4000, reconnectDelay * 1.6);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  window.addEventListener("online", () => { if (!connected) { reconnectDelay = 1000; try { ws && ws.close(); } catch (_) {} } });

  // ---------- keep the screen awake ----------
  let wakeLock = null;
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
  function setAmbient(on) {
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
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
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
    holdTimer = setTimeout(() => document.body.classList.add("reveal"), 380);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (Math.hypot(e.clientX - holdX, e.clientY - holdY) > 6) clearTimeout(holdTimer);
  });
  const endHold = () => { clearTimeout(holdTimer); document.body.classList.remove("reveal"); };
  canvas.addEventListener("pointerup", endHold);
  canvas.addEventListener("pointercancel", endHold);
  window.addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.key === "h" || e.key === "H") document.body.classList.toggle("reveal-lock");
    if (e.key === "F" && e.shiftKey) toggleFullscreen();
  });
  if (new URLSearchParams(location.search).has("ambient")) document.body.classList.add("ambient");

  // ---------- resilience: pod-independent bootstrap + replay fallback ----------
  // /api/live (Vercel + Supabase) serves the strip config and recent refs; strips themselves come from R2.
  // If live goes quiet (no new strip for a minute, or the pod is unreachable), quietly replay recent history.
  let podDown = false, liveChecked = false, podPollAt = performance.now();   // /api/live says the GPU is off or the stream is stale: calm "replay", not "reconnecting"
  let replayAt = 0, wsConfigSeen = false, replay = false, lastFreshAt = performance.now(), downSince = 0, replayBusy = false;
  const apiReq = new Set();
  function apiMissing(a, b) {
    a = Math.max(0, a); b = Math.min(b, maxIndex);
    for (let c = Math.floor(a / 64) * 64; c <= b; c += 64) {
      if (apiReq.has(c)) continue;
      let need = false; for (let i = Math.max(a, c); i <= Math.min(b, c + 63); i++) if (!strips.has(i)) { need = true; break; }
      if (!need) continue;
      apiReq.add(c);
      fetch("/api/live?start=" + c + "&end=" + (c + 63)).then((r) => r.json()).then((j) => (j.items || []).forEach((r) => onStripRef(r, false)))
        .catch(() => {}).finally(() => setTimeout(() => apiReq.delete(c), 5000));
    }
  }
  function bootFromApi() {
    fetch("/api/live?n=240").then((r) => r.json()).then((j) => {
      if (!j || !j.config) return;
      if (!wsConfigSeen) {
        config = Object.assign(config, j.config);
        window.dispatchEvent(new CustomEvent("tapestry:config", { detail: j.config }));
      }
      const it = j.items || [];
      liveChecked = true;
      if (j.pod && j.pod.ws && j.pod.ws !== wsUrl() && !new URLSearchParams(location.search).get("ws")) {
        podWs = j.pod.ws;
        if (!connected && ws) { try { ws.onclose = null; ws.close(); } catch (_) {} connect(); }
      }
      podDown = !!(j.pod && (j.pod.status !== "running" || j.pod.desired === "off")) || !!(j.last_at && j.now - j.last_at > 60);
      // Pod down at load: choose replay BEFORE the first strips land, so the camera starts at the replay position
      // and the load-in plays on the strips being replayed (no live-edge frame, then a backward jump).
      if (podDown && !connected && maxIndex < 0 && it.length >= 40 && panMode === "live" && !pendingSeek && !/[?&]at=/.test(location.search)) {
        const top = it[it.length - 1].i, first = it[0].i;
        const back = Math.min(top - first - 4, 90 + Math.floor(Math.random() * 120)), start = top - back;
        replay = true; live = false;
        onStripRef(it[it.length - 1], false);   // sets maxIndex so the pan range covers the start position
        panPos = Math.max(0, start * SW() - viewWorld() / 2); panVel = 0; panMode = "glide";
        lastFreshAt = performance.now() - 61000;
        it.filter((r) => Math.abs(r.i - start) < 24).forEach((r) => onStripRef(r, false));   // on-screen strips decode first
      }
      if (it.length) onStripRef(it[it.length - 1], false);   // newest first: the live view initialises at the real edge
      it.forEach((r) => onStripRef(r, false));
      if (!connected && j.last_at && j.now - j.last_at > 60) lastFreshAt = performance.now() - 61000;
    }).catch(() => {}).finally(() => { liveChecked = true; });
  }
  function fadeSwap(fn, done) {   // compositor-only fade around a jump (no pop-in, no seek blur)
    replayBusy = true;
    canvas.style.transition = "opacity .7s ease"; canvas.style.opacity = "0";
    setTimeout(() => {
      fn();
      const t0 = performance.now();
      const wait = () => (coverage >= 0.95 || performance.now() - t0 > 2500) ? (canvas.style.opacity = "", setTimeout(() => { canvas.style.transition = ""; replayBusy = false; done && done(); }, 750)) : setTimeout(wait, 80);
      setTimeout(wait, 120);
    }, 720);
  }
  function startReplay() {
    if (replayBusy || maxIndex < 40) return;
    if (!replay && !replayAt) { replayAt = performance.now(); window.TapestryOps && TapestryOps.report("replay", 0, { pod: podDown ? "down" : "running" }); }
    const back = Math.min(maxIndex - 4, 90 + Math.floor(Math.random() * 120));   // ~5-10 min of recent history
    fadeSwap(() => {
      replay = true;
      enterHistory(); setAway(false);
      panPos = Math.max(0, (maxIndex - back) * SW() - viewWorld() / 2); panVel = 0; panMode = "glide";
    });
  }
  function endReplay() {
    if (!replay || replayBusy) return;
    if (replayAt && window.TapestryOps) TapestryOps.report("away_from_live", performance.now() - replayAt, { reason: "replay" });
    replayAt = 0;
    fadeSwap(() => { replay = false; panMode = "live"; live = true; setAway(false); });
  }
  ["pointerdown", "wheel", "keydown"].forEach((e) => canvas.addEventListener(e, () => { if (replay && !replayBusy) { replay = false; if (replayAt && window.TapestryOps) TapestryOps.report("away_from_live", performance.now() - replayAt, { reason: "user_took_over" }); replayAt = 0; } }, { capture: true, passive: true }));
  setInterval(() => {
    if (document.hidden || document.body.classList.contains("intro") || maxIndex < 0) return;
    if (connected) downSince = 0; else if (!downSince) downSince = performance.now();
    if (!connected && performance.now() - (podPollAt || 0) > 60000) {   // GPU down: re-check its state and address
      podPollAt = performance.now();
      fetch("/api/live?n=1").then((r) => r.json()).then((j) => {
        if (!j || !j.pod) return;
        podDown = j.pod.status !== "running" || j.pod.desired === "off";
        if (j.pod.ws && j.pod.ws !== wsUrl() && !new URLSearchParams(location.search).get("ws")) podWs = j.pod.ws;
      }).catch(() => {});
    }
    // Pod known down: replay soon. Pod believed running (app restart/deploy is ~35-50 s, a proxy blip less): hold at
    // the live edge for 90 s instead of fading 5-10 min back into history, so a short drop never pulls viewers off live.
    const grace = podDown ? 15000 : 90000;
    const quiet = performance.now() - lastFreshAt > Math.max(60000, grace) || (downSince && performance.now() - downSince > grace);
    if (!quiet) return;
    if (panMode === "live" && !replay) startReplay();
    else if (replay && panMode === "live") startReplay();   // reached the end of the replay: loop
  }, 1000);
  bootFromApi();
  connect();
  requestAnimationFrame(frame);
})();

// ---------- phones: slim pill → compose sheet, overflow, sheet drag-to-dismiss, chat in a sheet ----------
(() => {
  const $ = (id) => document.getElementById(id);
  const phone = matchMedia("all");
  const body = document.body, cmd = $("cmd"), input = $("cmd-input"), more = $("more-btn"), drawer = $("drawer");
  if (!cmd || !more) return;
  // Compose: focusing the pill turns the dock into a sheet with attach + queue/now + send.
  // Compose open/close: the pill morphs into the sheet via a View Transition (compositor transform + opacity, eased);
  // only the dock is captured, so the live tapestry keeps running underneath. Falls back to an instant switch.
  // Opening is synchronous (no View Transition): focus must land in the same tap so iOS raises the keyboard.
  const setCompose = (on) => {
    on = !!(on && phone.matches);
    if (body.classList.contains("composing") === on) return;
    const go = () => body.classList.toggle("composing", on);
    if (!on && document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) { try { document.startViewTransition(go); return; } catch (_) {} }
    go();
  };
  window.TapestryCompose = setCompose;
  // Expand only after the tap's synthesized click: expanding mid-tap moves the box, the click lands elsewhere and iOS drops focus.
  let tapping = false, tapTimer = 0;
  cmd.addEventListener("pointerdown", () => { tapping = true; clearTimeout(tapTimer); tapTimer = setTimeout(() => { tapping = false; }, 700); });
  input.addEventListener("focus", () => { setMore(false); if (!tapping) setCompose(true); });
  input.addEventListener("focus", () => { const S = window.TapestrySocial; if (S && S.warmSend) S.warmSend(); });
  // Tap on the compact pill: focus inside the click gesture (iOS raises the keyboard) and expand, every time.
  cmd.addEventListener("click", (e) => {
    tapping = false; clearTimeout(tapTimer);
    if (e.target.closest("button, label, a, input[type=file]")) return;
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    setCompose(true);
  });
  // Keyboard gone (blur, Done, tap off) -> back to the compact pill. The draft stays in the box.
  cmd.addEventListener("focusout", () => setTimeout(() => { if (!cmd.contains(document.activeElement)) setCompose(false); }, 120));
  window.addEventListener("tapestry:kb", (e) => { if (!e.detail.open && body.classList.contains("composing")) { if (document.activeElement === input) input.blur(); setCompose(false); } });
  cmd.addEventListener("submit", () => { input.blur(); setCompose(false); setMore(false); setTimeout(() => { input.blur(); setCompose(false); }, 60); });   // collapse to the pill + dismiss keyboard right away
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest && e.target.closest(".cmd-terms")) return;
    if (body.classList.contains("composing") && !cmd.contains(e.target)) { input.blur(); setCompose(false); }
    if (body.classList.contains("more-open") && !cmd.contains(e.target)) setMore(false);
  }, true);
  // Overflow: secondary actions in a compact row above the pill.
  function setMore(on) { const cap = document.querySelector(".dock .now"); if (cap) cap.style.visibility = on ? "hidden" : ""; body.classList.toggle("more-open", on); more.setAttribute("aria-expanded", on ? "true" : "false"); }
  more.addEventListener("click", (e) => { e.preventDefault(); setMore(!body.classList.contains("more-open")); });
  cmd.querySelectorAll(".sec").forEach((b) => b.addEventListener("click", () => phone.matches && b.id !== "speed-btn" && setTimeout(() => setMore(false), 150)));
  // Bottom sheet: drag the handle (or the head) down to dismiss.
  const grab = $("drawer-grab"), head = drawer && drawer.querySelector(".drawer-head");
  let y0 = null, dy = 0;
  const start = (e) => { if (!phone.matches) return; y0 = e.clientY; dy = 0; drawer.style.transition = "none"; };
  const move = (e) => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); drawer.style.transform = `translateY(${dy}px)`; };
  const end = () => {
    if (y0 === null) return; y0 = null;
    drawer.style.transition = ""; drawer.style.transform = "";
    if (dy > 90) drawer.classList.remove("open");
  };
  [grab, head].forEach((el) => el && el.addEventListener("pointerdown", (e) => { if (e.target.closest("button")) return; start(e); el.setPointerCapture && el.setPointerCapture(e.pointerId); }));
  [grab, head].forEach((el) => el && el.addEventListener("pointermove", move));
  [grab, head].forEach((el) => el && ["pointerup", "pointercancel"].forEach((t) => el.addEventListener(t, end)));
  // Placeholder fits the pill.
  const ph = () => { if (phone.matches) input.placeholder = "Where next?"; };
  phone.addEventListener("change", ph); setTimeout(ph, 0); setTimeout(ph, 3000);
})();
