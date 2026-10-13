// POST /api/report { idea_id? | a,b (strip range), reason } -> admin's Reports list. Anyone can report;
// per-IP limit 10/hour. Bearer token (optional) records the signed-in reporter.
const { rest, userFromToken, ipHash, readRaw } = require("../lib/common");
const REASONS = new Set(["sexual", "hateful", "violent", "spam", "other"]);

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = JSON.parse((await readRaw(req)) || "{}");
    const reason = REASONS.has(body.reason) ? body.reason : "other";
    const note = String(body.note || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 160);
    const idea = Number(body.idea_id) || null, a = Number.isInteger(body.a) ? body.a : null, b = Number.isInteger(body.b) ? body.b : null;
    if (!idea && a == null) return res.status(400).json({ error: "bad" });
    const ip = ipHash(req);
    const since = new Date(Date.now() - 3600e3).toISOString();
    const n = await rest("GET", `reports?ip_hash=eq.${ip}&created_at=gt.${since}&select=id`);
    if (n.length >= 10) return res.status(429).json({ error: "rate_limited" });
    if (idea && !(await rest("GET", `ideas?id=eq.${idea}&select=id`)).length) return res.status(404).json({ error: "not_found" });
    const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const me = tok ? await userFromToken(tok).catch(() => null) : null;
    await rest("POST", "reports", { idea_id: idea, strip_a: a, strip_b: b ?? a, reason: note ? `${reason}: ${note}` : reason, reporter_user: me ? me.id : null, ip_hash: ip },
      { prefer: "return=minimal" });
    res.status(200).json({ ok: true });
  } catch (e) { console.error("report", e.message); res.status(500).json({ error: "server" }); }
};
module.exports.config = { api: { bodyParser: false } };
