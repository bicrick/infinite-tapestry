// Time Machine v3 history index: precomputed, append-only summaries of the strips table so the history
// call never scans every row again. Shared by the writer (scripts/tm/build_index.js, GitHub Actions cron)
// and the reader (/api/about?kind=history, /api/tm).
//
// Layout (Supabase Storage bucket "tapestry", mirrored to R2 when R2_* creds are present):
//   tm/idx/state.json      { v, eras:[{id,session,label,g0,n,a,b,t0,t1}], last:{session:idx}, months:[...], updated }
//   tm/idx/YYYY-MM.json    { v, month, hours:[hour] }   (past months immutable, current month rewritten)
// hour = { h:"2026-10-14T05", era, a, b, t0, t1, times:[[idx,t]...idx%64==0], runs:[[title,a,b,origin,by]], n }
//   runs: scene runs inside the hour. Closed hours keep only the first/last run and highlight candidates
//   (titled, >=6 strips); n is the true run count. Every strip is one equal-width unit; global unit = era.g0 + idx.
const ERAS = [
  { id: "og", session: "live", label: "OG era · SD 1.5" },
  { id: "sdxl", session: "live-sdxl", label: "SDXL" },
];
const V = 1;
const hourKey = (t) => new Date(t).toISOString().slice(0, 13);

// Fold strip rows (ascending idx, one session) into the hour list (mutates, returns hours touched).
function fold(hours, era, rows) {
  const byH = new Map(hours.map((h) => [h.era + "|" + h.h, h]));
  const touched = new Set();
  for (const s of rows) {
    const k = hourKey(s.created_at);
    let h = byH.get(era + "|" + k);
    if (!h) { h = { h: k, era, a: s.idx, b: s.idx, t0: s.created_at, t1: s.created_at, times: [], runs: [], n: 0 }; hours.push(h); byH.set(era + "|" + k, h); }
    if (s.idx <= h.b && h.n) continue; // already folded
    h.b = s.idx; h.t1 = s.created_at;
    if (s.idx % 64 === 0) h.times.push([s.idx, s.created_at]);
    const sc = s.scene || {}, title = sc.title || null, last = h.runs[h.runs.length - 1];
    if (last && last[0] === title) last[2] = s.idx;
    else { h.runs.push([title, s.idx, s.idx, sc.origin || null, sc.by || null]); h.n++; }
    touched.add(h);
  }
  return touched;
}

// Drop short untitled runs from a closed hour (keeps first/last for cross-hour merges).
function compact(h) {
  h.runs = h.runs.filter((r, i, a) => i === 0 || i === a.length - 1 || (r[0] && r[2] - r[1] >= 5));
  h.closed = 1;
}

const OWNER = new Set(["bicrick"]);
const isOwner = (x) => OWNER.has(String(x || "").replace("@", "").toLowerCase());

// Same output shape as the original full-scan history() so the current Time Machine page is unchanged.
function historyFrom(hours, { tz, session, eraT0, ideas, reacts }) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const rx = new Map((reacts || []).map((r) => [r.strip, r.lol + r.fire + r.mind + r.love + r.dead]));
  const days = new Map();
  let run = null, edge = 0;
  hours.sort((x, y) => x.a - y.a);
  for (const h of hours) {
    const day = fmt.format(new Date(h.t0));
    let d = days.get(day);
    if (!d) days.set(day, d = { day, a: h.a, b: h.b, t0: h.t0, t1: h.t1, times: [], scenes: [], n: 0 });
    d.b = h.b; d.t1 = h.t1; d.times.push(...h.times); edge = h.b;
    h.runs.forEach((r, i) => {
      const [title, a, b, origin, by] = r;
      if (run && run.day === day && run.title === title) { run.b = b; if (i === 0) d.n--; } // run continues across the hour
      else { run = { day, title, a, b, origin, by, rx: 0 }; d.scenes.push(run); }
    });
    d.n += h.n;
  }
  // rx per run (reactions only touch recent strips; cheap)
  const runsAll = [...days.values()].flatMap((d) => d.scenes);
  if (rx.size) for (const r of runsAll) for (let k = r.a; k <= r.b; k++) r.rx += rx.get(k) || 0;
  for (const d of days.values()) {
    const picks = [];
    for (const i of ideas || []) {
      if (i.start_strip < d.a || i.start_strip > d.b || isOwner(i.handle)) continue;
      if (eraT0 && new Date(i.created_at) < new Date(eraT0)) continue; // pre-SDXL ranges point at a different timeline
      const end = i.end_strip || i.start_strip + 10;
      const r = d.scenes.filter((s) => s.b >= i.start_strip && s.a <= end).reduce((n, s) => n + s.rx, 0);
      picks.push({ a: i.start_strip, b: end, text: i.body.slice(0, 120), handle: i.handle, image: !!i.image_path, rx: r, kind: "idea" });
      (d.ideas = d.ideas || []).push({ id: i.id, a: i.start_strip, text: i.body.slice(0, 80), handle: isOwner(i.handle) ? null : i.handle });
    }
    const scenes = d.scenes.filter((s) => s.title && s.b - s.a >= 6 && !isOwner(s.by));
    scenes.sort((x, y) => y.rx - x.rx || (y.b - y.a) - (x.b - x.a));
    for (const s of scenes) {
      if (picks.length >= 6) break;
      if (picks.some((p) => s.a <= p.b && s.b >= p.a)) continue;
      picks.push({ a: s.a, b: s.b, text: s.title, handle: s.origin === "user" ? (s.by || "").replace("@", "") || null : null, rx: s.rx, kind: "scene" });
    }
    picks.sort((x, y) => (y.kind === "idea") - (x.kind === "idea") || y.rx - x.rx);
    d.highlights = picks.slice(0, 6).sort((x, y) => x.a - y.a);
    d.scene_count = d.n; delete d.scenes; delete d.n;
  }
  return { session, live_edge: edge, tz, days: [...days.values()].reverse() };
}

module.exports = { ERAS, V, hourKey, fold, compact, historyFrom, isOwner };
