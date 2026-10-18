const { env, storagePrefixes } = require("../lib/common");
const { r2Get } = require("../lib/r2");

// Latest rolling canvas for the "asleep" backdrop. Cached at the edge for a minute.
// Try env prefix, then live-sdxl (4090), then legacy live (SD1.5) — first hit wins.
module.exports = async (req, res) => {
  const base = env("SUPABASE_URL").replace(/\/$/, "");
  const headers = { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY") };
  for (const prefix of storagePrefixes()) {
    const b = await r2Get(`${prefix}/canvas.png`);   // the pod writes canvas.png to R2 only
    if (b) {
      res.setHeader("content-type", "image/png");
      res.setHeader("cache-control", "public, s-maxage=60, max-age=60");
      return res.status(200).send(b);
    }
  }
  for (const prefix of storagePrefixes()) {   // old copy (read-only) until Supabase Storage is cleaned up
    const r = await fetch(`${base}/storage/v1/object/tapestry/${prefix}/canvas.png`, { headers }).catch(() => null);
    if (r && r.ok) {
      res.setHeader("content-type", "image/png");
      res.setHeader("cache-control", "public, s-maxage=60, max-age=60");
      return res.status(200).send(Buffer.from(await r.arrayBuffer()));
    }
  }
  return res.status(404).end();
};
