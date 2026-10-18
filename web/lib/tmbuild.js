// Time Machine index writer (runs as a Vercel cron, /api/tm?job=index). Resumable + idempotent: state.json
// records the last idx folded per era; re-running folds nothing twice (fold() skips idx <= hour.b).
// Layout and fold logic: lib/tmindex.js. Storage: Supabase Storage bucket "tapestry", tm/idx/* (JSON only).
const { ERAS, V, fold, compact, hourKey, landmarks } = require("./tmindex");
const SB = () => process.env.SUPABASE_URL.replace(/\/$/, "");
const H = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY });

// null only when the object really is absent (Storage answers 400/404 "not_found"); any other failure throws, so a
// transient Storage 5xx/429 aborts the job instead of looking like "no state" and resetting the whole index.
async function getJSON(key) {
  const r = await fetch(`${SB()}/storage/v1/object/tapestry/${key}`, { headers: H() });
  if (r.ok) return r.json();
  const body = await r.text().catch(() => "");
  if (r.status === 404 || (r.status === 400 && /not.?found/i.test(body))) return null;
  throw new Error(`get ${key}: ${r.status} ${body.slice(0, 120)}`);
}
// Binary tiles go to R2 only (Supabase Storage is relational/JSON-only now); the small JSON index stays here.
const { r2Put } = require("./r2");
async function putObj(key, body, type) {
  if (!/json/.test(type)) return r2Put(key, body, type, { cacheControl: "public, max-age=60" });
  const r = await fetch(`${SB()}/storage/v1/object/tapestry/${key}`, { method: "POST", headers: { ...H(), "content-type": type, "x-upsert": "true", "cache-control": "60" }, body });
  if (!r.ok) throw new Error(`put ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return body.length;
}
const putJSON = (key, obj) => putObj(key, JSON.stringify(obj), "application/json");

async function rowsAfter(session, after, max = 20000) {
  const out = [];
  for (let from = 0; from < max; from += 1000) {
    const r = await fetch(`${SB()}/rest/v1/strips?select=idx,created_at,scene&session=eq.${session}&idx=gt.${after}&order=idx.asc`, { headers: { ...H(), range: `${from}-${from + 999}` } });
    const rows = await r.json(); if (!Array.isArray(rows)) throw new Error("strips: " + JSON.stringify(rows).slice(0, 200));
    out.push(...rows); if (rows.length < 1000) break;
  }
  return out;
}

async function runIndex({ rebuild = false } = {}) {
  const PFX = "tm/idx/", t = Date.now();
  let state = rebuild ? null : await getJSON(PFX + "state.json");
  if (!state || state.v !== V) state = { v: V, eras: ERAS.map((e) => ({ ...e })), last: {}, months: [] };
  const months = new Map();
  const loadMonth = async (m) => { if (!months.has(m)) months.set(m, (state.months.includes(m) && (await getJSON(PFX + m + ".json"))) || { v: V, month: m, hours: [] }); return months.get(m); };
  const dirty = new Set(); let added = 0;
  for (const era of state.eras) {
    const rows = await rowsAfter(era.session, state.last[era.session] ?? -1);
    if (!rows.length) continue;
    added += rows.length;
    const byM = new Map();
    for (const s of rows) { const m = s.created_at.slice(0, 7); (byM.get(m) || byM.set(m, []).get(m)).push(s); }
    for (const [m, rs] of byM) { fold((await loadMonth(m)).hours, era.id, rs); dirty.add(m); }
    const L = rows[rows.length - 1];
    state.last[era.session] = L.idx;
    if (era.a == null) { era.a = rows[0].idx; era.t0 = rows[0].created_at; }
    era.b = L.idx; era.t1 = L.created_at; era.n = era.b - era.a + 1;
  }
  let g = 0; for (const e of state.eras) { e.g0 = g; g += e.b != null ? e.b + 1 : 0; }
  const cur = hourKey(Date.now()), recent = hourKey(Date.now() - 3600e3); let bytes = 0;
  for (const m of dirty) {
    const mf = months.get(m);
    mf.hours.sort((x, y) => (x.era === y.era ? x.a - y.a : x.t0 < y.t0 ? -1 : 1));
    for (const h of mf.hours) if (!h.closed && h.h < recent) compact(h);
    bytes += await putJSON(PFX + m + ".json", mf);
    if (!state.months.includes(m)) state.months.push(m);
  }
  state.months.sort();
  if (dirty.size || rebuild) {
    for (const m of state.months) await loadMonth(m);
    const all = [...months.values()].flatMap((mf) => mf.hours);
    const q = (p) => fetch(`${SB()}/rest/v1/${p}`, { headers: H() }).then((r) => r.json()).catch(() => []);
    const [ideas, reacts] = await Promise.all([
      q("ideas?select=handle,created_at,start_strip,end_strip&status=eq.played&start_strip=not.is.null&order=start_strip.asc&limit=5000"),
      q("strip_reactions?select=strip,lol,fire,mind,love,dead&order=strip.desc&limit=5000"),
    ]);
    bytes += await putJSON(PFX + "landmarks.json", landmarks(state, all, { ideas, reacts }));
    const g0 = Object.fromEntries(state.eras.map((e) => [e.id, e.g0])), scenes = [];
    for (const h of all.slice().sort((a, b) => g0[a.era] + a.a - (g0[b.era] + b.a))) for (const r of h.runs) {
      if (!r[0]) continue; const gg = g0[h.era] + r[1], last = scenes[scenes.length - 1];
      if (last && last[2] === r[0] && last[0] + last[1] >= gg - 1) last[1] = g0[h.era] + r[2] - last[0] + 1;
      else scenes.push([gg, r[2] - r[1] + 1, r[0], r[3] === "user" ? 1 : 0]);
    }
    bytes += await putJSON(PFX + "scenes.json", { v: 1, scenes: scenes.filter((x) => x[1] >= 6 || x[3]) });
  }
  state.updated = new Date().toISOString();
  bytes += await putJSON(PFX + "state.json", state);
  return { added, months: dirty.size, bytes, ms: Date.now() - t, last: state.last };
}

module.exports = { runIndex, getJSON, putObj, putJSON, SB, H };
