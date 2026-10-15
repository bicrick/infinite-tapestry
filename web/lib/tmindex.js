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
const V = 2;
const GAP_MS = 10 * 60e3;
const hourKey = (t) => new Date(t).toISOString().slice(0, 13);

// Fold strip rows (ascending idx, one session) into the hour list (mutates, returns hours touched).
function fold(hours, era, rows) {
  const byH = new Map(hours.map((h) => [h.era + "|" + h.h, h]));
  const touched = new Set();
  let prev = hours.filter((h) => h.era === era).reduce((m, h) => (!m || h.b > m.b ? h : m), null);
  let prevT = prev ? +new Date(prev.t1) : null;
  for (const s of rows) {
    const k = hourKey(s.created_at);
    let h = byH.get(era + "|" + k);
    if (!h) { h = { h: k, era, a: s.idx, b: s.idx, t0: s.created_at, t1: s.created_at, times: [], runs: [], n: 0 }; hours.push(h); byH.set(era + "|" + k, h); }
    if (s.idx <= h.b && h.n) continue; // already folded
    const t = +new Date(s.created_at);
    if (prevT && t - prevT >= GAP_MS) (h.gaps = h.gaps || []).push([s.idx, new Date(prevT).toISOString(), s.created_at]); // downtime notch
    prevT = t;
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

// ---------- Time Machine v3 landmarks (global units: era.g0 + idx) ----------
// Titles only: user ideas are labelled with the scene title they became, credited "Someone"; never a handle.
const RELEASES = [["v1.0", "2026-10-14T06:02:34Z"], ["v1.1", "2026-10-14T08:01:48Z"]];
const MILESTONES = [1000, 5000, 10000, 25000, 50000, 75000, 100000, 150000, 200000, 250000, 500000, 750000, 1e6, 2e6, 5e6];
function landmarks(state, hours, { ideas = [], reacts = [] } = {}) {
  const g0 = Object.fromEntries(state.eras.map((e) => [e.id, e.g0]));
  const H = hours.map((h) => ({ ...h, ga: g0[h.era] + h.a, gb: g0[h.era] + h.b, t0m: +new Date(h.t0), t1m: +new Date(h.t1) })).sort((a, b) => a.ga - b.ga);
  const total = state.eras.reduce((n, e) => Math.max(n, e.g0 + (e.n || 0)), 0);
  const out = [];
  const atTime = (ms) => { let best = null; for (const h of H) if (h.t0m <= ms) best = h; if (!best) return null; return Math.round(best.ga + Math.min(1, (ms - best.t0m) / Math.max(1, best.t1m - best.t0m)) * (best.gb - best.ga)); };
  const sd = state.eras.find((e) => e.id === "sdxl");
  const titleAt = (g) => { for (const h of H) if (g >= h.ga && g <= h.gb) { const r = h.runs.find((r) => g0[h.era] + r[1] <= g && g <= g0[h.era] + r[2]); return r && r[0]; } return null; };
  for (const e of state.eras) if (e.n) out.push({ k: "era", g: e.g0, label: e.label, p: 6 });
  for (const [v, t] of RELEASES) { const g = atTime(Date.parse(t)); if (g != null) out.push({ k: "release", g, label: "Release " + v, p: 5 }); }
  for (const m of MILESTONES) if (m <= total) out.push({ k: "milestone", g: m - 1, label: m.toLocaleString("en-US") + " strips", p: 4 });
  const full = H.filter((h) => h.t1m - h.t0m > 50 * 60e3);
  for (const h of full.slice().sort((a, b) => (b.gb - b.ga) - (a.gb - a.ga)).slice(0, 3)) out.push({ k: "busiest", g: Math.round((h.ga + h.gb) / 2), label: `Busiest hour · ${(h.gb - h.ga + 1).toLocaleString("en-US")} strips`, p: 2 });
  for (const h of H) for (const [idx, a, b] of h.gaps || []) { const min = Math.round((Date.parse(b) - Date.parse(a)) / 60e3); out.push({ k: "downtime", g: g0[h.era] + idx, label: min >= 120 ? `Paused ${Math.round(min / 60)} h` : `Paused ${min} min`, p: 3 }); }
  // long Auto stories: the longest auto scenes, at most 2 per UTC day
  const byDay = new Map();
  for (const h of H) for (const r of h.runs) if (r[0] && r[3] === "auto" && r[2] - r[1] >= 30) { const d = h.h.slice(0, 10); (byDay.get(d) || byDay.set(d, []).get(d)).push({ k: "story", g: g0[h.era] + r[1], len: r[2] - r[1] + 1, label: r[0], p: 2 }); }
  for (const l of byDay.values()) out.push(...l.sort((a, b) => b.len - a.len).slice(0, 2));
  // ideas (SDXL timeline; ideas older than SDXL point at a different timeline)
  const rx = new Map((reacts || []).map((r) => [r.strip, r.lol + r.fire + r.mind + r.love + r.dead]));
  const ids = [];
  for (const i of ideas || []) {
    if (i.start_strip == null || !sd || new Date(i.created_at) < new Date(sd.t0)) continue;
    const g = sd.g0 + i.start_strip, end = sd.g0 + (i.end_strip || i.start_strip + 10);
    let r = 0; for (let k = i.start_strip; k <= end - sd.g0; k++) r += rx.get(k) || 0;
    ids.push({ k: "idea", g, label: titleAt(g) || "An idea", by: isOwner(i.handle) ? null : "Someone", rx: r, p: 1 });
  }
  const top = ids.filter((x) => x.rx > 0).sort((a, b) => b.rx - a.rx).slice(0, 12);
  for (const x of top) { x.p = 3; x.top = 1; }
  out.push(...ids);
  return { v: 1, total, items: out.sort((a, b) => a.g - b.g) };
}

module.exports = { ERAS, V, hourKey, fold, compact, historyFrom, isOwner, landmarks };
