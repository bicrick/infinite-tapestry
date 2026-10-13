// POST /api/chat { text } with the user's bearer token. Signed-in only: guests read.
// Same moderation as ideas (moderate()), then user_send_chat enforces 200 chars, no links,
// mutes/bans, slow mode and the sitewide switch in SQL.
const { moderate } = require("../lib/moderate");
const { rest, userFromToken, ipHash } = require("../lib/common");

module.exports = async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  try {
    const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const me = tok && tok.length < 4096 ? await userFromToken(tok).catch(() => null) : null;
    if (!me) return res.status(401).json({ error: "signin_required" });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const text = String(body.text || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 200) return res.status(400).json({ error: "bad_length" });
    const flagged = await moderate(text);
    const out = await rest("POST", "rpc/user_send_chat", { p_user: me.id, p_ip: ipHash(req), p_body: text, p_flagged: flagged });
    if (out && out.error) return res.status(out.error === "slow_mode" ? 429 : 422).json(out);
    res.status(200).json({ ok: true, id: out.id, handle: out.handle });
  } catch (e) { console.error("chat", e.message); res.status(500).json({ error: "server" }); }
};
