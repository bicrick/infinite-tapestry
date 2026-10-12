/**
 * Infinite Tapestry browser client.
 * - Backend WS URL: ?ws=... > window.TAPESTRY_CONFIG.wsUrl > page origin (/ws).
 * - Live prompt / playlist control, fast-forward, drag to pan through history.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $("view");
  const ctx = canvas.getContext("2d", { alpha: false });
  const statsEl = $("stats");
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

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
  }
  window.addEventListener("resize", resize);
  resize();

  const SW = () => config.strip_width;
  const scale = () => canvas.height / Math.max(1, config.height);
  const viewWorld = () => canvas.width / scale();
  const panoramaWidth = () => (maxIndex + 1) * SW();
  const viewLeft = () => (live ? liveScroll : panX);

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

  function evictFar(firstIdx, lastIdx) {
    for (const e of strips.values()) {
      if (e.bitmap && (e.index < firstIdx - KEEP_DECODED || e.index > lastIdx + KEEP_DECODED)) {
        e.bitmap.close && e.bitmap.close();
        e.bitmap = null;
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

  function ackLiveProgress() {
    const rightEdge = liveScroll + viewWorld();
    const visibleThrough = Math.min(maxIndex, Math.floor(rightEdge / SW()));
    if (visibleThrough > lastAckIndex) {
      lastAckIndex = visibleThrough;
      send({ type: "ack", index: visibleThrough });
    }
  }

  function baseSpeed() {
    if (bufferLow || bufferDepth < config.buffer_min) return config.scroll_speed_min;
    const t = Math.min(1, Math.max(0,
      (bufferDepth - config.buffer_min) / Math.max(1, config.buffer_target - config.buffer_min)));
    return config.scroll_speed_min + (config.scroll_speed - config.scroll_speed_min) * t;
  }

  function frame(ts) {
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;

    // With fast-forward, go as fast as the multiplier allows but never past
    // the generated edge (ease off when the runway gets short).
    const ahead = panoramaWidth() - liveScroll - viewWorld();
    let speed = Math.max(baseSpeed(), config.scroll_speed_min) * speedMult;
    if (speedMult > 1) speed = config.scroll_speed * speedMult;
    const runway = SW() * 1.5;
    if (ahead < runway) speed = Math.min(speed, config.scroll_speed_min * Math.max(0, ahead / runway));
    if (ahead > 0) liveScroll += speed * dt;

    draw();
    updateHud(speed, ahead);
    ackTimer += dt;
    if (ackTimer >= 0.25) {
      ackTimer = 0;
      ackLiveProgress();
    }
    requestAnimationFrame(frame);
  }

  function draw() {
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#0c1014";
    ctx.fillRect(0, 0, w, h);
    if (maxIndex < 0) {
      ctx.fillStyle = "#8a9aab";
      ctx.font = "16px sans-serif";
      ctx.fillText(connected ? "Waiting for strips…" : "Connecting…", 24, h / 2);
      return;
    }
    const s = scale();
    const left = viewLeft();
    const firstIdx = Math.max(0, Math.floor(left / SW()) - 1);
    const lastIdx = Math.ceil((left + viewWorld()) / SW()) + 1;
    ctx.save();
    ctx.scale(s, s);
    for (let i = firstIdx; i <= Math.min(lastIdx, maxIndex); i++) {
      const e = strips.get(i);
      if (!e) continue;
      ensureDecoded(e);
      if (!e.bitmap) continue;
      ctx.drawImage(e.bitmap, i * SW() - e.overlap - left, 0);
    }
    ctx.restore();
    // Prefetch neighbours while panning; drop far bitmaps.
    requestMissing(firstIdx - 8, lastIdx + 2);
    evictFar(firstIdx, lastIdx);
  }

  function updateHud(speed, ahead) {
    const low = bufferLow || ahead < SW() * 2;
    statsEl.classList.toggle("low", live && low);
    const pos = Math.floor(viewLeft() / SW());
    statsEl.textContent =
      (connected ? (live ? "live" : "history") : "offline") +
      "  |  strip " + pos + "/" + maxIndex +
      "  |  buf " + bufferDepth + "/" + config.buffer_target +
      "  |  " + speedMult + "x " + speed.toFixed(0) + " px/s" +
      (live && low ? "  (waiting on GPU)" : "");
  }

  // ---------- drag to pan ----------
  let dragging = false, dragStartX = 0, dragStartPan = 0;
  canvas.addEventListener("pointerdown", (ev) => {
    dragging = true;
    canvas.setPointerCapture(ev.pointerId);
    dragStartX = ev.clientX;
    dragStartPan = viewLeft();
    panX = dragStartPan;
    live = false;
    liveBtn.classList.remove("hidden");
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    const dx = ((ev.clientX - dragStartX) * dpr) / scale();
    panX = Math.max(0, Math.min(panoramaWidth() - viewWorld(), dragStartPan - dx));
  });
  const endDrag = () => { dragging = false; };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", (ev) => {
    if (live) { panX = liveScroll; live = false; liveBtn.classList.remove("hidden"); }
    panX = Math.max(0, Math.min(panoramaWidth() - viewWorld(), panX + (ev.deltaX || ev.deltaY)));
    ev.preventDefault();
  }, { passive: false });
  liveBtn.addEventListener("click", () => {
    live = true;
    liveBtn.classList.add("hidden");
  });

  // ---------- controls ----------
  const panel = $("panel");
  $("panel-toggle").addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    $("panel-toggle").textContent = panel.classList.contains("collapsed") ? "Controls ▸" : "Controls ▾";
  });
  document.querySelectorAll("button.spd").forEach((b) =>
    b.addEventListener("click", () => {
      speedMult = Number(b.dataset.m) || 1;
      document.querySelectorAll("button.spd").forEach((x) => x.classList.toggle("active", x === b));
      send({ type: "speed", multiplier: speedMult });
    })
  );
  const blendEl = $("blend");
  blendEl.addEventListener("input", () => { $("blend-val").textContent = blendEl.value + " strips"; });
  $("prompt-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const p = $("prompt-input").value.trim();
    if (!p) return;
    send({ type: "set_prompt", prompt: p, blend: Number(blendEl.value) });
    $("prompt-input").value = "";
  });
  let playlistDirty = false;
  $("playlist").addEventListener("input", () => { playlistDirty = true; });
  $("queue-save").addEventListener("click", () => {
    const prompts = $("playlist").value.split("\n").map((s) => s.trim()).filter(Boolean);
    send({
      type: "queue", prompts, hold: Number($("hold").value),
      blend: Number(blendEl.value), loop: $("loop").checked,
    });
    playlistDirty = false;
  });
  $("skip").addEventListener("click", () => send({ type: "skip" }));

  function showDirector(d) {
    if (!d) return;
    director = d;
    $("now-prompt").textContent = d.target ? d.current + "  →  " + d.target : d.current;
    if (!playlistDirty && document.activeElement !== $("playlist")) {
      $("playlist").value = (d.queue || []).join("\n");
      if (document.activeElement !== $("hold")) $("hold").value = d.hold;
      $("loop").checked = !!d.loop;
    }
  }

  function handleJson(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.buffer) {
      bufferDepth = msg.buffer.depth ?? bufferDepth;
      bufferLow = !!msg.buffer.low;
    }
    if (msg.director) showDirector(msg.director);
    if (msg.type === "config") {
      config = Object.assign(config, msg);
      delete config.type;
    } else if (msg.type === "ping") {
      send({ type: "pong" });
    }
  }

  function connect() {
    const url = wsUrl();
    statsEl.textContent = "connecting " + url;
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      connected = true;
      reconnectDelay = 1000;
      requested.clear();
      if (clientPingTimer) clearInterval(clientPingTimer);
      clientPingTimer = setInterval(() => send({ type: "ping" }), 25000);
      send({ type: "status_request" });
      if (speedMult > 1) send({ type: "speed", multiplier: speedMult });
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
      if (clientPingTimer) clearInterval(clientPingTimer);
      statsEl.textContent = "disconnected — retrying…";
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(15000, reconnectDelay * 1.5);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  connect();
  requestAnimationFrame(frame);
})();
