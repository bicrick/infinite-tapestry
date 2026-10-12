// POST /api/idea { text, fp, turnstile? } — guest submissions (no sign-in) with moderation and
// layered limits enforced in the DB (guest_submit_idea). Signed-in users keep the direct RPC path.
const { guestSession } = require("../lib/guest");
const { moderate } = require("../lib/moderate");
const { rest, audit } = require("../lib/common");

async function turnstileOk(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ secret, response: String(token || "") }) });
    return !!(await r.json()).success;
  } catch (_) { return false; }
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (text.length < 2) return res.status(400).json({ error: "bad_length" });
    const g = await guestSession(req, res, body.fp);
    if (g.banned) return res.status(403).json({ error: "not_allowed" });
    const human = body.turnstile ? await turnstileOk(body.turnstile, g.ip) : false;
    const flagged = await moderate(text);
    let out;
    try {
      out = await rest("POST", "rpc/guest_submit_idea", { p_guest: g.id, p_ip: g.ip, p_fp: g.fp, p_body: text, p_flagged: flagged, p_human: human });
    } catch (e) {
      const m = String(e.message).match(/(signin_required|rate_limited|too_many_pending|not_allowed|human_check|bad_length|no_session)/);
      return res.status(m && m[1] === "signin_required" ? 401 : 429).json({ error: m ? m[1] : "server" });
    }
    if (out && out.error) return res.status(422).json({ error: out.error });
    // Shadow-muted submissions look exactly like normal ones to the sender.
    res.status(200).json({ ok: true, handle: out.handle });
  } catch (e) { console.error("idea", e.message); res.status(500).json({ error: "server" }); }
};
