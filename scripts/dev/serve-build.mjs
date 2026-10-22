// Serve a built site (scripts/build_web.sh OUT, or dist/site) locally the way Vercel does, for parity/perf runs:
// vercel.json-style rewrites for the static pages, /api/* proxied to a real deployment (read-only GETs by default).
// Usage: node scripts/dev/serve-build.mjs <dir> [port=8765] [api-origin=https://infinitetapestry.app]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] || "dist/site");
const port = Number(process.argv[3] || 8765);
const api = (process.argv[4] || "https://infinitetapestry.app").replace(/\/$/, "");
const REWRITE = { "/about": "/about.html", "/fuel": "/fuel.html", "/time-machine": "/time-machine.html", "/terms": "/terms.html",
  "/privacy": "/privacy.html", "/admin": "/admin.html", "/auth/confirm": "/confirm.html" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".map": "application/json", ".woff2": "font/woff2" };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/s/") || u.pathname.startsWith("/m/")) {
    if (req.method !== "GET" && process.env.ALLOW_WRITES !== "1") { res.writeHead(403); return res.end("read-only proxy"); }
    try {
      const r = await fetch(api + u.pathname + u.search, { headers: { "user-agent": "it-parity" }, redirect: "manual" });
      const body = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/octet-stream", "cache-control": "no-store" });
      return res.end(body);
    } catch (e) { res.writeHead(502); return res.end(String(e)); }
  }
  let p = REWRITE[u.pathname] || u.pathname;
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(dir, path.normalize(p));
  if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(f).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`serving ${dir} on http://127.0.0.1:${port} (api -> ${api})`));
