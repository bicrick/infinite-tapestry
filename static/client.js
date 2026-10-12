/**
 * Infinite Tapestry browser client.
 * - Backend WS URL: ?ws=... > window.TAPESTRY_CONFIG.wsUrl > page origin (/ws).
 * - Auto speed follows GPU throughput; auto-planned scene queue; drag to pan.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $("view");
  const ctx = canvas.getContext("2d", { alpha: false });
  const statusEl = $("status");
  const statusText = $("status-text");
  const DEBUG = /[?&]debug/.test(location.search);
  const liveBtn = $("live-btn");

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
  let reconnectDelay = 1000;
  let bufferDepth = 0;
  let bufferLow = false;
  let lastAckIndex = -1;
  let connected = false;
  let clientPingTimer = null;
  let ackTimer = 0;
  let director = null;
  const requested = new Set();
  let liveInitialized = false;

  function wsUrl() {
    const q = new URLSearchParams(location.search).get("ws");
    const cfg = (window.TAPESTRY_CONFIG && window.TAPESTRY_CONFIG.wsUrl) || "";
    let url = q || cfg;
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
    // Soft extension of the band into the dark space: downsample the band, upscale it (free blur), darken.
    if (yOff < 4) return;
    if (!ambCv) { ambCv = document.createElement("canvas"); ambCv.width = 24; ambCv.height = 12; ambCtx = ambCv.getContext("2d"); }
    ambCtx.drawImage(canvas, 0, yOff, w, bandH, 0, 0, 24, 12);
    ctx.save();
    ctx.imageSmoothingQuality = "high";
    ctx.globalAlpha = SURR_GLOW * surroundA;
    ctx.drawImage(ambCv, 0, 0, 24, 3, 0, 0, w, yOff + 2);                  // top edge, stretched up
    ctx.drawImage(ambCv, 0, 9, 24, 3, 0, yOff + bandH - 2, w, h - yOff - bandH + 2);   // bottom edge, stretched down
    ctx.globalAlpha = 1;
    const g1 = ctx.createLinearGradient(0, 0, 0, yOff);
    g1.addColorStop(0, `rgba(${SURR},.96)`); g1.addColorStop(0.75, `rgba(${SURR},.72)`); g1.addColorStop(1, `rgba(${SURR},.35)`);
    ctx.fillStyle = g1; ctx.fillRect(0, 0, w, yOff);
    if (surroundA < 1) { ctx.fillStyle = `rgba(${SURR},${1 - surroundA})`; ctx.fillRect(0, 0, w, yOff); }
    const y2 = yOff + bandH, g2 = ctx.createLinearGradient(0, y2, 0, h);
    g2.addColorStop(0, `rgba(${SURR},.35)`); g2.addColorStop(0.25, `rgba(${SURR},.72)`); g2.addColorStop(1, `rgba(${SURR},.96)`);
    ctx.fillStyle = g2; ctx.fillRect(0, y2, w, h - y2);
    if (surroundA < 1) { ctx.fillStyle = `rgba(${SURR},${1 - surroundA})`; ctx.fillRect(0, y2, w, h - y2); }
    ctx.restore();
  }
  const viewWorld = () => canvas.width / scale();
  // For the load-in: lets intro.js anchor its points to the same moving world as the canvas.
  window.TapestryView = { portrait: () => portrait(), band: () => { const s0 = scale(), bh = config.height * s0; return { top: portrait() ? bandTopFor(canvas.height, bh) : 0, height: bh }; }, setSurround: (a) => { surroundA = a; }, left: () => viewLeft(), scale: () => scale(), ready: () => maxIndex >= 0, coverage: () => coverage, zoom: () => zoom, canvas, center: () => centerIdx(), max: () => maxIndex, live: () => panMode === "live" };
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
    if (strips.has(m.index)) return;
    const entry = {
      index: m.index, overlap: m.overlap, prompt: m.prompt,
      blob: new Blob([m.jpeg], { type: "image/jpeg" }), bitmap: null, decoding: false,
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

  function ensureDecoded(e) {
    if (e.bitmap || e.decoding) return;
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
    if (livePos === null || Math.abs(projected - livePos) > SW() * 2) livePos = projected;
    else corr = projected - livePos;
    lastClockAt = localNow;
  }
  let corr = 0, lastClockAt = 0;

  const COARSE = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
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
      t.img.onerror = () => { t.failed = true; };
      t.img.src = `${httpBase()}/lod/${level}/${c}.jpg`;
      lodCache.set(key, t);
      if (lodCache.size > 400) { const oldest = [...lodCache.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 100); oldest.forEach(([k]) => lodCache.delete(k)); }
    }
    t.used = performance.now();
    return t.ok ? t.img : null;
  }
  function drawLodChunk(level, c, left) {
    const tw = LOD_N[level] * SW();
    const img = lodTile(level, c);
    if (img) { ctx.drawImage(img, c * tw - left, 0, tw, config.height); return; }
    // Gap: the L2 overview is prefetched for all history, so slice it (blurry beats blank);
    // from L3 also try finer tiles (needed at the still-filling live edge).
    if (level !== 2) {
      const p = LOD_N[2], cc = Math.floor(c * LOD_N[level] / p), t2 = lodTile(2, cc);
      if (t2 && level === 1) { const part = t2.width / 4; ctx.drawImage(t2, (c % 4) * part, 0, part, t2.height, c * tw - left, 0, tw, config.height); return; }
    }
    if (level > 1) for (let k = 0; k < 4; k++) drawLodChunk(level - 1, c * 4 + k, left);   // finer tiles fill the gap
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
  function histCaption() {
    if (live || !tlScenes.length) {
      if (histKey !== null) { histKey = null; document.body.classList.remove("hist-cap"); $("now-time").textContent = ""; if (director) showDirector(director); }
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
      const [, title, by, style, origin] = r;
      $("now-title").textContent = title || "—";
      const src = $("now-src");
      src.textContent = (origin === "auto" ? "✦ Auto" : by ? by : origin === "user" ? "Audience" : "Earlier") + (style && style !== "none" ? " · " + style : "");
      src.className = "src" + (origin === "auto" ? " auto" : "");
      $("now-arrow").classList.add("hidden"); $("next-title").textContent = "";
      cap && cap.classList.remove("swap");
    };
    clearTimeout(swapT);
    if (first || !cap) apply(); else { cap.classList.add("swap"); swapT = setTimeout(apply, 170); }
  }
  async function refreshTimeline() {
    try { const r = await fetch(httpBase() + "/timeline?points=300"); const j = await r.json(); tlPoints = j.points || []; tlScenes = j.scenes || tlScenes; } catch (_) {}
    // the whole history at 1/16 is small: prefetch it so flights never hit an empty frame
    for (let c = 0; (c + 1) * LOD_N[2] <= maxIndex && c < 300; c++) lodTile(2, c);
  }
  setTimeout(refreshTimeline, 1500); setInterval(refreshTimeline, 60000);
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
  const tl = $("timeline"), tlHead = $("tl-head"), tlTip = $("tl-tip");
  function centerIdx() { return (viewLeft() + viewWorld() / 2) / SW(); }
  function updateTimeline() {
    if (!tl || maxIndex < 1) return;
    const f = Math.max(0, Math.min(1, centerIdx() / maxIndex));
    tlHead.style.left = (f * 100) + "%";
    tl.classList.toggle("away", !live);
    $("tl-start").textContent = fmtTime(timeAt(0));
    histCaption();
  }
  function fracFromEvent(ev) { const r = tl.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)); }
  function scrubTo(f) {
    enterHistory();
    panMode = "scrub"; panVel = 0;
    panPos = Math.max(0, Math.min(maxPan(), f * maxIndex * SW() - viewWorld() / 2));
  }
  if (tl) {
    let downX = 0, moved = false;
    tl.addEventListener("pointermove", (ev) => {
      const f = fracFromEvent(ev);
      const label = f > 0.995 ? "Live" : fmtTime(timeAt(f * maxIndex));
      if (tlScrub && label !== tlTip.textContent && navigator.vibrate && ev.pointerType === "touch") navigator.vibrate(3);   // scrubber tick
      tlTip.textContent = label;
      tlTip.style.left = (f * 100) + "%";
      if (tlScrub) { if (Math.abs(ev.clientX - downX) > 3) moved = true; if (moved) scrubTo(f); }
    });
    tl.addEventListener("pointerdown", (ev) => { tlScrub = true; moved = false; downX = ev.clientX; tl.setPointerCapture(ev.pointerId); tl.classList.add("active"); ev.stopPropagation(); });
    const end = (ev) => {
      if (!tlScrub) return;
      tlScrub = false; tl.classList.remove("active");
      const f = fracFromEvent(ev);
      if (f > 0.995) { startReturn(); return; }
      if (!moved) { const i = Math.round(f * maxIndex); jumpTo(i); }
      else { panMode = "glide"; panVel = 0; }
    };
    tl.addEventListener("pointerup", end);
    tl.addEventListener("pointercancel", end);
  }
  function jumpTo(idx) {
    enterHistory();
    const target = Math.max(0, Math.min(maxPan(), idx * SW() - viewWorld() / 2));
    seek = { from: shownPan(), to: target, t0: performance.now(), dur: Math.min(1600, 500 + Math.sqrt(Math.abs(target - shownPan())) * 6) };
    panMode = "seek"; panVel = 0;
  }
  window.TapestryJump = jumpTo;

  function frame(ts) {
    if (saver.on && lastTs && ts - lastTs < 30) { requestAnimationFrame(frame); return; }   // ~30fps cap
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    if (livePos !== null) {
      // Advance at the shared speed, bleed in the correction over ~1s,
      // and never run past what we've actually received.
      const fix = corr * Math.min(1, dt * 1.5);
      corr -= fix;
      livePos = Math.min(panoramaWidth(), livePos + srvSpeed * dt + fix);
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
      const zt = COARSE ? 1 - Math.min(0.62, Math.max(0, (Math.abs(velS) - 500) / 5200))   // touch: unchanged
        : Math.max(0.05, 1 / (1 + Math.max(0, Math.abs(velS) - 2500) / 4000));   // deep zoom only at turbo speeds
      // Spring zoom: out quickly as speed builds, snappy (slightly underdamped) back in on settle.
      if (zt < zoom) { zoom += (zt - zoom) * Math.min(1, dt * 6); zoomVel = 0; }
      else { const k = 90, c = 1.6 * Math.sqrt(k); zoomVel += (k * (zt - zoom) - c * zoomVel) * dt; zoom = Math.min(1.015, zoom + zoomVel * dt); }
      if (Math.abs(zoom - 1) < 0.001 && Math.abs(zoomVel) < 0.01) { zoom = 1; zoomVel = 0; }
    }
    draw();
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
    const s = s0 * zoom;
    const center = viewLeft() + viewWorld() / 2;
    const left = center - (w / s) / 2;
    // Portrait band sits slightly above centre (optical centre); full-bleed otherwise.
    const yOff = portrait() ? bandTopFor(h, config.height * s0) + (config.height * s0 - config.height * s) / 2 : (h - config.height * s) / 2;
    publishBand(yOff, config.height * s, h);
    const firstIdx = Math.max(0, Math.floor(left / SW()) - 1);
    const lastIdx = Math.ceil((left + w / s) / SW()) + 1;
    const fast = Math.abs(velS) > 1600;
    ctx.save();
    ctx.translate(0, yOff);
    ctx.scale(s, s);
    // Overview layer: LOD tiles under everything while zoomed out or when strips aren't loaded yet.
    if (zoom < 0.97 || fast || coverage < 1) drawLod(left, w / s, zoom);   // LOD underlay until strips are in (never blank)
    {
      let want = 0, have = 0;
      const stripLayer = zoom > 0.3;
      for (let i = Math.max(firstIdx, 0); stripLayer && i <= Math.min(lastIdx, maxIndex); i++) {
        want++;
        const e = strips.get(i);
        if (!e) continue;
        if (!fast) ensureDecoded(e);
        if (!e.bitmap) continue;
        have++;
        ctx.drawImage(e.bitmap, i * SW() - e.overlap - left, 0);
      }
      coverage = want ? have / want : 0;
    }
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
    if (portrait()) drawSurround(w, h, Math.max(0, yOff), config.height * s);
    // Motion blur that scales with scrub velocity (cheap: smear the frame onto itself).
    const blur = Math.min(28, Math.max(0, (Math.abs(velS) - 1400) / 260)) * (window.devicePixelRatio || 1);
    if (blur > 0.5) {
      // Smear through a half-res scratch canvas (a canvas can't reliably draw onto itself).
      if (!blurCv) { blurCv = document.createElement("canvas"); blurCtx = blurCv.getContext("2d"); }
      const bw = w >> 1, bh = h >> 1;
      if (blurCv.width !== bw || blurCv.height !== bh) { blurCv.width = bw; blurCv.height = bh; }
      blurCtx.drawImage(canvas, 0, 0, bw, bh);
      const dir = velS > 0 ? -1 : 1;
      ctx.globalAlpha = 0.35; ctx.drawImage(blurCv, dir * blur, 0, w, h);
      ctx.globalAlpha = 0.22; ctx.drawImage(blurCv, dir * blur * 2.2, 0, w, h);
      ctx.globalAlpha = 1;
    }
    if (!fast && zoom > 0.9) requestMissing(firstIdx - 8, lastIdx + 2);
    evictFar(firstIdx, lastIdx);
  }

  function updateHud(speed, ahead) {
    const aheadStrips = Math.max(0, ahead / SW());
    statusEl.classList.toggle("off", !connected);
    statusEl.classList.toggle("warn", connected && live && aheadStrips < 1);
    if (!connected) { statusText.textContent = "reconnecting"; return; }
    const parts = [];
    const S = window.TapestrySocial;
    if (!DEBUG && !(S && S.isAdmin())) {
      parts.push(live ? "live" : "rewound");
      if (speedMult > 1) parts.push(speedMult + "×");
      parts.push(viewers + " watching");
      statusText.textContent = parts.join("  ·  ");
      syncSpeedUi();
      return;
    }
    if (!live) parts.push("history · strip " + Math.floor(viewLeft() / SW()) + "/" + maxIndex);
    if (gpu && gpu.strip_seconds) parts.push(gpu.strip_seconds.toFixed(1) + "s/strip");
    parts.push(aheadStrips.toFixed(1) + " ahead");
    parts.push(speed.toFixed(0) + " px/s" + (speedMult > 1 ? " · " + speedMult + "×" : ""));
    parts.push(viewers + (viewers === 1 ? " viewer" : " viewers"));
    statusText.textContent = parts.join("  ·  ");
    syncSpeedUi();
  }
  function syncSpeedUi() {
    if (typeof paintMode === "function") { paintMode(speedMode); paintFF(speedMult); }
    if (document.activeElement !== $("manual-speed")) { $("manual-speed").value = manualSpeed; $("manual-val").textContent = Math.round(manualSpeed) + " px/s"; }
    $("speed-btn").textContent = (speedMode === "auto" ? "Auto" : Math.round(manualSpeed) + " px/s") + (speedMult > 1 ? " " + speedMult + "×" : "");
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

  function rubber(x) {
    // iOS-style: resistance grows with overscroll distance.
    const lo = minPan(), hi = maxPan(), d = viewWorld() * 0.5;
    const f = (o) => (1 - 1 / (o / d * 0.55 + 1)) * d;
    if (x < lo) return lo - f(lo - x);
    if (x > hi) return hi + f(x - hi);
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
    liveBtn.classList.remove("hidden");
  }

  // ---------- permalinks: ?at=<strip>[&to=<strip>] ----------
  let mark = null, seek = null;
  function seekTo(from, to) {
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
    enterHistory();
    const dist = Math.abs(maxPan() - shownPan());
    ret = { from: shownPan(), t0: performance.now(), dur: Math.min(1100, 420 + Math.sqrt(dist) * 9) };
    panMode = "return";
    panVel = 0;
    liveBtn.classList.add("hidden");
  }
  // Gentle spring: easeOutBack with a small overshoot.
  const easeSpring = (t) => { const c = 0.9, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };

  let driftVel = 0, driftAcc = 0, driftArm = 0, turbo = 0;
  function holdDrift() { driftVel = 0; driftAcc = 0; driftArm = 0; }
  function stepPan(dt) {
    if (panMode === "live") return;
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
          if (panPos >= hi - 0.5) { panMode = "live"; live = true; liveBtn.classList.add("hidden"); }
        }
      } else {
        // Friction: firm at normal speeds (~0.4-0.7s glide), loose once in turbo so it hums.
        if (performance.now() - wheelIdleAt > 250) turbo *= Math.exp(-1.2 * dt);
        panVel *= Math.exp(-(7.5 - 6.3 * turbo) * dt);
        panPos += panVel * dt;
        if (Math.abs(panVel) < 4) panVel = 0;
        // Drift: once settled and the high-res strips are in, resume the slow forward drift with a
        // gelatinous spring ramp (0 → drift speed over ~1-1.5s, slight overshoot), never a jump.
        if (Math.abs(panVel) < 4 && !gesture && !tlScrub) {
          if (!driftArm && coverage >= 0.95) driftArm = performance.now();
          if (driftArm && performance.now() - driftArm > 300) {
            const target = Math.max(0, srvSpeed || 0), k = 9, c = 2 * 0.72 * Math.sqrt(k);
            driftAcc += (k * (target - driftVel) - c * driftAcc) * dt;
            driftVel += driftAcc * dt;
            panPos += Math.max(0, driftVel) * dt;
            if (panPos >= hi) { panPos = hi; holdDrift(); panMode = "live"; live = true; liveBtn.classList.add("hidden"); return; }
          }
        } else holdDrift();
        // Gliding into the live edge with speed: just hand over to live.
        if (panPos >= hi && panVel > 0) { panPos = hi; panVel = 0; panMode = "live"; live = true; liveBtn.classList.add("hidden"); }
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
  canvas.addEventListener("pointerdown", (ev) => {
    if (activePointer !== null) return;
    activePointer = ev.pointerId;
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    lastPX = ev.clientX;
    const armed = panMode === "live";
    // Touch: the painting is never a scrubber. Taps toggle the UI; scrubbing is the timeline's job.
    if (ev.pointerType === "touch") {
      gesture = { x0: ev.clientX, y0: ev.clientY, t0: performance.now(), moved: 0, wasIdle: document.body.classList.contains("idle"), armed: true, touch: true, hist: [[performance.now(), ev.clientX]] };
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
    if (gesture.touch) return;
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
      nudge = lim * Math.tanh(raw / lim); nudgeVel = 0;
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
      if (!g.wasIdle) setTimeout(() => document.body.classList.add("idle"), 0);
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

  // Wheel / trackpad = time. Scroll DOWN travels back into history, UP comes forward (reaching the
  // live edge re-joins live). Each event is an impulse; impulses stack and accelerate with speed, so
  // repeated flicks build up to "humming" through hours, then friction lets it coast down.
  let wheelAcc = 0, wheelAccAt = 0;
  const WHEEL_MIN = 10;          // CSS px of same-direction scroll before engaging (ignores accidental deltas)
  const VMAX = 260000;           // world px/s ceiling in full turbo (~hours of history in seconds)
  const VNORM = 4500;            // ceiling for ordinary scrolling
  const TURBO_RATE = 1600;       // CSS px/s of wheel input (300ms window) that counts as turbo
  const wheelHist = [];
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey) return;      // pinch-zoom gesture: ignore
    const unit = ev.deltaMode === 1 ? 32 : ev.deltaMode === 2 ? innerHeight : 1;
    const vert = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX);
    const dCss = (vert ? -ev.deltaY : ev.deltaX) * unit;   // + = forward in time
    const now = performance.now();
    if (panMode === "live" || panMode === "return") {
      if (dCss >= 0) return;                         // already live: forward scroll does nothing
      if (now - wheelAccAt > 220 || Math.sign(wheelAcc) !== Math.sign(dCss)) wheelAcc = 0;
      wheelAccAt = now;
      wheelAcc += dCss;
      if (-wheelAcc < WHEEL_MIN) return;
      wheelAcc = 0;
      commitRewind();
    } else if (panMode !== "wheel" && panMode !== "glide") { panPos = shownPan(); panVel = 0; }
    panMode = "glide";
    const d = dCss * pxToWorld();
    // Wheel input rate over a short window decides normal vs turbo.
    wheelHist.push([now, Math.abs(dCss)]);
    while (wheelHist.length && now - wheelHist[0][0] > 300) wheelHist.shift();
    const rate = wheelHist.reduce((a, x) => a + x[1], 0) / 0.3;          // CSS px/s of wheel input
    if (rate > TURBO_RATE) turbo = Math.min(1, turbo + 0.07 * Math.min(3, rate / TURBO_RATE));   // sustained/rapid → builds
    // Reversing direction brakes hard and drops turbo.
    if (panVel !== 0 && Math.sign(panVel) !== Math.sign(d)) { panVel *= 0.2; turbo = 0; }
    // Normal: linear, capped, short glide. Turbo: gain stacks with speed (nonlinear), high ceiling.
    const gain = 9 * (1 + turbo * turbo * Math.abs(panVel) / 1200);
    const cap = VNORM + (VMAX - VNORM) * turbo * turbo;
    panVel = Math.max(-cap, Math.min(cap, panVel + d * gain));
    wheelIdleAt = now;
  }, { passive: false });
  function goLive() { if (!live || panMode !== "live") startReturn(); }
  liveBtn.addEventListener("click", goLive);

  // ---------- auto-hide chrome ----------
  let idleTimer = 0;
  const drawer = $("drawer");
  function poke(ms) {
    document.body.classList.remove("idle");
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
  let reqId = 0;
  const pending = new Set();
  $("cmd").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = $("cmd-input");
    const text = input.value.trim();
    if (!text) return;
    const S = window.TapestrySocial;
    if (S && S.enabled && !S.isAdmin()) {  // production: ideas go to the shared pool
      S.submitIdea(text).then((ok) => { if (ok) input.value = ""; });
      return;
    }
    const req = ++reqId;
    pending.add(req);
    $("cmd").classList.add("busy");
    send({ type: "intent", text, when: ev.submitter && ev.submitter.dataset.when ? ev.submitter.dataset.when : when, req });
    input.value = "";
    toast(interpreterOn ? `Planning <span class="muted">“${esc(text)}”</span>…` : `Queued <span class="muted">“${esc(text)}”</span>`, 2500);
  });
  $("cmd-input").addEventListener("keydown", (ev) => {
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
  function setFF(m) {
    speedMult = m;
    paintFF(m);
    send({ type: "speed", multiplier: m });
    if (m > 1) goLive();
  }
  document.querySelectorAll("#ff button").forEach((b) => b.addEventListener("click", () => setFF(Number(b.dataset.m))));
  function paintFF(m) { document.querySelectorAll("#ff button").forEach((x) => x.classList.toggle("on", Number(x.dataset.m) === m)); }
  paintMode(speedMode);

  window.addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      if (e.key === "Escape") document.activeElement.blur();
      return;
    }
    if (e.key === "/") { e.preventDefault(); $("cmd-input").focus(); }
    else if (e.key === "f" || e.key === "F") { const seq = [1, 2, 4, 8]; setFF(seq[(seq.indexOf(speedMult) + 1) % seq.length]); toast("Fast-forward " + speedMult + "×", 1500); }
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
  function renderQueue(d) {
    const list = $("queue-list");
    if (typeof d.upcoming_seq === "number") {
      if (d.upcoming_seq < upSeq && d.upcoming_seq > 0) return;  // stale snapshot (server restart resets to small numbers)
      upSeq = d.upcoming_seq;
    }
    list.classList.remove("skeleton");
    const items = d.upcoming || d.items || [];
    $("queue-count").textContent = items.length;
    $("queue-empty").classList.toggle("hidden", items.length > 0);
    $("queue-empty").innerHTML = d.autopilot && d.autopilot.enabled ? '<span class="spark">✦</span>Auto is dreaming up what comes next.' : "Nothing queued. Type a destination below.";
    const cur = d.current_scene || { title: d.current, prompt: d.current };
    const tgt = d.target_scene;
    $("current-card").innerHTML =
      `<div class="k">${tgt ? "Transitioning" : "Now playing"} ${srcTag(tgt || cur)}</div>` +
      `<div class="t">${esc(cur.title)}${tgt ? ' <span class="muted">→ ' + esc(tgt.title) + "</span>" : ""}</div>` +
      `<div class="p">${esc((tgt || cur).prompt)}</div>`;
    if (editingId !== null && list.querySelector("textarea")) return; // don't clobber an edit
    // Keyed in-place diff: reuse unchanged rows so the sheet never flashes.
    const old = new Map([...list.children].map((li) => [li.dataset.id, li]));
    let prev = null;
    items.forEach((s, i) => {
      const key = String(s.id);
      const sig = JSON.stringify([i, s.title, s.prompt, s.origin, s.by, s.kind, s.transition, s.hold, editingId === s.id]);
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
        li.innerHTML = `<span class="n">${i + 1}</span><div><div class="t">${esc(s.title)}</div>` +
          `<div class="meta">${s.by ? esc(s.by) + " · " : ""}idea · weaving in soon</div></div>`;
        list.insertBefore(li, prev ? prev.nextSibling : list.firstChild);
        prev = li;
        return;
      }
      li.draggable = true;
      li.innerHTML =
        `<span class="n">${i + 1}</span><div><div class="t">${esc(s.title)}</div>` +
        (editingId === s.id
          ? `<textarea>${esc(s.prompt)}</textarea>`
          : `<div class="p" title="${esc(s.prompt)}">${esc(s.prompt)}</div>`) +
        `<div class="meta">${s.transition ? s.transition : d.blend} strip blend · hold ${s.hold ?? d.hold}${s.source ? " · from “" + esc(s.source.slice(0, 40)) + "”" : ""}</div></div>` +
        `<div class="acts">` +
        `<button class="icon" data-a="play" title="Play now">${ICON.play}</button>` +
        `<button class="icon" data-a="up" title="Move up">${ICON.up}</button>` +
        `<button class="icon" data-a="down" title="Move down">${ICON.down}</button>` +
        `<button class="icon" data-a="edit" title="Edit">${ICON.edit}</button>` +
        `<button class="icon" data-a="del" title="Remove">${ICON.del}</button></div>`;
      li.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        const a = b.dataset.a;
        if (a === "play") send({ type: "play", id: s.id });
        else if (a === "up") send({ type: "move", id: s.id, to: Math.max(0, i - 1) });
        else if (a === "down") send({ type: "move", id: s.id, to: i + 1 });
        else if (a === "del") send({ type: "remove", id: s.id });
        else if (a === "edit") { editingId = s.id; renderQueue(d); const ta = li.ownerDocument.querySelector(`li[data-id="${s.id}"] textarea`); ta && ta.focus(); }
      }));
      const ta = li.querySelector("textarea");
      if (ta) {
        const commit = () => { const v = ta.value.trim(); editingId = null; if (v && v !== s.prompt) send({ type: "edit", id: s.id, prompt: v }); else renderQueue(director); };
        ta.addEventListener("blur", commit);
        ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ta.blur(); } if (e.key === "Escape") { editingId = null; renderQueue(director); } });
      }
      li.addEventListener("dragstart", () => { dragId = s.id; li.classList.add("dragging"); });
      li.addEventListener("dragend", () => { dragId = null; li.classList.remove("dragging"); });
      li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("over"); });
      li.addEventListener("dragleave", () => li.classList.remove("over"));
      li.addEventListener("drop", (e) => { e.preventDefault(); li.classList.remove("over"); if (dragId !== null && dragId !== s.id) send({ type: "move", id: dragId, to: i }); });
      list.insertBefore(li, prev ? prev.nextSibling : list.firstChild);
      prev = li;
    });
    old.forEach((li) => li.remove());
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
    if (histKey === null) {
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
    if (histKey === null) srcEl.textContent = shown.origin === "auto" ? "✦ Auto" : shown.origin === "user" ? (shown.by || "You") : "Now";
    if (histKey === null) srcEl.className = "src" + (shown.origin === "auto" ? " auto" : "");
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
    if (msg.director) showDirector(msg.director);
    if (msg.type === "config") {
      config = Object.assign(config, msg);
      interpreterOn = !!msg.interpreter;
      delete config.type;
      window.dispatchEvent(new CustomEvent("tapestry:config", { detail: msg }));
    } else if (msg.type === "ping") {
      send({ type: "pong" });
    } else if (msg.type === "clock") {
      onClock(msg);
    } else if (msg.type === "fuel" || msg.type === "activity" || msg.type === "auth") {
      window.dispatchEvent(new CustomEvent("tapestry:" + msg.type, { detail: msg }));
    } else if (msg.type === "notice") {
      pending.clear(); $("cmd").classList.remove("busy");
      toast(esc(msg.text), 3500);
    } else if (msg.type === "activity") {
      if (msg.text !== lastOwnText) toast(`Someone added <span class="muted">“${esc(msg.text)}”</span> → ${(msg.titles || []).map(esc).join(" → ")}`, 4500);
    } else if (msg.type === "plan") {
      pending.delete(msg.req);
      lastOwnText = msg.text;
      if (!pending.size) $("cmd").classList.remove("busy");
      const p = msg.plan || {};
      const titles = (msg.scenes || []).map((s) => esc(s.title)).join(" → ");
      toast((p.source === "haiku" ? "Planned " : "Queued ") + titles +
        (p.note ? `<br><span class="muted">${esc(p.note)}</span>` : ""), 6000);
    }
  }

  window.TapestryWS = { send: (o) => send(o), toast: (h, ms) => toast(h, ms), esc: (x) => esc(x) };
  function connect() {
    const url = wsUrl();
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      connected = true;
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
    ws.onclose = () => {
      connected = false;
      window.__tapestryWsOpen = false; window.dispatchEvent(new CustomEvent("tapestry:ws", { detail: { open: false } }));
      if (clientPingTimer) clearInterval(clientPingTimer);
      const wait = reconnectDelay * (0.75 + Math.random() * 0.5);  // jitter
      setTimeout(connect, navigator.onLine === false ? 3000 : wait);
      reconnectDelay = Math.min(30000, reconnectDelay * 1.6);
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

  connect();
  requestAnimationFrame(frame);
})();

// ---------- phones: slim pill → compose sheet, overflow, sheet drag-to-dismiss, chat in a sheet ----------
(() => {
  const $ = (id) => document.getElementById(id);
  const phone = matchMedia("(max-width: 560px)");
  const body = document.body, cmd = $("cmd"), input = $("cmd-input"), more = $("more-btn"), drawer = $("drawer");
  if (!cmd || !more) return;
  // Compose: focusing the pill turns the dock into a sheet with attach + queue/now + send.
  const setCompose = (on) => body.classList.toggle("composing", on && phone.matches);
  input.addEventListener("focus", () => { setCompose(true); setMore(false); });
  cmd.addEventListener("focusout", () => setTimeout(() => { if (!cmd.contains(document.activeElement) && !input.value) setCompose(false); }, 120));
  cmd.addEventListener("submit", () => setTimeout(() => { if (!input.value) { input.blur(); setCompose(false); } }, 50));
  document.addEventListener("pointerdown", (e) => {
    if (body.classList.contains("composing") && !cmd.contains(e.target) && !input.value) { input.blur(); setCompose(false); }
    if (body.classList.contains("more-open") && !cmd.contains(e.target)) setMore(false);
  }, true);
  // Overflow: secondary actions in a compact row above the pill.
  function setMore(on) { const cap = document.querySelector(".dock .now"); if (cap) cap.style.visibility = on ? "hidden" : ""; body.classList.toggle("more-open", on); more.setAttribute("aria-expanded", on ? "true" : "false"); }
  more.addEventListener("click", (e) => { e.preventDefault(); setMore(!body.classList.contains("more-open")); });
  cmd.querySelectorAll(".sec").forEach((b) => b.addEventListener("click", () => phone.matches && b.id !== "speed-btn" && setTimeout(() => setMore(false), 150)));
  // Chat lives in the sheet on phones.
  const chat = $("chat"), chatHome = chat && chat.parentNode, chatPanel = $("panel-chat");
  const placeChat = () => {
    if (!chat || !chatPanel) return;
    if (phone.matches && chat.parentNode !== chatPanel) chatPanel.appendChild(chat);
    else if (!phone.matches && chat.parentNode !== chatHome) chatHome.appendChild(chat);
  };
  phone.addEventListener("change", placeChat); placeChat();
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
