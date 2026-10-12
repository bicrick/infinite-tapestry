const OWNER = (h) => String(h || "").toLowerCase() === "bicrick";   // never credited in previews
const { rest } = require("../lib/common");

// /s/<id>: a share page with a rich preview of where the idea landed, then straight into the tapestry.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function moment(req, res) {
  const m = String(req.query.m || "").match(/^(\d{1,7})-(\d{1,7})$/);
  if (!m) { res.setHeader("location", "/"); return res.status(302).end(); }
  const a = +m[1], b = Math.max(a, Math.min(+m[2], a + 63));
  const host = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  const target = `/?at=${a}&to=${b}`, img = `${host}/api/og?card=at&a=${a}&b=${b}`;
  const title = "A moment from the Infinite Tapestry", desc = "An endless painting that never stops, steered by everyone watching.";
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "public, s-maxage=86400");
  return res.status(200).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>${title}</title>
<meta property="og:type" content="website" /><meta property="og:site_name" content="Infinite Tapestry" />
<meta property="og:title" content="${title}" /><meta property="og:description" content="${desc}" />
<meta property="og:image" content="${img}" /><meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:image" content="${img}" /><meta name="twitter:title" content="${title}" />
<meta http-equiv="refresh" content="0; url=${target}" /><link rel="icon" href="/brand/mark.svg" type="image/svg+xml" />
<style>body{background:#050505;color:#888;font:13px Inter,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}a{color:#ddd}</style>
</head><body><a href="${target}">Open the tapestry</a><script>location.replace(${JSON.stringify(target)})</script></body></html>`);
}

module.exports = async (req, res) => {
  if (req.query.m) return moment(req, res);
  const id = parseInt(req.query.id, 10) || 0;
  let idea = null;
  try {
    const r = await rest("GET", `ideas?id=eq.${id}&status=in.(pending,playing,played)&select=id,handle,body,status,start_strip,end_strip`);
    idea = r[0] || null;
  } catch (_) {}
  const host = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  if (!idea) { res.setHeader("location", "/"); return res.status(302).end(); }
  const landed = idea.start_strip != null;
  const target = landed ? `/?at=${idea.start_strip}&to=${idea.end_strip ?? idea.start_strip + 12}` : `/u/${encodeURIComponent(idea.handle)}`;
  const body = String(idea.body || "").replace(/\s+/g, " ").trim();
  const title = body.length > 70 ? body.slice(0, 68) + "…" : body;
  const desc = OWNER(idea.handle) ? "Infinite Tapestry" : `by @${idea.handle} · Infinite Tapestry`;
  const img = landed ? `${host}/api/og?card=idea&id=${idea.id}` : `${host}/brand/og/og-3-close.jpg`;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=600");
  res.status(200).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<title>${esc(title)} · Infinite Tapestry</title>
<meta name="description" content="${esc(desc)}" />
<meta property="og:type" content="website" /><meta property="og:site_name" content="Infinite Tapestry" />
<meta property="og:title" content="${esc(title)}" /><meta property="og:description" content="${esc(desc)}" />
<meta property="og:image" content="${esc(img)}" /><meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />
<meta property="og:url" content="${esc(host + "/s/" + idea.id)}" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" /><meta name="twitter:image" content="${esc(img)}" />
<meta http-equiv="refresh" content="0; url=${esc(target)}" />
<link rel="icon" href="/brand/mark.svg" type="image/svg+xml" />
<style>body{background:#050505;color:#888;font:13px Inter,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}a{color:#ddd}</style>
</head><body><a href="${esc(target)}">Open the tapestry</a><script>location.replace(${JSON.stringify(target)})</script></body></html>`);
};
