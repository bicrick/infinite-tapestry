// POST /api/account { action: "delete", confirm: "DELETE" } with the user's bearer token.
// Deletes the signed-in account: pending ideas withdrawn, painted ideas kept on the canvas but anonymised,
// chat hidden, then the auth user is deleted (profile, votes, chat, banner cascade). Service role only, server-side.
const { env, rest, userFromToken, audit, ipHash } = require("../lib/common");

module.exports = async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  try {
    const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const me = tok && tok.length < 4096 ? await userFromToken(tok).catch(() => null) : null;
    if (!me) return res.status(401).json({ error: "signin_required" });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (body.action !== "delete" || body.confirm !== "DELETE") return res.status(400).json({ error: "confirm_required" });
    const id = me.id;
    if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: "bad_user" });
    // A ban survives deletion on this network (IP), so deleting can't be used to shake one off.
    const bans = await rest("GET", `sanctions?user_id=eq.${id}&kind=eq.ban&or=(until.is.null,until.gt.now())&select=id`).catch(() => []);
    if (bans.length) await rest("POST", "sanctions", { user_id: null, ip_hash: ipHash(req), kind: "ban", until: null, reason: "ban carried over from a deleted account" }, { prefer: "return=minimal" }).catch(() => {});
    await rest("PATCH", `ideas?user_id=eq.${id}&status=eq.pending`, { status: "withdrawn" }, { prefer: "return=minimal" });
    await rest("PATCH", `ideas?user_id=eq.${id}&status=neq.pending`, { user_id: null, handle: "viewer" }, { prefer: "return=minimal" });
    await rest("PATCH", `chat_messages?user_id=eq.${id}`, { hidden: true }, { prefer: "return=minimal" });
    await rest("PATCH", `chat_messages?actor_user=eq.${id}`, { hidden: true }, { prefer: "return=minimal" }).catch(() => {});
    const SB = env("SUPABASE_URL").replace(/\/$/, ""), key = env("SUPABASE_SERVICE_ROLE_KEY");
    const r = await fetch(`${SB}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: key, authorization: "Bearer " + key } });
    if (!r.ok) { console.error("account delete auth", r.status); return res.status(502).json({ error: "delete_failed" }); }
    await audit("account_deleted", { target: id, detail: { had_handle: !!me.handle } });
    res.status(200).json({ ok: true });
  } catch (e) { console.error("account", e.message); res.status(500).json({ error: "server" }); }
};
