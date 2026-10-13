const crypto = require("crypto");
const { env, reconcile } = require("../lib/common");

// Called every 5 minutes by Supabase pg_cron (pg_net). Fuel never stops the pod; only the RunPod credit guard ($0.50) or desired=off does.
module.exports = async (req, res) => {
  const given = String(req.headers["x-controller-secret"] || "");
  const want = env("CONTROLLER_SECRET", "");
  if (!want || given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return res.status(401).json({ error: "unauthorized" });
  try { res.status(200).json(await reconcile("cron")); }
  catch (e) { res.status(500).json({ error: e.message }); }
};
