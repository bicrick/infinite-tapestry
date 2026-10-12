const { env, rest, POD } = require("../lib/common");

// A crop of the tapestry where an idea landed (share cards + profile thumbnails).
// Sections are immutable once woven, so this is cached at the edge for a long time.
// Source order: Supabase Storage (mirrored by the GPU server) -> live GPU server -> brand OG fallback.
module.exports = async (req, res) => {
  const thumb = req.query.size === "thumb";
  const [w, h] = thumb ? [600, 315] : [1200, 630];
  let a = parseInt(req.query.a, 10), b = parseInt(req.query.b, 10);
  try {
    if (req.query.id) {
      const r = await rest("GET", `ideas?id=eq.${parseInt(req.query.id, 10) || 0}&status=in.(playing,played)&select=start_strip,end_strip`);
      if (r.length) { a = r[0].start_strip; b = r[0].end_strip ?? r[0].start_strip + 12; }
    }
  } catch (_) {}
  const send = (buf, long) => {
    res.setHeader("content-type", "image/jpeg");
    res.setHeader("cache-control", long ? "public, s-maxage=31536000, max-age=86400, immutable" : "public, s-maxage=60, max-age=60");
    res.status(200).send(buf);
  };
  if (Number.isFinite(a) && a >= 0) {
    if (!Number.isFinite(b) || b < a) b = a + 12;
    // A 1.9:1 card shows ~8 strips: take them where the new scene has settled in (40% into the landing).
    if (b - a > 7) { const mid = Math.round(a + (b - a) * 0.4); a = Math.max(a, mid - 4); b = a + 7; }
    const key = `crops/${a}-${b}-${w}x${h}.jpg`;
    const prefixes = [...new Set([env("TAPESTRY_STORAGE_PREFIX", "live-sdxl"), "live-sdxl", "live"])];
    for (const pre of prefixes) {
      const r = await fetch(`${env("SUPABASE_URL").replace(/\/$/, "")}/storage/v1/object/tapestry/${pre}/${key}`, {
        headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY") },
      }).catch(() => null);
      if (r && r.ok) return send(Buffer.from(await r.arrayBuffer()), true);
    }
    if (POD()) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
      const r = await fetch(`https://${POD()}-8000.proxy.runpod.net/crop/${a}/${b}.jpg?w=${w}&h=${h}`, { signal: ctl.signal }).catch(() => null);
      clearTimeout(t);
      if (r && r.ok) return send(Buffer.from(await r.arrayBuffer()), true);
    }
  }
  const host = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  res.setHeader("cache-control", "public, s-maxage=60");
  res.redirect(302, `${host}/brand/og.jpg`);
};
