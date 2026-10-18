const { env, rest, POD, loadPod, storagePrefixes } = require("../lib/common");
const tmi = require("../lib/tmindex");
const { r2Get, sbGet } = require("../lib/r2");

// Public, read-only, aggregated data for /about and /time-machine (no PII: handles only where the
// person chose to be credited — idea authors and fuel buyers, never ids/emails/ip).
//   ?kind=transparency  fuel series, burn rate, streak, buyer wall (recent + all-time)
//   ?kind=history       one entry per day of the SDXL timeline: strip range, times, highlight scenes
//   ?kind=count         live strip total + measured rate (homepage counter)
//   ?kind=heroes        Hall of Heroes (live fuel purchases, chosen handle or 'Someone', no owner)
//   ?kind=tile&l=2|3&c=N  low-res LOD tile (1/16 or 1/64), proxied from private storage, CDN cached
const OWNER = new Set(["bicrick"]);
const SB = () => env("SUPABASE_URL").replace(/\/$/, "");
const svc = () => ({ apikey: env("SUPABASE_SERVICE_ROLE_KEY"), authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY") });
const SESSION = () => env("TAPESTRY_STORAGE_PREFIX", "live-sdxl");

// Honest fuel summary: prepaid fuel purchased vs. what painting has cost (GPU + Auto director), no "tank".
// Rate = GPU price from config (TAPESTRY_GPU_CENTS_PER_HOUR, default 89c = the RTX 4090 pod) + measured director cost.
function fuelSummary(series) {
  const gpu = Number(env("TAPESTRY_GPU_CENTS_PER_HOUR", "89")) || 89;
  let cost = 0, donated = 0, hours = 0;
  for (const s of series) { const b = Number(s.burn) || 0; cost += b; donated += Number(s.donated) || 0; if (b > 0) hours++; }
  const measured = hours ? cost / hours : 0;
  const director = Math.max(0, Math.round(measured - gpu));
  const rate = gpu + director;
  return { since: series.length ? series[0].t : null, hours_painted: hours, cost_cents: Math.round(cost), donated_cents: Math.round(donated),
           gpu_cents_per_hour: gpu, director_cents_per_hour: director, rate_cents_per_hour: rate,
           hours_covered: +(donated / rate).toFixed(1) };
}

async function transparency() {
  const [t, recent, top] = await Promise.all([
    fetch(`${SB()}/rest/v1/rpc/transparency`, { method: "POST", headers: { ...svc(), "content-type": "application/json" }, body: "{}" }).then(r => r.json()),
    rest("GET", "donors_recent?select=handle,amount_cents,created_at,tagline,url&limit=12").catch(() => []),
    rest("GET", "donors_top?select=handle,total_cents,gifts,tagline,url&limit=10").catch(() => []),
  ]);
  const bal = Number(t.balance_cents) || 0, burn = Number(t.burn_cents_per_hour) || 0;
  return { ...t, hours_left: burn > 0 ? +(bal / burn).toFixed(1) : null, fuel: fuelSummary(t.series || []), donors: { recent: Array.isArray(recent) ? recent : [], top: Array.isArray(top) ? top : [] } };
}

// Hall of Heroes: live Stripe fuel purchases only, owner/admins excluded, chosen handle or "Someone" (view donors_heroes).
async function heroes() {
  const rows = await rest("GET", "donors_heroes?select=name,gifts,last_at&order=last_at.desc&limit=200").catch(() => []);
  return { heroes: (Array.isArray(rows) ? rows : []).map((r) => ({ name: OWNER.has(String(r.name).toLowerCase()) ? "Someone" : r.name, gifts: r.gifts, at: r.last_at })) };
}

// Live counter: total strips painted (current session) + measured rate over the last ~10 min.
async function count() {
  const h = { headers: svc() }, since = new Date(Date.now() - 10 * 60e3).toISOString();
  const [last, early] = await Promise.all([
    fetch(`${SB()}/rest/v1/strips?select=idx,created_at&session=eq.${SESSION()}&order=idx.desc&limit=1`, h).then((r) => r.json()),
    fetch(`${SB()}/rest/v1/strips?select=idx,created_at&session=eq.${SESSION()}&created_at=gte.${since}&order=idx.asc&limit=1`, h).then((r) => r.json()),
  ]);
  const L = last && last[0], E = early && early[0];
  if (!L) return { total: 0, rate: 0, at: new Date().toISOString() };
  const dt = E ? (new Date(L.created_at) - new Date(E.created_at)) / 1000 : 0;
  const rate = E && dt > 30 ? (L.idx - E.idx) / dt : 0;
  return { total: L.idx + 1, rate: +Math.min(2, Math.max(0, rate)).toFixed(4), at: L.created_at, now: new Date().toISOString() };
}

async function allStrips() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB()}/rest/v1/strips?select=idx,created_at,scene&session=eq.${SESSION()}&order=idx.asc`, { headers: { ...svc(), range: `${from}-${from + 999}` } });
    const rows = await r.json(); if (!Array.isArray(rows)) break;
    out.push(...rows); if (rows.length < 1000) break;
  }
  return out;
}

// Fast path: precomputed hour index (web/lib/tmbuild.js, Vercel cron) + a live tail of strips newer than its
// checkpoint, so the result is as fresh as the full scan without reading every row.
const monthCache = new Map(); // past months are immutable
async function idxJSON(name) {
  const r = await fetch(`${SB()}/storage/v1/object/tapestry/tm/idx/${name}`, { headers: svc() });
  if (!r.ok) throw new Error("tm index " + name + " " + r.status);
  return r.json();
}
async function indexedHistory(tz) {
  const state = await idxJSON("state.json");
  const era = state.eras.find((e) => e.session === SESSION());
  if (!era || state.last[SESSION()] == null) throw new Error("tm index: no era");
  const cur = new Date().toISOString().slice(0, 7), lastM = state.months[state.months.length - 1];
  const after = state.last[SESSION()];
  const [months, tail, ideas, reacts] = await Promise.all([
    Promise.all(state.months.map(async (m) => {
      if (m !== cur && m !== lastM && monthCache.has(m)) return monthCache.get(m);
      const j = await idxJSON(m + ".json"); if (m !== cur && m !== lastM) monthCache.set(m, j); return j;
    })),
    (async () => {
      const out = [];
      for (let from = 0; from < 5000; from += 1000) {
        const r = await fetch(`${SB()}/rest/v1/strips?select=idx,created_at,scene&session=eq.${SESSION()}&idx=gt.${after}&order=idx.asc`, { headers: { ...svc(), range: `${from}-${from + 999}` } });
        const rows = await r.json(); if (!Array.isArray(rows)) throw new Error("tail");
        out.push(...rows); if (rows.length < 1000) return out;
      }
      throw new Error("tm index too stale");
    })(),
    rest("GET", "ideas?select=id,handle,body,created_at,start_strip,end_strip,image_path&status=eq.played&start_strip=not.is.null&order=start_strip.asc&limit=1000").catch(() => []),
    rest("GET", "strip_reactions?select=strip,lol,fire,mind,love,dead&order=strip.desc&limit=2000").catch(() => []),
  ]);
  const hours = months.flatMap((m) => m.hours).filter((h) => h.era === era.id).map((h) => ({ ...h, times: h.times.slice(), runs: h.runs.map((r) => r.slice()) }));
  tmi.fold(hours, era.id, tail);
  return tmi.historyFrom(hours, { tz, session: SESSION(), eraT0: era.t0, ideas, reacts });
}

async function history(tz) {
  try { return await indexedHistory(tz); } catch (e) { console.warn("history: index unavailable, full scan:", e.message); }
  const [strips, ideas, reacts] = await Promise.all([
    allStrips(),
    rest("GET", "ideas?select=id,handle,body,created_at,start_strip,end_strip,image_path&status=eq.played&start_strip=not.is.null&order=start_strip.asc&limit=1000").catch(() => []),
    rest("GET", "strip_reactions?select=strip,lol,fire,mind,love,dead&order=strip.desc&limit=2000").catch(() => []),
  ]);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const rx = new Map((reacts || []).map(r => [r.strip, r.lol + r.fire + r.mind + r.love + r.dead]));
  const days = new Map();
  let run = null;
  for (const s of strips) {
    const day = fmt.format(new Date(s.created_at));
    let d = days.get(day);
    if (!d) days.set(day, d = { day, a: s.idx, b: s.idx, t0: s.created_at, t1: s.created_at, times: [], scenes: [] });
    d.b = s.idx; d.t1 = s.created_at;
    if (s.idx % 64 === 0) d.times.push([s.idx, s.created_at]); // coarse strip->time map for the readout
    const title = s.scene && s.scene.title;
    if (!run || run.title !== title || run.day !== day) {
      run = { day, title: title || null, a: s.idx, b: s.idx, origin: s.scene && s.scene.origin, by: s.scene && s.scene.by, rx: 0 };
      d.scenes.push(run);
    }
    run.b = s.idx; run.rx += rx.get(s.idx) || 0;
  }
  // Highlights: user ideas that landed (not the owner's), then the most-reacted scenes, then long Auto scenes.
  for (const d of days.values()) {
    const picks = [];
    for (const i of ideas || []) {
      if (i.start_strip < d.a || i.start_strip > d.b || OWNER.has(String(i.handle).toLowerCase())) continue;
      if (strips.length && new Date(i.created_at) < new Date(strips[0].created_at)) continue; // pre-SDXL ranges point at a different timeline
      const end = i.end_strip || i.start_strip + 10;
      const r = d.scenes.filter(s => s.b >= i.start_strip && s.a <= end).reduce((n, s) => n + s.rx, 0);
      picks.push({ a: i.start_strip, b: end, text: i.body.slice(0, 120), handle: i.handle, image: !!i.image_path, rx: r, kind: "idea" });
      (d.ideas = d.ideas || []).push({ id: i.id, a: i.start_strip, text: i.body.slice(0, 80), handle: OWNER.has(String(i.handle).toLowerCase()) ? null : i.handle });
    }
    const scenes = d.scenes.filter(s => s.title && s.b - s.a >= 6 && !(s.by && OWNER.has(String(s.by).replace("@", "").toLowerCase())));
    scenes.sort((x, y) => y.rx - x.rx || (y.b - y.a) - (x.b - x.a));
    for (const s of scenes) {
      if (picks.length >= 6) break;
      if (picks.some(p => s.a <= p.b && s.b >= p.a)) continue;
      picks.push({ a: s.a, b: s.b, text: s.title, handle: s.origin === "user" ? (s.by || "").replace("@", "") || null : null, rx: s.rx, kind: "scene" });
    }
    picks.sort((x, y) => (y.kind === "idea") - (x.kind === "idea") || y.rx - x.rx);
    d.highlights = picks.slice(0, 6).sort((x, y) => x.a - y.a);
    d.scene_count = d.scenes.length; delete d.scenes;
  }
  return { session: SESSION(), live_edge: strips.length ? strips[strips.length - 1].idx : 0, tz, days: [...days.values()].reverse() };
}

async function tile(res, l, c) {
  if (![1, 2, 3].includes(l) || !(c >= 0)) return res.status(400).end();
  const key = `lod/${l}/${String(c).padStart(6, "0")}.jpg`;
  for (const pre of storagePrefixes()) {   // R2 first (the pod writes LOD tiles only there)
    const b = await r2Get(`${pre}/${key}`);
    if (b) {
      res.setHeader("content-type", "image/jpeg");
      res.setHeader("cache-control", "public, max-age=86400, s-maxage=31536000, immutable");
      return res.status(200).send(b);
    }
  }
  for (const pre of storagePrefixes()) {
    const r = await fetch(`${SB()}/storage/v1/object/tapestry/${pre}/${key}`, { headers: svc() }).catch(() => null);
    if (r && r.ok) {
      res.setHeader("content-type", "image/jpeg");
      res.setHeader("cache-control", "public, max-age=86400, s-maxage=31536000, immutable");
      return res.status(200).send(Buffer.from(await r.arrayBuffer()));
    }
  }
  if (await loadPod()) {
    const r = await fetch(`https://${POD()}-8000.proxy.runpod.net/lod/${l}/${c}.jpg`).catch(() => null);
    if (r && r.ok) {
      res.setHeader("content-type", "image/jpeg");
      res.setHeader("cache-control", "public, max-age=600, s-maxage=600");
      return res.status(200).send(Buffer.from(await r.arrayBuffer()));
    }
  }
  res.setHeader("cache-control", "public, s-maxage=60");
  return res.status(404).end();
}

module.exports = async (req, res) => {
  const q = new URL(req.url, "http://x").searchParams;
  try {
    const kind = q.get("kind");
    if (kind === "tile") return await tile(res, +q.get("l"), +q.get("c"));
    if (kind === "ogstrip") { // Time Machine v3: OG-era (SD 1.5) strip, private storage -> CDN, immutable
      const i = +q.get("i"); if (!(i >= 0 && i < 100000 && Number.isInteger(i))) return res.status(400).end();
      const name = `live/strips/${String(i).padStart(8, "0")}.jpg`;
      // R2 "live/strips/" is a different (SDXL) history with the same key names, so the OG copy lives under sb-tapestry/
      const b = (await r2Get(`sb-tapestry/${name}`)) || (await sbGet(`tapestry/${name}`));
      if (!b) { res.setHeader("cache-control", "public, s-maxage=300"); return res.status(404).end(); }
      res.setHeader("content-type", "image/jpeg"); res.setHeader("access-control-allow-origin", "*");
      res.setHeader("cache-control", "public, max-age=86400, s-maxage=31536000, immutable");
      return res.status(200).send(b);
    }
    if (kind === "transparency") {
      res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=300");
      return res.status(200).json(await transparency());
    }
    if (kind === "count") {
      res.setHeader("cache-control", "public, s-maxage=20, stale-while-revalidate=60");
      return res.status(200).json(await count());
    }
    if (kind === "heroes") {
      res.setHeader("cache-control", "public, s-maxage=120, stale-while-revalidate=600");
      return res.status(200).json(await heroes());
    }
    if (kind === "history") {
      const tz = /^[A-Za-z_]+\/[A-Za-z_]+$/.test(q.get("tz") || "") ? q.get("tz") : "America/Chicago";
      res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=900");
      return res.status(200).json(await history(tz));
    }
    if (kind === "tm") { // Time Machine v3: eras + global unit offsets (every strip one equal-width unit)
      res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=300");
      const part = q.get("part");
      if (part === "landmarks" || part === "scenes") return res.status(200).json(await idxJSON(part + ".json"));
      const st = await idxJSON("state.json");
      if (part === "hours") { // compact unit<->time map: [g_first, g_last, t0_ms, t1_ms]
        const g0 = Object.fromEntries(st.eras.map((e) => [e.id, e.g0]));
        const ms = await Promise.all(st.months.map((m) => idxJSON(m + ".json")));
        return res.status(200).json({ hours: ms.flatMap((m) => m.hours).map((h) => [g0[h.era] + h.a, g0[h.era] + h.b, Date.parse(h.t0), Date.parse(h.t1)]).sort((a, b) => a[0] - b[0]) });
      }
      return res.status(200).json({ eras: st.eras, months: st.months, last: st.last, updated: st.updated });
    }
    return res.status(400).json({ error: "kind" });
  } catch (e) { return res.status(500).json({ error: "unavailable" }); }
};
