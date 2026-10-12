const { env, storagePrefixes } = require("../lib/common");

// Latest rolling canvas for the "asleep" backdrop. Cached at the edge for a minute.
// Try env prefix, then live-sdxl (4090), then legacy live (SD1.5) — first hit wins.
module.exports = async (req, res) => {
  const base = env("SUPABASE_URL").replace(/\/$/, "");
  const headers = { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY") };
  for (const prefix of storagePrefixes()) {
    const r = await fetch(`${base}/storage/v1/object/tapestry/${prefix}/canvas.png`, { headers }).catch(() => null);
    if (r && r.ok) {
      res.setHeader("content-type", "image/png");
      res.setHeader("cache-control", "public, s-maxage=60, max-age=60");
      return res.status(200).send(Buffer.from(await r.arrayBuffer()));
    }
  }
  return res.status(404).end();
};
