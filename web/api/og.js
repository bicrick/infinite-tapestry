const { env, rest, POD, storagePrefixes } = require("../lib/common");

// Raw crops (no `card`): a crop of the tapestry where an idea landed (profile thumbnails etc).
// Designed cards (`card=`): 1200x630 link previews over real tapestry crops (see lib/card.js):
//   card=home            rotating variant from the recent live tapestry, cached ~10 min
//   card=idea&id=N       the spot an idea landed, “idea” by @handle
//   card=at&a=&b=        an exact spot (/?at= share links), credited if an idea painted it
//   card=user&handle=h   that person's latest woven idea
// Any failure falls back to the pre-rendered static variants in /brand/og/.
const STATIC = ["og-1-lanterns", "og-2-band", "og-3-close", "og-4-live", "og-5-fields"];
const sbHeaders = () => ({ apikey: env("SUPABASE_SERVICE_ROLE_KEY"), authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY") });

async function getCrop(a, b, w, h, ms = 9000) {
  const key = `crops/${a}-${b}-${w}x${h}.jpg`;
  for (const pre of storagePrefixes()) {
    const r = await fetch(`${env("SUPABASE_URL").replace(/\/$/, "")}/storage/v1/object/tapestry/${pre}/${key}`, { headers: sbHeaders() }).catch(() => null);
    if (r && r.ok) return Buffer.from(await r.arrayBuffer());
  }
  if (!POD()) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  const r = await fetch(`https://${POD()}-8000.proxy.runpod.net/crop/${a}/${b}.jpg?w=${w}&h=${h}`, { signal: ctl.signal }).catch(() => null);
  clearTimeout(t);
  return r && r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}
// A 1.9:1 card shows ~7 strips: take them where the new scene has settled (40% into the landing).
function settle(a, b) {
  if (!Number.isFinite(b) || b < a) b = a + 12;
  if (b - a > 7) { const mid = Math.round(a + (b - a) * 0.4); a = Math.max(a, mid - 4); b = a + 7; }
  return [a, b];
}
async function health() {
  if (!POD()) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
  const r = await fetch(`https://${POD()}-8000.proxy.runpod.net/health`, { signal: ctl.signal }).catch(() => null);
  clearTimeout(t);
  return r && r.ok ? r.json().catch(() => null) : null;
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

async function card(req, res) {
  const { render, toDataUrl } = require("../lib/card");
  const host = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  const bucket = Math.floor(Date.now() / 600000);
  const fallback = () => { res.setHeader("cache-control", "public, s-maxage=600, max-age=600"); res.redirect(302, `${host}/brand/og/${STATIC[bucket % STATIC.length]}.jpg`); };
  const send = (buf, long) => {
    res.setHeader("content-type", "image/png");
    res.setHeader("cache-control", long ? "public, s-maxage=604800, max-age=86400" : "public, s-maxage=600, max-age=600, stale-while-revalidate=3600");
    res.status(200).send(buf);
  };
  const kind = String(req.query.card);
  try {
    let idea = null, a, b, final = false;
    if (kind === "idea" || kind === "user") {
      const q = kind === "idea" ? `id=eq.${parseInt(req.query.id, 10) || 0}`
        : `handle=ilike.${encodeURIComponent(String(req.query.handle || "").replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, ""))}&order=start_strip.desc&limit=1`;
      idea = (await rest("GET", `ideas?${q}&status=in.(playing,played)&start_strip=not.is.null&select=handle,body,start_strip,end_strip`))[0] || null;
      if (!idea) return fallback();
      [a, b] = settle(idea.start_strip, idea.end_strip ?? idea.start_strip + 12); final = idea.end_strip != null && kind === "idea";
    } else if (kind === "at") {
      a = parseInt(req.query.a, 10); b = parseInt(req.query.b, 10);
      if (!(a >= 0)) return fallback();
      idea = (await rest("GET", `ideas?status=in.(playing,played)&start_strip=lte.${a + 3}&order=start_strip.desc&limit=1&select=handle,body,start_strip,end_strip,status`).catch(() => []))[0] || null;
      if (idea && !(idea.end_strip != null ? a <= idea.end_strip : idea.status === "playing" && a <= idea.start_strip + 16)) idea = null;   // credit only the idea that painted this exact spot
      [a, b] = settle(a, Number.isFinite(b) ? b : a + 7); final = true;
    }
    if (idea || kind === "at") {
      const img = await getCrop(a, b, 1200, 630);
      if (!img) return fallback();
      const o = idea ? { v: "by", img: toDataUrl(img), line: clip(idea.body, 90), by: idea.handle }
                     : { v: "full", img: toDataUrl(img), line: "A moment from the Infinite Tapestry.", sub: "You choose where it goes." };
      return send(await render(o), final);
    }
    // home: rotate designs every 10 minutes, painted from the last few minutes of the live tapestry
    const [hz, last] = await Promise.all([health(), rest("GET", "strips?order=created_at.desc&limit=1&select=idx").catch(() => [])]);
    const max = (last[0] && last[0].idx) || (hz && hz.strip_index);
    if (!max) return fallback();
    const viewers = (hz && hz.viewers) || 0;
    const V = [
      { v: "live", line: "You choose where it goes.", sub: "An endless painting, live." },
      { v: "band", line: "You choose where it goes." },
      { v: "close", line: "You choose where it goes.", sub: "An endless painting. Suggest what comes next." },
      { v: "full", line: "You choose where it goes.", sub: "An endless painting, live." },
    ][bucket % 4];
    const img = V.v === "band" ? await getCrop(max - 48, max - 8, 1600, 314) : await getCrop(max - 15, max - 8, 1200, 630);
    if (!img) return fallback();
    return send(await render({ ...V, img: toDataUrl(img), band: V.v === "band" ? toDataUrl(img) : undefined, viewers }), false);
  } catch (e) { console.error("og card", e.message); return fallback(); }
}

module.exports = async (req, res) => {
  if (req.query.card) return card(req, res);
  const thumb = req.query.size === "thumb";
  const [w, h] = thumb ? [600, 315] : [1200, 630];
  let a = parseInt(req.query.a, 10), b = parseInt(req.query.b, 10);
  let rangeFinal = Number.isFinite(a) && Number.isFinite(b);
  try {
    if (req.query.id) {
      const r = await rest("GET", `ideas?id=eq.${parseInt(req.query.id, 10) || 0}&status=in.(playing,played)&select=start_strip,end_strip`);
      if (r.length) { a = r[0].start_strip; rangeFinal = r[0].end_strip != null; b = r[0].end_strip ?? r[0].start_strip + 12; }
    }
  } catch (_) {}
  if (Number.isFinite(a) && a >= 0) {
    [a, b] = settle(a, b);
    const buf = await getCrop(a, b, w, h);
    if (buf) {
      res.setHeader("content-type", "image/jpeg");
      res.setHeader("cache-control", rangeFinal ? "public, s-maxage=31536000, max-age=86400, immutable" : "public, s-maxage=60, max-age=60");
      return res.status(200).send(buf);
    }
  }
  const host = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  res.setHeader("cache-control", "public, s-maxage=60");
  res.redirect(302, `${host}/brand/og/${STATIC[0]}.jpg`);
};
