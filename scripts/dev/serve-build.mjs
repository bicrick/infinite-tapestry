// Serve a built site (scripts/build_web.sh OUT, or dist/site) locally the way Vercel does, for parity/perf runs:
// vercel.json-style rewrites for the static pages, /api/* proxied to a real deployment (read-only GETs by default).
// Usage: node scripts/dev/serve-build.mjs <dir> [port=8765] [api-origin=https://infinitetapestry.app]
// Env LOCAL_LOD=<dir>: test a not-yet-uploaded LOD build. /api/live's config.lod_base points here; /live-sdxl/... is
// served from <dir>/live-sdxl/... when the file exists, else redirected to the CDN (so lod/, lodx/ come from R2).
// LOCAL_LOD_ORIGIN=http://127.0.0.1:<p2> points lod_base at a second server instead (own connection pool, like the CDN).
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

const LOCAL_LOD = process.env.LOCAL_LOD ? path.resolve(process.env.LOCAL_LOD) : "";
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (LOCAL_LOD && u.pathname.startsWith("/live-sdxl/")) {
    const f = path.join(LOCAL_LOD, path.normalize(u.pathname));
    const cors = { "access-control-allow-origin": "*" };
    if (f.startsWith(LOCAL_LOD) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { ...cors, "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "public, max-age=3600" });
      return fs.createReadStream(f).pipe(res);
    }
    res.writeHead(302, { ...cors, location: "https://img.infinitetapestry.app" + u.pathname }); return res.end();
  }
  if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/s/") || u.pathname.startsWith("/m/")) {
    if (req.method !== "GET" && process.env.ALLOW_WRITES !== "1") { res.writeHead(403); return res.end("read-only proxy"); }
    try {
      const r = await fetch(api + u.pathname + u.search, { headers: { "user-agent": "it-parity" }, redirect: "manual" });
      let body = Buffer.from(await r.arrayBuffer());
      if (LOCAL_LOD && u.pathname === "/api/live" && r.ok) {
        try { const j = JSON.parse(body.toString()); if (j.config && j.config.lod_base) { j.config.lod_base = j.config.lod_base.replace(/^https?:\/\/[^/]+/, process.env.LOCAL_LOD_ORIGIN || `http://127.0.0.1:${port}`); body = Buffer.from(JSON.stringify(j)); } } catch { /* pass through */ }
      }
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
