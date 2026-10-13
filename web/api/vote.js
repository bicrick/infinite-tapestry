// GET /api/vote?fp= → { ids } hearted by this guest; POST /api/vote { id, fp } → toggle a guest heart.
// Guests reach the DB only through here (service role); one heart per guest session/fingerprint per idea.
const { guestSession } = require("../lib/guest");
const { rest } = require("../lib/common");

module.exports = async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const g = await guestSession(req, res, body.fp || (req.query && req.query.fp));
    if (req.method === "GET") {
      const ids = await rest("POST", "rpc/guest_my_votes", { p_guest: g.id, p_fp: g.fp });
      return res.status(200).json({ ids: (ids || []).map((x) => (typeof x === "object" ? Object.values(x)[0] : x)).map(Number) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    if (g.banned) return res.status(403).json({ error: "not_allowed" });
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
    try {
      const out = await rest("POST", "rpc/guest_toggle_vote", { p_guest: g.id, p_ip: g.ip, p_fp: g.fp, p_idea: id });
      return res.status(200).json({ votes: out.votes, on: out.on });
    } catch (e) {
      const m = String(e.message).match(/(signin_required|rate_limited|not_allowed|not_votable|no_session)/);
      const code = !m ? 500 : m[1] === "signin_required" ? 401 : m[1] === "not_votable" ? 409 : m[1] === "not_allowed" ? 403 : 429;
      return res.status(code).json({ error: m ? m[1] : "server" });
    }
  } catch (e) { console.error("vote", e.message); res.status(500).json({ error: "server" }); }
};
