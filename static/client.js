/**
 * Infinite Tapestry browser client.
 * - Backend WS URL: ?ws=... > window.TAPESTRY_CONFIG.wsUrl > page origin (/ws).
 * - Auto speed follows GPU throughput; Claude-planned scene queue; drag to pan.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $("view");
  const ctx = canvas.getContext("2d", { alpha: false });
  const statusEl = $("status");
  const statusText = $("status-text");
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

  function frame(ts) {
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
    draw();
    hudTimer += dt;
    if (hudTimer > 0.5) { hudTimer = 0; updateHud(srvSpeed, livePos === null ? 0 : panoramaWidth() - livePos); }
    requestAnimationFrame(frame);
  }
  let hudTimer = 1;

  function draw() {
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#050505";
    ctx.fillRect(0, 0, w, h);
    if (maxIndex < 0) {
      ctx.fillStyle = "rgba(255,255,255,.4)";
      ctx.font = `${14 * (window.devicePixelRatio || 1)}px Inter, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(connected ? "Painting the first strips…" : "Connecting…", w / 2, h / 2);
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
    requestMissing(firstIdx - 8, lastIdx + 2);
    evictFar(firstIdx, lastIdx);
  }

  function updateHud(speed, ahead) {
    const aheadStrips = Math.max(0, ahead / SW());
    statusEl.classList.toggle("off", !connected);
    statusEl.classList.toggle("warn", connected && live && aheadStrips < 1);
    if (!connected) { statusText.textContent = "offline · reconnecting"; return; }
    const parts = [];
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

  // ---------- drag to pan ----------
  let dragging = false, dragStartX = 0, dragStartPan = 0;
  function enterHistory() { if (live) { panX = Math.max(0, liveScroll); live = false; liveBtn.classList.remove("hidden"); } }
  canvas.addEventListener("pointerdown", (ev) => {
    dragging = true;
    canvas.setPointerCapture(ev.pointerId);
    dragStartX = ev.clientX;
    enterHistory();
    dragStartPan = panX;
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
    enterHistory();
    panX = Math.max(0, Math.min(panoramaWidth() - viewWorld(), panX + (ev.deltaX || ev.deltaY)));
    ev.preventDefault();
  }, { passive: false });
  function goLive() { live = true; liveBtn.classList.add("hidden"); }
  liveBtn.addEventListener("click", goLive);

  // ---------- auto-hide chrome ----------
  let idleTimer = 0;
  const drawer = $("drawer");
  function poke() {
    document.body.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const busy = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
      if (busy || drawer.classList.contains("open") || !$("speed-pop").classList.contains("hidden") || !$("export-pop").classList.contains("hidden")) return poke();
      document.body.classList.add("idle");
    }, 3500);
  }
  ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"].forEach((e) =>
    window.addEventListener(e, poke, { passive: true }));
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
  $("loop").addEventListener("change", () => send({ type: "configure", loop: $("loop").checked }));
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

  function renderQueue(d) {
    const list = $("queue-list");
    const items = d.items || [];
    $("queue-count").textContent = items.length;
    $("queue-empty").classList.toggle("hidden", items.length > 0);
    const cur = d.current_scene || { title: d.current, prompt: d.current };
    const tgt = d.target_scene;
    $("current-card").innerHTML =
      `<div class="k">${tgt ? "Transitioning" : "Now playing"}</div>` +
      `<div class="t">${esc(cur.title)}${tgt ? ' <span class="muted">→ ' + esc(tgt.title) + "</span>" : ""}</div>` +
      `<div class="p">${esc((tgt || cur).prompt)}</div>`;
    if (editingId !== null && list.querySelector("textarea")) return; // don't clobber an edit
    list.innerHTML = "";
    items.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = "item";
      li.draggable = true;
      li.dataset.id = s.id;
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
      list.appendChild(li);
    });
  }

  function showDirector(d) {
    if (!d) return;
    director = d;
    const cur = d.current_scene || { title: d.current };
    const tgt = d.target_scene;
    const next = tgt || (d.items && d.items[0]);
    $("now-title").textContent = cur.title || d.current;
    $("now-arrow").classList.toggle("hidden", !next);
    $("next-title").textContent = next ? next.title : "";
    const prog = tgt ? (d.transition_progress || 0) : Math.min(1, (d.held || 0) / Math.max(1, d.hold_for || d.hold || 1));
    $("now-bar").style.width = (prog * 100).toFixed(0) + "%";
    if (document.activeElement !== $("hold")) $("hold").value = d.hold;
    if (document.activeElement !== $("blend")) $("blend").value = d.blend;
    $("loop").checked = !!d.loop;
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
    } else if (msg.type === "ping") {
      send({ type: "pong" });
    } else if (msg.type === "clock") {
      onClock(msg);
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

  function connect() {
    const url = wsUrl();
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      connected = true;
      reconnectDelay = 1000;
      requested.clear();
      livePos = null;
      if (clientPingTimer) clearInterval(clientPingTimer);
      clientPingTimer = setInterval(() => send({ type: "ping" }), 25000);
      send({ type: "status_request" });
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
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(15000, reconnectDelay * 1.5);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  connect();
  requestAnimationFrame(frame);
})();
