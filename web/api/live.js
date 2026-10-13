// GET /api/live            -> pod-independent bootstrap: strip config + the most recent strip refs (Supabase `strips`).
// GET /api/live?start=a&end=b -> refs for a range (history fallback while the pod's WebSocket is down).
// Lets the page load, browse and replay history from R2 even when the GPU pod is down.
const { env, rest } = require("../lib/common");

const SESSION = () => env("TAPESTRY_STORAGE_PREFIX", "live-sdxl");
const CDN = () => env("R2_PUBLIC_URL", "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev").replace(/\/$/, "");
const ref = (r) => {
  const sc = r.scene || {};
  return { i: r.idx, o: r.overlap, s: [sc.title || "", sc.by || "", sc.style || "", sc.origin || ""] };
};

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const sel = "select=idx,overlap,width,height,created_at,scene";
    const base = `strips?session=eq.${encodeURIComponent(SESSION())}&${sel}`;
    if (q.start !== undefined) {
      const a = Math.max(0, parseInt(q.start, 10) || 0), b = Math.min(a + 63, Math.max(a, parseInt(q.end, 10) || a));
      const rows = await rest("GET", `${base}&idx=gte.${a}&idx=lte.${b}&order=idx.asc`);
      res.setHeader("cache-control", "public, max-age=60, s-maxage=86400");   // history never changes
      return res.status(200).json({ items: rows.map(ref) });
    }
    const n = Math.min(400, Math.max(1, parseInt(q.n, 10) || 240));
    const [rows, ps] = await Promise.all([rest("GET", `${base}&order=idx.desc&limit=${n}`),
      rest("GET", "pod_state?id=eq.1&select=status,desired,pod_id").catch(() => [])]);
    rows.reverse();
    const last = rows[rows.length - 1];
    const ov = last ? last.overlap : 192, w = last ? last.width - ov : 256;
    res.setHeader("cache-control", "public, max-age=3, s-maxage=5, stale-while-revalidate=30");
    res.status(200).json({
      config: { height: last ? last.height : 1024, strip_width: w, overlap: ov, scroll_speed: 60, scroll_speed_min: 16,
        buffer_target: 3, buffer_min: 2, strip_ext: "webp", strip_mime: "image/webp",
        strip_base: `${CDN()}/${SESSION()}/strips/`, lod_base: `${CDN()}/${SESSION()}/lod/` },
      max: last ? last.idx : -1,
      last_at: last ? Date.parse(last.created_at) / 1000 : null,
      now: Date.now() / 1000,
      pod: ps[0] ? { status: ps[0].status, desired: ps[0].desired, ws: ps[0].pod_id ? `wss://${ps[0].pod_id}-8000.proxy.runpod.net/ws` : null } : null,
      items: rows.map(ref),
    });
  } catch (e) { res.status(500).json({ error: "server" }); }
};
