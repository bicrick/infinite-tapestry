// Time Machine tile pyramid writer (Vercel cron, /api/tm?job=tiles). Every strip is one equal-width unit on one
// global line (era g0 + idx). L1 = 16 units/tile at 1024x256; L2..L7 = x4 units per tile, 64 px tall.
// L1 is composed exactly like the live viewer: each strip image starts `overlap` before its slot and later strips
// paint over earlier ones (SDXL: the pod's own level-1 tiles on R2 already are that composite, so they are
// re-cut; OG era and the live tip are composed from the strips). Stored in Supabase Storage tm/lod2/, served by
// /api/tm?tile=L/T through the CDN. Resumable (cursor in the manifest) and idempotent (rebuilding a tile
// rewrites the same bytes). Work is time-boxed per invocation.
const sharp = require("sharp");
const { getJSON, putObj, putJSON, SB, H } = require("./tmbuild");
const R2 = () => (process.env.R2_PUBLIC_URL || "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev").replace(/\/$/, "");
const UPT = { 1: 16 }; for (let l = 2; l <= 7; l++) UPT[l] = UPT[l - 1] * 4;
const TW = 1024, UW = 64, LMAX = 7, MAN = "tm/lod2/manifest.json", WEBP_FROM = 6598;
const key = (l, t) => `tm/lod2/${l}/${String(t).padStart(6, "0")}.webp`;
const i8 = (i) => String(i).padStart(8, "0");

async function bytes(url, headers) {
  for (let k = 0; k < 3; k++) {
    const r = await fetch(url, { headers: { "user-agent": "tapestry-tm/1", ...(headers || {}) } }).catch(() => null);
    if (r && r.ok) return Buffer.from(await r.arrayBuffer());
    if (r && (r.status === 404 || r.status === 400)) return null;
    await new Promise((ok) => setTimeout(ok, 400 * (k + 1)));
  }
  return null;
}
const sbObj = (k) => bytes(`${SB()}/storage/v1/object/tapestry/${k}`, H());

function ctx(state) {
  const og = state.eras.find((e) => e.id === "og"), sd = state.eras.find((e) => e.id === "sdxl");
  const N = sd.g0 + (sd.b ?? -1) + 1;
  const podTiles = new Map(), children = new Map();
  const podTile = (c) => { if (!podTiles.has(c)) podTiles.set(c, bytes(`${R2()}/${sd.session}/lod/1/${String(c).padStart(6, "0")}.jpg`)); return podTiles.get(c); };
  const strip = (g) => g < sd.g0
    ? sbObj(`${og.session}/strips/${i8(g)}.jpg`)
    : bytes(`${R2()}/${sd.session}/strips/${i8(g - sd.g0)}.${g - sd.g0 >= WEBP_FROM ? "webp" : "jpg"}`);
  return { og, sd, N, podTile, strip, children };
}

// L1 tile from strips, composed like the viewer (unit = 256x1024 after normalising height to 1024).
async function l1FromStrips(C, g0, n) {
  const M = 1024, layers = [];
  for (let g = g0; g <= Math.min(C.N - 1, g0 + n); g++) {   // +1: the next strip paints over the last slot
    const b = await C.strip(g); if (!b) continue;
    const meta = await sharp(b).metadata(), s = 1024 / meta.height, w = Math.round(meta.width * s), ov = w - 256;
    layers.push({ input: await sharp(b).resize(w, 1024).toBuffer(), left: M + (g - g0) * 256 - ov, top: 0 });
  }
  const canvas = sharp({ create: { width: M + n * 256 + 512, height: 1024, channels: 3, background: { r: 10, g: 10, b: 12 } } });
  const full = await canvas.composite(layers).png({ compressionLevel: 0 }).toBuffer();
  return sharp(full).extract({ left: M, top: 0, width: n * 256, height: 1024 }).resize(n * UW, 256).toBuffer();
}

async function buildL1(C, t) {
  const g0 = t * 16, n = Math.min(16, C.N - g0), parts = [];
  // SDXL units covered by complete pod tiles are re-cut from them; anything else (OG era, tip) from strips
  let g = g0;
  while (g < g0 + n) {
    if (g >= C.sd.g0) {
      const k = g - C.sd.g0, c = Math.floor(k / 16), off = k % 16, take = Math.min(16 - off, g0 + n - g);
      const pt = await C.podTile(c);
      if (pt) { const m = await sharp(pt).metadata(); if (m.width >= (off + take) * UW) { parts.push({ g, n: take, buf: await sharp(pt).extract({ left: off * UW, top: 0, width: take * UW, height: 256 }).toBuffer() }); g += take; continue; } }
    }
    let e = g + 1; while (e < g0 + n && !(e >= C.sd.g0 && (await C.podTile(Math.floor((e - C.sd.g0) / 16))))) e++;
    parts.push({ g, n: e - g, buf: await l1FromStrips(C, g, e - g) }); g = e;
  }
  return sharp({ create: { width: n * UW, height: 256, channels: 3, background: { r: 10, g: 10, b: 12 } } })
    .composite(parts.map((p) => ({ input: p.buf, left: (p.g - g0) * UW, top: 0 }))).webp({ quality: 72 }).toBuffer();
}

async function buildUp(C, l, t) {
  const nUnits = Math.min(UPT[l], C.N - t * UPT[l]), w = Math.max(1, Math.round(nUnits * TW / UPT[l])), layers = [];
  let x = 0;
  for (let c = 4 * t; c < Math.min(4 * t + 4, Math.ceil(C.N / UPT[l - 1])); c++) {
    const ch = C.children.get(key(l - 1, c)) || (await sbObj(key(l - 1, c)));
    const cu = Math.min(UPT[l - 1], C.N - c * UPT[l - 1]), cw = Math.max(1, Math.round(cu * TW / UPT[l]));
    if (ch) layers.push({ input: await sharp(ch).resize(cw, 64, { kernel: "cubic", fit: "fill" }).toBuffer(), left: x, top: 0 });
    x += cw;
  }
  return sharp({ create: { width: Math.max(w, x), height: 64, channels: 3, background: { r: 10, g: 10, b: 12 } } }).composite(layers).extract({ left: 0, top: 0, width: w, height: 64 }).webp({ quality: 72 }).toBuffer();
}

async function runTiles({ budgetMs = 45000, rebuild = false } = {}) {
  const t0 = Date.now(), state = await getJSON("tm/idx/state.json");
  if (!state) throw new Error("no index state");
  const C = ctx(state);
  let man = rebuild ? null : await getJSON(MAN);
  if (!man) man = { v: 3, units: 0, full: { done: false, l: 1, t: 0, target: C.N } };
  if (man.lock && man.lock > Date.now()) return { skipped: "locked" };
  man.lock = Date.now() + budgetMs + 15000; await putJSON(MAN, man);
  let built = 0;
  const save = async (l, t, buf) => { await putObj(key(l, t), buf, "image/webp"); C.children.set(key(l, t), buf); built++; };
  const tiles = (l, N) => Math.ceil(N / UPT[l]);
  try {
    if (!man.full.done) {
      const N = man.full.target; C.N = N;
      while (Date.now() - t0 < budgetMs && !man.full.done) {
        const { l, t } = man.full;
        if (t >= tiles(l, N)) { if (l >= LMAX) { man.full.done = true; man.units = N; break; } man.full.l = l + 1; man.full.t = 0; continue; }
        const batch = []; for (let k = t; k < Math.min(tiles(l, N), t + (l === 1 ? 6 : 8)); k++) batch.push(k);
        const bufs = await Promise.all(batch.map((k) => (l === 1 ? buildL1(C, k) : buildUp(C, l, k))));
        for (let i = 0; i < batch.length; i++) await save(l, batch[i], bufs[i]);
        man.full.t = t + batch.length;
        if (built % 48 < batch.length) { const { lock, ...m } = man; await putJSON(MAN, { ...m, lock: man.lock }); }
      }
    } else if (C.N > man.units) {
      const start = Math.max(0, man.units - 64);
      for (let l = 1; l <= LMAX && Date.now() - t0 < budgetMs; l++) {
        const a = Math.floor(start / UPT[l]), b = tiles(l, C.N);
        for (let t = a; t < b; t++) await save(l, t, l === 1 ? await buildL1(C, t) : await buildUp(C, l, t));
      }
      if (Date.now() - t0 < budgetMs) man.units = C.N;
    }
  } finally {
    const N = man.full.done ? man.units : man.full.target;
    Object.assign(man, { tile_w: TW, unit_px_l1: UW, eras: state.eras, built: new Date().toISOString(), lock: 0,
      levels: Array.from({ length: LMAX }, (_, i) => ({ l: i + 1, units_per_tile: UPT[i + 1], tiles: tiles(i + 1, N), h: i ? 64 : 256 })),
      strips: { og: { g0: C.og.g0, n: C.og.n }, sdxl: { g0: C.sd.g0, n: C.sd.n, url: C.sd.session + "/strips/{i8}.{ext}", webp_from: WEBP_FROM } } });
    await putJSON(MAN, man);
  }
  return { built, units: man.units, full: man.full, ms: Date.now() - t0 };
}

module.exports = { runTiles, key, _internals: { ctx, buildL1, buildUp } };
