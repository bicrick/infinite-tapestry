// GET /api/live            -> pod-independent bootstrap: strip config + the most recent strip refs (Supabase `strips`).
// GET /api/live?start=a&end=b -> refs for a range (history fallback while the pod's WebSocket is down).
// Strip images come from the public R2 bucket (web/lib/stripcdn.js), so a quiet GPU pod still leaves the page able to load.
const { rest } = require("../lib/common");
const { stripBases, session } = require("../lib/stripcdn");

const ref = (r) => {
  const sc = r.scene || {};
  return { i: r.idx, o: r.overlap, s: [sc.title || "", sc.by || "", sc.style || "", sc.origin || ""] };
};

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const sel = "select=idx,overlap,width,height,created_at,scene";
    const base = `strips?session=eq.${encodeURIComponent(session())}&${sel}`;
    if (q.start !== undefined) {
      const a = Math.max(0, parseInt(q.start, 10) || 0), b = Math.min(a + 63, Math.max(a, parseInt(q.end, 10) || a));
      const rows = await rest("GET", `${base}&idx=gte.${a}&idx=lte.${b}&order=idx.asc`);
      res.setHeader("cache-control", "public, max-age=60, s-maxage=86400");   // history never changes
      return res.status(200).json({ items: rows.map(ref) });
    }
    const n = Math.min(400, Math.max(1, parseInt(q.n, 10) || 240));
    const [rows, ps, hb] = await Promise.all([rest("GET", `${base}&order=idx.desc&limit=${n}`),
      rest("GET", "pod_state?id=eq.1&select=status,desired,pod_id").catch(() => []),
      rest("GET", "ops_heartbeat?id=eq.pod&select=at").catch(() => [])]);
    rows.reverse();
    const last = rows[rows.length - 1];
    const ov = last ? last.overlap : 192, w = last ? last.width - ov : 256;
    const bases = stripBases();
    res.setHeader("cache-control", "public, max-age=3, s-maxage=5, stale-while-revalidate=30");
    res.status(200).json({
      config: { height: last ? last.height : 1024, strip_width: w, overlap: ov, scroll_speed: 60, scroll_speed_min: 16,
        buffer_target: 3, buffer_min: 2, strip_ext: "webp", strip_mime: "image/webp",
        strip_base: bases.strip_base, lod_base: bases.lod_base },
      max: last ? last.idx : -1,
      last_at: last ? Date.parse(last.created_at) / 1000 : null,
      // The pod's own 30 s heartbeat (ops_heartbeat): viewers judge "pod down" from this, not from the newest
      // mirrored strip row, which lags whenever uploads back up.
      heartbeat_at: hb && hb[0] && hb[0].at ? Date.parse(hb[0].at) / 1000 : null,
      now: Date.now() / 1000,
      pod: ps[0] ? { status: ps[0].status, desired: ps[0].desired, ws: ps[0].pod_id ? `wss://${ps[0].pod_id}-8000.proxy.runpod.net/ws` : null } : null,
      items: rows.map(ref),
    });
  } catch (e) { res.status(500).json({ error: "server" }); }
};
