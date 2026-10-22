// Frontend build: multi-page Vite app rooted at frontend/. Hashed bundles land in /assets (immutable cache);
// a few files keep stable root URLs because server-rendered pages and the admin UI load them by name:
//   /sb.js      Supabase client (admin UI from /api/admin, profile/confirm/chrome)
//   /chrome.js  shared header account swap (injected into static pages and /s/<id> share pages)
// Public, never-bundled files (theme.js before paint, chrome.css, brand/, sw.js, ...) live in frontend/public.
import { resolve } from "node:path";
import { readdirSync } from "node:fs";
import { defineConfig } from "vite";

const root = resolve(import.meta.dirname, "frontend");
const pages = Object.fromEntries(readdirSync(root).filter((f) => f.endsWith(".html")).map((f) => [f.slice(0, -5), resolve(root, f)]));
const STABLE = new Set(["sb", "chrome"]);

export default defineConfig({
  root,
  publicDir: resolve(root, "public"),
  build: {
    outDir: resolve(import.meta.dirname, "dist/site"),
    emptyOutDir: true,
    target: "es2022",
    // CSS ships as written (no lowering/minify rewrites): the stylesheet is the visual spec.
    cssTarget: "esnext",
    cssMinify: false,
    sourcemap: true,
    rollupOptions: {
      input: { ...pages, sb: resolve(root, "src/legacy/sb.js"), chrome: resolve(root, "src/legacy/chrome.js") },
      output: {
        entryFileNames: (c) => (STABLE.has(c.name) ? "[name].js" : "assets/[name]-[hash].js"),
      },
    },
  },
  server: {
    // `npm run dev` against a local worker (`make dev` on :8000): the pod endpoints proxy through.
    proxy: Object.fromEntries(["/ws", "/timeline", "/lod", "/export.png", "/health", "/strips"].map((p) => [p, { target: "http://127.0.0.1:8000", ws: p === "/ws" }])),
  },
});
