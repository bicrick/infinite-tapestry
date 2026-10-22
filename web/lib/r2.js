// R2 is the only home for binary assets (strips, LOD/TM tiles, canvas.png, crops). Supabase Storage keeps
// old objects for reads only until they are copied and deleted; nothing new is written there.
//   r2Url(key)            public URL (R2_PUBLIC_URL)
//   r2Get(key)            Buffer or null (public read)
//   r2Put(key, body, ct)  signed S3 PUT (SigV4, no SDK) using R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY
//   readFirst(keys...)    first hit among [R2 key, Supabase fallback] fetchers
const crypto = require("crypto");
const PUBLIC_DEFAULT = "https://img.infinitetapestry.app";
const e = (k, d = "") => (process.env[k] == null || process.env[k] === "" ? d : process.env[k]);
const r2Url = (key) => `${e("R2_PUBLIC_URL", PUBLIC_DEFAULT).replace(/\/$/, "")}/${key.replace(/^\//, "")}`;
const writeReady = () => ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].every((k) => e(k));

async function r2Get(key, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(r2Url(key), { headers: { "user-agent": "tapestry-web/1" } }).catch(() => null);
  return r && r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const hmac = (k, s) => crypto.createHmac("sha256", k).update(s).digest();
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

// SigV4 headers for a PUT of `body` to `${endpoint}/${bucket}/${key}` (path-style; R2 region "auto").
function signPut({ endpoint, bucket, key, body, contentType, cacheControl, accessKey, secretKey, now = new Date() }) {
  const u = new URL(endpoint.replace(/\/$/, "") + "/" + enc(bucket) + "/" + enc(key));
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), day = amz.slice(0, 8), hash = sha(body);
  const h = { host: u.host, "x-amz-content-sha256": hash, "x-amz-date": amz, "content-type": contentType };
  if (cacheControl) h["cache-control"] = cacheControl;
  const names = Object.keys(h).sort();
  const canon = ["PUT", u.pathname, "", ...names.map((n) => `${n}:${h[n]}`), "", names.join(";"), hash].join("\n");
  const scope = `${day}/auto/s3/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amz, scope, sha(canon)].join("\n");
  const k = ["auto", "s3", "aws4_request"].reduce(hmac, hmac("AWS4" + secretKey, day));
  const sig = crypto.createHmac("sha256", k).update(sts).digest("hex");
  h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
  delete h.host;
  return { url: u.toString(), headers: h };
}

async function r2Put(key, body, contentType, { cacheControl, fetchImpl = fetch } = {}) {
  if (!writeReady()) throw new Error("R2 write keys missing (R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)");
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const { url, headers } = signPut({ endpoint: e("R2_ENDPOINT"), bucket: e("R2_BUCKET", "tapestry-strips"), key, body: buf,
    contentType, cacheControl, accessKey: e("R2_ACCESS_KEY_ID"), secretKey: e("R2_SECRET_ACCESS_KEY") });
  const r = await fetchImpl(url, { method: "PUT", headers, body: buf });
  if (!r.ok) throw new Error(`r2 put ${key}: ${r.status}`);
  return buf.length;
}

module.exports = { r2Url, r2Get, r2Put, signPut, writeReady };
