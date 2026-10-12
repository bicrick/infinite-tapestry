const crypto = require("crypto");
const { env, reconcile } = require("../lib/common");

// Called every 5 minutes by Supabase pg_cron (pg_net). Sleeps the pod at zero fuel; wakes it when fuel returns.
module.exports = async (req, res) => {
  const given = String(req.headers["x-controller-secret"] || "");
  const want = env("CONTROLLER_SECRET", "");
  if (!want || given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return res.status(401).json({ error: "unauthorized" });
  try { res.status(200).json(await reconcile("cron")); }
  catch (e) { res.status(500).json({ error: e.message }); }
};
