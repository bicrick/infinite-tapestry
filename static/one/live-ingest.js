// Tapestry.ingest: the live socket, moved from client.js (wsUrl / send / decodeStrip / onStripBinary / onStripRef /
// onClock, same protocol v2, no server change). Strips go straight into the tile store (level 0, unit = SDXL g0 +
// index); the head advances at the server's shared speed, eased, and never past strips that are actually resident
// (new pixels never surface on screen before they exist).
(() => {
  "use strict";
  const T = (window.Tapestry = window.Tapestry || {});
  const MAGIC = "ITAP", HEADER = 16;
  const ls = new Map(); const emit = (n, a) => { const s = ls.get(n); if (s) for (const f of s) f(a); };
  let ws = null, podWs = null, connected = false, delay = 1000, pingT = 0;
  let config = { strip_width: 256 }, maxIndex = -1, base = 0, livePos = null, speed = 0, corr = 0, viewers = 1, lastStripAt = 0;
  const SW = () => config.strip_width || 256;
  function wsUrl() {
    const q = new URLSearchParams(location.search).get("ws"), cfg = (window.TAPESTRY_CONFIG && window.TAPESTRY_CONFIG.wsUrl) || "";
    let url = q || podWs || cfg; if (!url) return null;
    if (url.startsWith("https://")) url = "wss://" + url.slice(8); if (url.startsWith("http://")) url = "ws://" + url.slice(7);
    if (!/\/ws\/?$/.test(url)) url = url.replace(/\/$/, "") + "/ws"; return url;
  }
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  function decodeStrip(buf) {
    const v = new DataView(buf); let m = ""; for (let i = 0; i < 4; i++) m += String.fromCharCode(v.getUint8(i)); if (m !== MAGIC) return null;
    const index = v.getUint32(4), overlap = v.getUint16(12), pl = v.getUint16(14);
    return { index, overlap, prompt: new TextDecoder().decode(new Uint8Array(buf, HEADER, pl)), jpeg: buf.slice(HEADER + pl) };
  }
  function bump(i) { if (i > maxIndex) { maxIndex = i; emit("head"); } }
  function onStripBinary(buf) {
    const m = decodeStrip(buf); if (!m) return; bump(m.index); arrived(base + m.index, m.overlap); lastStripAt = performance.now();
    createImageBitmap(new Blob([m.jpeg], { type: config.strip_mime || "image/jpeg" })).then((bm) => { T.tiles.ingestStrip(base + m.index, bm); emit("strip", base + m.index); }).catch(() => {});
  }
  function onStripRef(r, live) {
    if (!r || typeof r.i !== "number") return; bump(r.i);
    if (Array.isArray(r.s)) emit("caption", { g: base + r.i, s: r.s });
    if (live) { arrived(base + r.i, r.o); lastStripAt = performance.now(); T.tiles.noteFresh(base + r.i, 3500); emit("strip", base + r.i); }
  }
  function onClock(m) {
    speed = m.speed || 0; viewers = m.viewers || viewers;
    const projected = m.pos + m.speed * Math.max(0, m.now - m.ts);
    if (livePos === null || Math.abs(projected - livePos) > SW() * 6) livePos = projected; else corr = projected - livePos;
    emit("clock", m);
  }
  function handle(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "strip") return onStripRef(msg, true);
    if (msg.type === "strips") return (msg.items || []).forEach((r) => onStripRef(r, false));
    if (msg.type === "config") { config = Object.assign(config, msg); delete config.type; emit("config", msg); return; }
    if (msg.type === "ping") return send({ type: "pong" });
    if (msg.type === "clock") return onClock(msg);
    emit("msg", msg); // chat, react, fuel, ... (UI layer, phase 4)
  }
  function connect() {
    const url = wsUrl(); if (!url) return;
    try { ws = new WebSocket(url + (url.includes("?") ? "&" : "?") + "v=2"); } catch (_) { return; }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { connected = true; delay = 1000; livePos = null; send({ type: "upcoming_request" }); send({ type: "status_request" });
      clearInterval(pingT); pingT = setInterval(() => send({ type: "ping" }), 25000); emit("ws", true); };
    ws.onmessage = (ev) => { if (typeof ev.data === "string") { try { handle(JSON.parse(ev.data)); } catch (_) {} } else onStripBinary(ev.data); };
    ws.onclose = () => { connected = false; clearInterval(pingT); emit("ws", false); setTimeout(connect, delay * (0.75 + Math.random() * 0.5)); delay = Math.min(8000, delay * 1.6); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  // Eased head (units): advances at the shared speed, bleeds in clock corrections, stops short of the first strip
  // that is not resident yet (soft limit, like client.js), so the edge never shows pixels before they exist.
  // Arrival log for the edge hook: g -> {at (performance.now ms), wall (epoch ms), overlap (units)}; last 64 strips.
  const arrivals = new Map();
  function arrived(g, ovPx) { if (arrivals.has(g)) return; arrivals.set(g, { at: performance.now(), wall: Date.now(), overlap: (ovPx != null ? ovPx : config.overlap || 0) / SW() }); if (arrivals.size > 64) arrivals.delete(arrivals.keys().next().value); }
  let headU = null;
  function step(dt) {
    if (maxIndex < 0) return headU;
    if (livePos === null) { livePos = Math.max(0, maxIndex - 1) * SW(); } // start two strips back and ease in (as client.js)
    let k = Math.max(0, Math.floor(livePos / SW()) - 2); while (k <= maxIndex && T.tiles.peek(0, base + k)) k++;
    const limit = Math.min((maxIndex + 1) * SW(), k * SW()), fix = corr * Math.min(1, dt * 1.5); corr -= fix;
    const ease = Math.max(0, Math.min(1, (limit - livePos) / (0.75 * SW())));
    if (livePos < limit) livePos = Math.min(limit, livePos + speed * dt * ease + Math.min(fix, Math.max(0, limit - livePos)));
    headU = base + livePos / SW(); return headU;
  }
  T.ingest = {
    start({ sdxlBase, apiBase = "" }) {
      base = sdxlBase;
      fetch(`${apiBase}/api/live?n=240`).then((r) => r.json()).then((j) => {
        if (j.config) config = Object.assign(config, j.config);
        (j.items || []).forEach((r) => onStripRef(r, false));
        if (j.pod && j.pod.ws && !new URLSearchParams(location.search).get("ws")) podWs = j.pod.ws;
        emit("boot", j);
      }).catch(() => {}).finally(connect);
    },
    step, send, wsUrl,
    arrivals: () => arrivals,
    headTime: () => headU,               // eased live edge (unit), null before the first ref
    maxUnit: () => (maxIndex < 0 ? null : base + maxIndex + 1),
    connected: () => connected, viewers: () => viewers, live: () => connected && performance.now() - lastStripAt < 60000,
    on(n, f) { if (!ls.has(n)) ls.set(n, new Set()); ls.get(n).add(f); },
  };
})();
