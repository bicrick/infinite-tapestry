// GET/POST /api/guest → { handle, guestsEnabled, turnstile } for visitors who aren't signed in.
const { guestSession } = require("../lib/guest");
const { rest } = require("../lib/common");
module.exports = async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const g = await guestSession(req, res, body.fp || req.query.fp);
    const [lims, gs] = await Promise.all([rest("GET", "idea_limits?id=eq.1&select=guests_enabled,turnstile_required"),
      rest("GET", `guest_sessions?id=eq.${g.id}&select=human_ok`).catch(() => null)]);
    const lim = lims[0] || {};
    res.status(200).json({ handle: g.handle, banned: !!g.banned, guestsEnabled: lim.guests_enabled !== false,
      human: !!(gs && gs[0] && gs[0].human_ok), turnstile: !!(lim.turnstile_required && process.env.TURNSTILE_SECRET_KEY && process.env.TURNSTILE_SITE_KEY) });
  } catch (e) { console.error("guest", e.message); res.status(500).json({ error: "server" }); }
};
