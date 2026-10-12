// Admin-only moderation for guest ideas: recent submissions, one-click bans, shadow-mute,
// and the sign-in-only kill switch. Auth: Supabase bearer token of a profile with is_admin.
const { rest, userFromToken, audit } = require("../lib/common");
const LIMIT_KEYS = ["guests_enabled", "guest_per_10min", "guest_max_pending", "ip_per_10min", "ip_max_pending", "brake_pending", "turnstile_required", "shadow_after_strikes", "per_minute", "max_pending"];

module.exports = async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const me = tok ? await userFromToken(tok).catch(() => null) : null;
  if (!me || !me.is_admin) return res.status(403).json({ error: "admin_only" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const a = body.action || "recent";
  try {
    if (a === "recent") {
      const [ideas, shadow, sessions, bans, limits] = await Promise.all([
        rest("GET", "ideas?guest_id=not.is.null&order=created_at.desc&limit=60&select=id,handle,body,status,created_at,guest_id,ip_hash,fp_hash"),
        rest("GET", "shadow_ideas?order=created_at.desc&limit=30&select=id,handle,body,reason,created_at,guest_id,ip_hash,fp_hash"),
        rest("GET", "guest_sessions?order=last_seen.desc&limit=60&select=id,handle,strikes,shadow,banned,ip_hash,fp_hash,last_seen"),
        rest("GET", "guest_bans?order=created_at.desc&limit=100"),
        rest("GET", "idea_limits?id=eq.1"),
      ]);
      return res.status(200).json({ ideas, shadow, sessions, bans, limits: limits[0] });
    }
    if (a === "ban") {   // {kind: session|ip|fp, value}
      if (!["session", "ip", "fp"].includes(body.kind) || !body.value) return res.status(400).json({ error: "bad" });
      await rest("POST", "guest_bans", { kind: body.kind, value: String(body.value), reason: body.reason || "admin" }, { prefer: "resolution=ignore-duplicates,return=minimal" });
      if (body.kind === "session") await rest("PATCH", `guest_sessions?id=eq.${encodeURIComponent(body.value)}`, { banned: true }, { prefer: "return=minimal" });
      // drop their waiting ideas
      const col = body.kind === "session" ? "guest_id" : body.kind === "ip" ? "ip_hash" : "fp_hash";
      await rest("PATCH", `ideas?${col}=eq.${encodeURIComponent(body.value)}&status=eq.pending`, { status: "rejected" }, { prefer: "return=minimal" });
      await audit("admin_ban", { actor: me.id, target: body.kind + ":" + body.value });
      return res.status(200).json({ ok: true });
    }
    if (a === "unban") {
      await rest("DELETE", `guest_bans?kind=eq.${encodeURIComponent(body.kind)}&value=eq.${encodeURIComponent(body.value)}`, undefined, { prefer: "return=minimal" });
      if (body.kind === "session") await rest("PATCH", `guest_sessions?id=eq.${encodeURIComponent(body.value)}`, { banned: false }, { prefer: "return=minimal" });
      await audit("admin_unban", { actor: me.id, target: body.kind + ":" + body.value });
      return res.status(200).json({ ok: true });
    }
    if (a === "shadow") {   // {session, on}
      await rest("PATCH", `guest_sessions?id=eq.${encodeURIComponent(body.session)}`, { shadow: !!body.on }, { prefer: "return=minimal" });
      if (body.on) await rest("PATCH", `ideas?guest_id=eq.${encodeURIComponent(body.session)}&status=eq.pending`, { status: "rejected" }, { prefer: "return=minimal" });
      await audit("admin_shadow", { actor: me.id, target: body.session, detail: { on: !!body.on } });
      return res.status(200).json({ ok: true });
    }
    if (a === "limits") {   // {limits: {...}}  e.g. {guests_enabled:false} = sign-in only
      const patch = {}; for (const k of LIMIT_KEYS) if (body.limits && k in body.limits) patch[k] = body.limits[k];
      await rest("PATCH", "idea_limits?id=eq.1", patch, { prefer: "return=minimal" });
      await audit("admin_limits", { actor: me.id, detail: patch });
      return res.status(200).json({ ok: true });
    }
    res.status(400).json({ error: "unknown_action" });
  } catch (e) { console.error("admin", e.message); res.status(500).json({ error: "server" }); }
};
