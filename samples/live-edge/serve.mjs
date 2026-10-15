// Sample server for the live-edge prototypes. Serves static/ unchanged and builds /one-3c9d1f.html from
// static/one/page.html exactly as scripts/make_one.js does. With ?edge=develop|drift|crystal it appends the
// sample scripts (edge-core.js + the variant) before </body>; the app files are never modified.
//
//   node samples/live-edge/serve.mjs [--port=8765] [--live] [--manual]
//
// Default (replay): /api/live and the socket are served locally. The socket speaks protocol v2 (config, clock,
// strip refs) and replays real SDXL strips from R2 (the seaside/train stretch) at a compressed cadence so a few
// seconds show several arrivals. --manual: no automatic cadence; the recorder posts /replay/ref?i=N and
// /replay/clock?pos=&speed= itself. --live: /api/* is proxied to production and the page uses the real pod socket.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const STATIC = path.join(ROOT, "static");
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const PORT = +arg("port", 8765);
const LIVE = process.argv.includes("--live");
const MANUAL = process.argv.includes("--manual");
const PROD = "infinite-tapestry.vercel.app";

// Replay range: SDXL index i (global unit g = 1269 + i). 44836 -> g 46105 (kites, the bay); the train pulls in ~46110.
const SW = 256, OV = 192;
const I_BOOT = +arg("boot", 44840), I_LAST = +arg("last", 44849), CADENCE = +arg("cadence", 1300), SPEED = +arg("speed", 0.9) * SW;
const CONFIG = { height: 1024, strip_width: SW, overlap: OV, scroll_speed: 60, strip_ext: "webp", strip_mime: "image/webp",
  strip_base: "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev/live-sdxl/strips/" };

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

function onePage(q) {
  let html = fs.readFileSync(path.join(STATIC, "one", "page.html"), "utf8");
  const edge = q.get("edge");
  if (edge && /^[a-z]+$/.test(edge)) {
    html = html.replace("</body>", `  <script src="/samples/live-edge/edge-core.js"></script>\n  <script src="/samples/live-edge/variants/${edge}.js"></script>\n</body>`);
  }
  return html;
}

function proxy(req, res) {
  const r = https.request({ host: PROD, path: req.url, method: req.method, headers: { ...req.headers, host: PROD } }, (up) => {
    res.writeHead(up.statusCode, up.headers); up.pipe(res);
  });
  r.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(r);
}

// ---------- replay socket (minimal RFC 6455: server -> client text frames; client frames are ignored) ----------
const sockets = new Set();
function frame(str) {
  const p = Buffer.from(str), n = p.length;
  const h = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : null;
  return Buffer.concat([h, p]);
}
const broadcast = (o) => { const f = frame(JSON.stringify(o)); for (const s of sockets) s.write(f); };
let sent = I_BOOT, autoT = null;
const ref = (i) => broadcast({ type: "strip", i, o: OV, s: ["", "", "", "auto"] });
const clock = (pos, speed) => broadcast({ type: "clock", pos, speed, now: 0, ts: 0, viewers: 1 });
function startAuto() {
  if (MANUAL || autoT) return;
  autoT = setInterval(() => { if (!sockets.size) return; sent = sent >= I_LAST ? I_BOOT : sent + 1; if (sent === I_BOOT) return; ref(sent); }, CADENCE);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"), q = u.searchParams;
  if (u.pathname === "/one-3c9d1f.html") { res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" }); return res.end(onePage(q)); }
  if (u.pathname.startsWith("/replay/")) {
    if (u.pathname === "/replay/ref") ref(+q.get("i"));
    else if (u.pathname === "/replay/clock") clock(+q.get("pos"), +q.get("speed"));
    res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ sockets: sockets.size }));
  }
  if (u.pathname === "/api/live" && !LIVE) {
    const items = []; for (let i = I_BOOT - 239; i <= I_BOOT; i++) items.push({ i, o: OV, s: ["", "", "", "auto"] });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ config: CONFIG, max: I_BOOT, items, pod: { status: "running", ws: `ws://127.0.0.1:${PORT}/ws` } }));
  }
  if (u.pathname.startsWith("/api/")) return proxy(req, res);
  const rel = u.pathname.startsWith("/samples/") ? path.join(ROOT, decodeURIComponent(u.pathname)) : path.join(STATIC, decodeURIComponent(u.pathname === "/" ? "/index.html" : u.pathname));
  if (!rel.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(rel, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(rel)] || "application/octet-stream", "cache-control": "no-store" }); res.end(buf);
  });
});
server.on("upgrade", (req, sock) => {
  if (LIVE || !req.url.startsWith("/ws")) return sock.destroy();
  const acc = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
  sockets.add(sock); sock.on("data", () => {}); sock.on("close", () => sockets.delete(sock)); sock.on("error", () => sockets.delete(sock));
  sock.write(frame(JSON.stringify({ type: "config", ...CONFIG })));
  sock.write(frame(JSON.stringify({ type: "clock", pos: (I_BOOT - 1) * SW, speed: SPEED, now: 0, ts: 0, viewers: 1 })));
  startAuto();
});
server.listen(PORT, "127.0.0.1", () => console.log(`live-edge samples: http://127.0.0.1:${PORT}/one-3c9d1f.html?edge=develop  (${LIVE ? "live" : MANUAL ? "replay, manual" : "replay"})`));
