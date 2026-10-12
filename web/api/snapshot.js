const { env } = require("../lib/common");

// Latest rolling canvas for the "asleep" backdrop. Cached at the edge for a minute.
module.exports = async (req, res) => {
  const prefix = env("TAPESTRY_STORAGE_PREFIX", "live");
  const r = await fetch(`${env("SUPABASE_URL").replace(/\/$/, "")}/storage/v1/object/tapestry/${prefix}/canvas.png`, {
    headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY") },
  });
  if (!r.ok) return res.status(404).end();
  res.setHeader("content-type", "image/png");
  res.setHeader("cache-control", "public, s-maxage=60, max-age=60");
  res.status(200).send(Buffer.from(await r.arrayBuffer()));
};
