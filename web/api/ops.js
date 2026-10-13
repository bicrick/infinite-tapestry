// POST /api/ops  {sid, events:[{type, at, ms, d}]}  -> anonymous, sampled viewer reliability events (ops_events).
// No PII: sid is a random per-tab id; detail is a fixed whitelist of short enums/numbers. Rate-limited per network.
const { rest, ipHash } = require("../lib/common");

const TYPES = new Set(["disconnect", "reconnect", "away_from_live", "reload", "replay"]);
const DETAIL = { reason: /^[a-z_]{1,24}$/, build: /^[a-z0-9-]{1,24}$/, code: /^\d{1,4}$/, pod: /^(running|down|unknown)$/, hidden: /^(0|1)$/ };
const hits = new Map();   // per instance; cheap first line of defence
const WINDOW = 600e3, MAX = 40;

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  try {
    const now = Date.now(), k = ipHash(req), h = (hits.get(k) || []).filter((t) => now - t < WINDOW);
    if (h.length >= MAX) return res.status(429).end();
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const sid = /^[a-z0-9]{8,24}$/.test(String(body.sid || "")) ? body.sid : null;
    const rows = [];
    for (const e of (Array.isArray(body.events) ? body.events : []).slice(0, 10)) {
      if (!e || !TYPES.has(e.type)) continue;
      const at = Number(e.at), ms = e.ms == null ? null : Math.round(Number(e.ms));
      if (!(at > now - 36e5 && at < now + 6e4)) continue;
      const detail = {};
      for (const [key, re] of Object.entries(DETAIL)) if (e.d && e.d[key] != null && re.test(String(e.d[key]))) detail[key] = String(e.d[key]);
      rows.push({ source: "viewer", type: e.type, started_at: new Date(at).toISOString(),
        duration_ms: Number.isFinite(ms) ? Math.max(0, Math.min(ms, 864e5)) : null, detail, sid });
    }
    if (!rows.length) return res.status(204).end();
    h.push(...rows.map(() => now)); hits.set(k, h);
    if (hits.size > 5000) hits.clear();
    await rest("POST", "ops_events", rows, { prefer: "return=minimal" });
    res.status(204).end();
  } catch (e) { res.status(204).end(); }
};
