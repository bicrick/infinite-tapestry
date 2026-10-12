// Guest identity: signed httpOnly cookie (session id) + privacy-light fingerprint hash.
const crypto = require("crypto");
const { rest, ipHash } = require("./common");

const COOKIE = "it_guest";
const secret = () => process.env.GUEST_SECRET || "";
const sign = (v) => crypto.createHmac("sha256", secret()).update(v).digest("base64url").slice(0, 32);

function readCookie(req) {
  const raw = String(req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw || !secret()) return null;
  const [id, sig] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split(".");
  if (!id || !sig || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const want = sign(id);
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? id : null;
}
function setCookie(res, id) {
  res.setHeader("set-cookie", `${COOKIE}=${id}.${sign(id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 180}`);
}
// The client sends a SHA-256 of a few stable browser traits; we re-hash it with our secret so the
// stored value can't be correlated elsewhere.
function fpHash(raw) {
  const s = String(raw || "");
  if (!/^[0-9a-f]{64}$/.test(s)) return null;
  return crypto.createHmac("sha256", secret()).update("fp|" + s).digest("hex").slice(0, 32);
}
async function guestSession(req, res, fpRaw) {
  const id = readCookie(req), fp = fpHash(fpRaw), ip = ipHash(req);
  const rows = await rest("POST", "rpc/guest_session", { p_id: id, p_fp: fp, p_ip: ip });
  const g = rows && rows[0];
  if (!g) throw new Error("no guest session");
  if (g.id !== id) setCookie(res, g.id);
  return { ...g, fp, ip };
}
module.exports = { guestSession, readCookie, fpHash };
