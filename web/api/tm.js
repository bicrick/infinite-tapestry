// Time Machine v3 jobs + tiles. Everything runs on Vercel with the env it already has (no new secrets).
//   /api/tm?job=index|tiles|all   Vercel cron (every 5 min): fold new strips into the index, then extend the tile
//                                pyramid. Resumable + idempotent + time-boxed; safe to re-run or overlap (lock).
//   /api/tm?tile=L/T[&u=N]       pyramid tile (R2, old tiles Supabase -> CDN; immutable, the tip tile carries ?u=units)
//   /api/tm?manifest=1           pyramid manifest
const { runIndex, getJSON } = require("../lib/tmbuild");
const { runTiles, key, tileObj } = require("../lib/tmtiles");
const SB = () => process.env.SUPABASE_URL.replace(/\/$/, "");
const svc = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY });

module.exports = async (req, res) => {
  const q = new URL(req.url, "http://x").searchParams;
  try {
    const tile = q.get("tile");
    if (tile) {
      const m = /^([1-7])\/(\d{1,6})$/.exec(tile); if (!m) return res.status(400).end();
      const buf = await tileObj(key(+m[1], +m[2]));   // R2 first, then old Supabase tiles
      if (!buf) { res.setHeader("cache-control", "public, s-maxage=30"); return res.status(404).end(); }
      res.setHeader("content-type", "image/webp"); res.setHeader("access-control-allow-origin", "*");
      res.setHeader("cache-control", "public, max-age=31536000, s-maxage=31536000, immutable");
      return res.status(200).send(buf);
    }
    if (q.get("manifest")) {
      const m = await getJSON("tm/lod2/manifest.json"); if (!m) return res.status(404).json({});
      delete m.lock; res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=300");
      return res.status(200).json(m);
    }
    const job = q.get("job");
    if (job) {
      // Cron only (Vercel sends this UA); jobs are idempotent, so a spoofed call can't do harm beyond CPU time.
      if (!/vercel-cron/i.test(req.headers["user-agent"] || "")) return res.status(403).json({ error: "cron only" });
      const out = {};
      if (job === "index" || job === "all") out.index = await runIndex();
      if (job === "tiles" || job === "all") out.tiles = await runTiles({ budgetMs: job === "all" ? 38000 : 45000 });
      console.log("tm job", JSON.stringify(out));
      return res.status(200).json(out);
    }
    return res.status(400).json({ error: "tile|manifest|job" });
  } catch (e) { console.error("tm", e); return res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
};
