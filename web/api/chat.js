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
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const text = String(body.text || "").replace(/\s+/g, " ").trim();
    // Auth and moderation in parallel (was serial).
    const [me, flagged] = await Promise.all([tok && tok.length < 4096 ? userFromToken(tok).catch(() => null) : null, text && text.length <= 200 ? moderate(text) : ""]);
    if (!me) return res.status(401).json({ error: "signin_required" });
    if (!text || text.length > 200) return res.status(400).json({ error: "bad_length" });
    const since = new Date(Date.now() - 30e3).toISOString();   // idempotent double tap / retry
    const dup = await rest("GET", `chat_messages?user_id=eq.${me.id}&body=eq.${encodeURIComponent(text)}&created_at=gt.${since}&select=id,handle&limit=1`).catch(() => null);
    if (dup && dup[0]) return res.status(200).json({ ok: true, id: dup[0].id, handle: dup[0].handle, dup: true });
    const out = await rest("POST", "rpc/user_send_chat", { p_user: me.id, p_ip: ipHash(req), p_body: text, p_flagged: flagged });
    if (out && out.error) return res.status(out.error === "slow_mode" ? 429 : 422).json(out);
    res.status(200).json({ ok: true, id: out.id, handle: out.handle });
  } catch (e) { console.error("chat", e.message); res.status(500).json({ error: "server" }); }
};
