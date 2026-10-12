const { rest, userFromToken } = require("../lib/common");

// Public profile: a handle's suggestions with where each one landed.
// Rejected/withdrawn ideas are only listed for their owner (bearer token), never publicly.
const STATUS = { pending: "pending", playing: "weaving", played: "woven", rejected: "rejected", withdrawn: "withdrawn" };

module.exports = async (req, res) => {
  const handle = String(req.query.handle || "").trim();
  if (!/^[A-Za-z0-9_]{2,20}$/.test(handle)) return res.status(400).json({ error: "bad_handle" });
  try {
    const prof = await rest("GET", `profiles?handle=ilike.${encodeURIComponent(handle)}&select=id,handle,created_at`);
    if (!prof.length) return res.status(404).json({ error: "not_found" });
    const p = prof[0];
    const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const me = tok ? await userFromToken(tok).catch(() => null) : null;
    const own = !!(me && me.id === p.id);
    const statuses = own ? "pending,playing,played,rejected,withdrawn" : "pending,playing,played";
    const rows = await rest("GET", `ideas?user_id=eq.${p.id}&status=in.(${statuses})&order=created_at.desc&limit=200` +
      `&select=id,body,status,votes,boost_cents,created_at,played_at,start_strip,end_strip,image_path,plan`);
    // "played" means the director has taken it; it's only woven once it has a place on the canvas.
    // Ideas from before landings were tracked (old canvas) count as woven after an hour.
    const statusOf = (r) => {
      if (r.status === "played" && r.start_strip == null && Date.now() - new Date(r.played_at || r.created_at).getTime() < 3600e3) return "upnext";
      if (r.status === "played" && r.start_strip != null && r.end_strip == null) return "weaving";
      return STATUS[r.status] || r.status;
    };
    const ideas = rows.map((r) => ({
      id: r.id, body: r.body, status: statusOf(r), votes: r.votes, boosted: r.boost_cents > 0,
      created_at: r.created_at, played_at: r.played_at, start_strip: r.start_strip, end_strip: r.end_strip,
      image_path: r.image_path, title: (r.plan && Array.isArray(r.plan.titles) && r.plan.titles.length) ? r.plan.titles[r.plan.titles.length - 1] : null,
    }));
    const [don, ban] = await Promise.all([
      rest("GET", `donations?user_id=eq.${p.id}&select=amount_cents`).catch(() => []),
      rest("GET", `donor_banners?user_id=eq.${p.id}&hidden=eq.false&select=tagline,url`).catch(() => []),
    ]);
    const donated = don.reduce((a, d) => a + (d.amount_cents || 0), 0);
    res.setHeader("cache-control", own ? "private, no-store" : "public, s-maxage=20, stale-while-revalidate=60");
    res.status(200).json({
      handle: p.handle, joined: p.created_at, own,
      donor: donated > 0, donated_cents: own ? donated : undefined, banner: donated > 0 ? (ban[0] || null) : null,
      stats: { total: ideas.length, woven: ideas.filter((i) => i.status === "woven").length, votes: ideas.reduce((a, i) => a + (i.votes || 0), 0) },
      ideas,
    });
  } catch (e) {
    console.error("profile", e.message);
    res.status(500).json({ error: "server" });
  }
};
