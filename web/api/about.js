const { env, rest, POD, loadPod, storagePrefixes } = require("../lib/common");

// Public, read-only, aggregated data for /about and /time-machine (no PII: handles only where the
// person chose to be credited — idea authors and donor wall, never ids/emails/ip).
//   ?kind=transparency  fuel series, burn rate, streak, donor wall (recent + all-time)
//   ?kind=history       one entry per day of the SDXL timeline: strip range, times, highlight scenes
//   ?kind=tile&l=2|3&c=N  low-res LOD tile (1/16 or 1/64), proxied from private storage, CDN cached
const OWNER = new Set(["bicrick"]);
const SB = () => env("SUPABASE_URL").replace(/\/$/, "");
const svc = () => ({ apikey: env("SUPABASE_SERVICE_ROLE_KEY"), authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY") });
const SESSION = () => env("TAPESTRY_STORAGE_PREFIX", "live-sdxl");

async function transparency() {
  const [t, recent, top] = await Promise.all([
    fetch(`${SB()}/rest/v1/rpc/transparency`, { method: "POST", headers: { ...svc(), "content-type": "application/json" }, body: "{}" }).then(r => r.json()),
    rest("GET", "donors_recent?select=handle,amount_cents,created_at,tagline,url&limit=12").catch(() => []),
    rest("GET", "donors_top?select=handle,total_cents,gifts,tagline,url&limit=10").catch(() => []),
  ]);
  const bal = Number(t.balance_cents) || 0, burn = Number(t.burn_cents_per_hour) || 0;
  return { ...t, hours_left: burn > 0 ? +(bal / burn).toFixed(1) : null, donors: { recent: Array.isArray(recent) ? recent : [], top: Array.isArray(top) ? top : [] } };
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

async function history(tz) {
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
    if (kind === "transparency") {
      res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=300");
      return res.status(200).json(await transparency());
    }
    if (kind === "history") {
      const tz = /^[A-Za-z_]+\/[A-Za-z_]+$/.test(q.get("tz") || "") ? q.get("tz") : "America/Chicago";
      res.setHeader("cache-control", "public, s-maxage=300, stale-while-revalidate=900");
      return res.status(200).json(await history(tz));
    }
    return res.status(400).json({ error: "kind" });
  } catch (e) { return res.status(500).json({ error: "unavailable" }); }
};
