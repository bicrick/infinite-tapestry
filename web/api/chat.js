// POST /api/chat { text, fp } — guest chat with the same moderation + guest limits as ideas.
// Signed-in users keep the send_chat RPC (same hard blocks in SQL).
const { guestSession } = require("../lib/guest");
const { moderate } = require("../lib/moderate");
const { rest } = require("../lib/common");

module.exports = async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 280);
    if (!text) return res.status(400).json({ error: "bad_length" });
    const g = await guestSession(req, res, body.fp);
    if (g.banned) return res.status(403).json({ error: "not_allowed" });
    const flagged = await moderate(text);
    let out;
    try {
      out = await rest("POST", "rpc/guest_send_chat", { p_guest: g.id, p_ip: g.ip, p_fp: g.fp, p_body: text, p_flagged: flagged });
    } catch (e) {
      const m = String(e.message).match(/(signin_required|rate_limited|not_allowed|bad_length|no_session)/);
      return res.status(m && m[1] === "signin_required" ? 401 : 429).json({ error: m ? m[1] : "server" });
    }
    if (out && out.error) return res.status(422).json({ error: out.error });
    res.status(200).json({ ok: true, id: out.id, handle: out.handle });
  } catch (e) { console.error("chat", e.message); res.status(500).json({ error: "server" }); }
};
