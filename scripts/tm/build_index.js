#!/usr/bin/env node
// Incremental writer for the Time Machine history index (see web/lib/tmindex.js for the layout).
// Resumable: state.json records the last idx folded per era, so a crash just redoes the tail.
//   node scripts/tm/build_index.js            incremental (cron)
//   node scripts/tm/build_index.js --rebuild  from the very first strip of the OG era
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; optional R2_ENDPOINT/R2_BUCKET/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY.
const crypto = require("crypto");
const { ERAS, V, fold, compact, hourKey } = require("../../web/lib/tmindex");
const SB = process.env.SUPABASE_URL.replace(/\/$/, ""), KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, authorization: "Bearer " + KEY };
const PFX = "tm/idx/";

async function getJSON(name) {
  const r = await fetch(`${SB}/storage/v1/object/tapestry/${PFX}${name}`, { headers: H });
  return r.ok ? r.json() : null;
}
async function put(name, obj) {
  const body = JSON.stringify(obj);
  const r = await fetch(`${SB}/storage/v1/object/tapestry/${PFX}${name}`, { method: "POST", headers: { ...H, "content-type": "application/json", "x-upsert": "true", "cache-control": "60" }, body });
  if (!r.ok) throw new Error(`put ${name}: ${r.status} ${await r.text()}`);
  await r2put(PFX + name, body).catch((e) => console.warn("r2", name, e.message));
  return body.length;
}

// Minimal SigV4 PUT for Cloudflare R2 (public bucket, served by its CDN). Skipped when creds are absent.
async function r2put(key, body) {
  const { R2_ENDPOINT: ep, R2_BUCKET: bucket, R2_ACCESS_KEY_ID: ak, R2_SECRET_ACCESS_KEY: sk } = process.env;
  if (!ep || !bucket || !ak || !sk) return;
  const url = new URL(`${ep.replace(/\/$/, "")}/${bucket}/${key}`), now = new Date();
  const amz = now.toISOString().replace(/[-:]|\.\d{3}/g, ""), date = amz.slice(0, 8);
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const hdrs = { host: url.host, "x-amz-content-sha256": hash, "x-amz-date": amz, "content-type": "application/json", "cache-control": "public, max-age=60" };
  const names = Object.keys(hdrs).sort();
  const creq = ["PUT", url.pathname, "", names.map((n) => `${n}:${hdrs[n]}\n`).join(""), names.join(";"), hash].join("\n");
  const scope = `${date}/auto/s3/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amz, scope, crypto.createHash("sha256").update(creq).digest("hex")].join("\n");
  const hm = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  const sig = crypto.createHmac("sha256", hm(hm(hm(hm("AWS4" + sk, date), "auto"), "s3"), "aws4_request")).update(sts).digest("hex");
  const r = await fetch(url, { method: "PUT", headers: { ...hdrs, authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` }, body });
  if (!r.ok) throw new Error(`${r.status}`);
}

async function rowsAfter(session, after) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB}/rest/v1/strips?select=idx,created_at,scene&session=eq.${session}&idx=gt.${after}&order=idx.asc`, { headers: { ...H, range: `${from}-${from + 999}` } });
    const rows = await r.json(); if (!Array.isArray(rows)) throw new Error("strips: " + JSON.stringify(rows).slice(0, 200));
    out.push(...rows); if (rows.length < 1000) break;
  }
  return out;
}

(async () => {
  const t = Date.now(), rebuild = process.argv.includes("--rebuild");
  let state = rebuild ? null : await getJSON("state.json");
  if (!state || state.v !== V) state = { v: V, eras: ERAS.map((e) => ({ ...e })), last: {}, months: [] };
  const months = new Map(); // "YYYY-MM" -> {v, month, hours}
  const loadMonth = async (m) => { if (!months.has(m)) months.set(m, (state.months.includes(m) && (await getJSON(m + ".json"))) || { v: V, month: m, hours: [] }); return months.get(m); };
  const dirty = new Set();
  let added = 0;
  for (const era of state.eras) {
    const rows = await rowsAfter(era.session, state.last[era.session] ?? -1);
    if (!rows.length) continue;
    added += rows.length;
    // group by month so each month file folds its own rows
    const byM = new Map();
    for (const s of rows) { const m = s.created_at.slice(0, 7); (byM.get(m) || byM.set(m, []).get(m)).push(s); }
    for (const [m, rs] of byM) { const mf = await loadMonth(m); fold(mf.hours, era.id, rs); dirty.add(m); }
    const L = rows[rows.length - 1];
    state.last[era.session] = L.idx;
    if (era.a == null) { era.a = rows[0].idx; era.t0 = rows[0].created_at; }
    era.b = L.idx; era.t1 = L.created_at; era.n = era.b - era.a + 1;
  }
  // Global unit offsets: eras laid end to end, every strip one equal-width unit.
  let g = 0; for (const e of state.eras) { e.g0 = g; g += e.b != null ? e.b + 1 : 0; }
  const cur = hourKey(Date.now());
  let bytes = 0;
  for (const m of dirty) {
    const mf = months.get(m);
    mf.hours.sort((x, y) => (x.era === y.era ? x.a - y.a : x.t0 < y.t0 ? -1 : 1));
    for (const h of mf.hours) if (!h.closed && h.h < cur && !(h.era === state.eras.at(-1).id && h === mf.hours.filter((x) => x.era === h.era).at(-1) && h.h >= hourKey(Date.now() - 3600e3))) compact(h);
    bytes += await put(m + ".json", mf);
    if (!state.months.includes(m)) state.months.push(m);
  }
  state.months.sort(); state.updated = new Date().toISOString();
  bytes += await put("state.json", state);
  console.log(`tm index: +${added} strips, ${dirty.size} month file(s), ${bytes} B written, ${Date.now() - t} ms; last ${JSON.stringify(state.last)}`);
})().catch((e) => { console.error(e); process.exit(1); });
