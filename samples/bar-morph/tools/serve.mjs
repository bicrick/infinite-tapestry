import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png" };

export function serve(root) {
  const server = http.createServer(async (req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}
