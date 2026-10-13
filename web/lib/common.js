// Shared helpers for the Vercel functions. No dependencies: Stripe, Supabase and RunPod via fetch.
const crypto = require("crypto");

const env = (k, d) => process.env[k] || d;
// The public domain is ONE config value (SITE_URL); everything else derives from it.
const SITE_URL = () => env("SITE_URL", "https://infinite-tapestry.vercel.app").replace(/\/$/, "");
const SB_URL = () => env("SUPABASE_URL").replace(/\/$/, "");
const svcHeaders = () => ({ apikey: env("SUPABASE_SERVICE_ROLE_KEY"), authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY"), "content-type": "application/json" });

async function rest(method, path, body, extra = {}) {
  const r = await fetch(`${SB_URL()}/rest/v1/${path}`, { method, headers: { ...svcHeaders(), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`supabase ${method} ${path.split("?")[0]} ${r.status}: ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}

async function userFromToken(token) {
  if (!token) return null;
  const r = await fetch(`${SB_URL()}/auth/v1/user`, { headers: { apikey: env("SUPABASE_ANON_KEY") || env("SUPABASE_SERVICE_ROLE_KEY"), authorization: "Bearer " + token } });
  if (!r.ok) return null;
  const u = await r.json();
  const rows = await rest("GET", `profiles?id=eq.${u.id}&select=id,handle,is_admin`);
  return { id: u.id, email: u.email, handle: rows[0] && rows[0].handle, is_admin: !!(rows[0] && rows[0].is_admin) };
}

/** The admin is an email allowlist (ADMIN_EMAILS, comma-separated), checked against Supabase's verified
 *  auth email for the bearer token. profiles.is_admin is deliberately ignored here. */
const ADMIN_EMAILS = () => env("ADMIN_EMAILS", "patrickbrownai@gmail.com").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
async function adminFromToken(token) {
  if (!token || token.length > 4096) return null;
  const r = await fetch(`${SB_URL()}/auth/v1/user`, { headers: { apikey: env("SUPABASE_ANON_KEY") || env("SUPABASE_SERVICE_ROLE_KEY"), authorization: "Bearer " + token } }).catch(() => null);
  if (!r || !r.ok) return null;
  const u = await r.json().catch(() => null);
  const email = String((u && u.email) || "").toLowerCase();
  if (!u || !u.id || !email || !u.email_confirmed_at || !ADMIN_EMAILS().includes(email)) return null;
  return { id: u.id, email, is_admin: true };
}

/** Client IP from headers the edge sets; never trust a bare spoofable XFF alone. */
function clientIp(req) {
  const h = req.headers || {};
  for (const k of ["cf-connecting-ip", "true-client-ip", "x-real-ip", "x-vercel-forwarded-for"]) {
    const v = String(h[k] || "").split(",")[0].trim();
    if (v) return v;
  }
  // Vercel (and most edges) put the real client first in x-forwarded-for.
  const fwd = String(h["x-forwarded-for"] || "").split(",")[0].trim();
  if (fwd) return fwd;
  return String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "").trim();
}

function ipHash(req) {
  const ip = clientIp(req);
  return crypto.createHash("sha256").update(ip + "|" + env("IP_HASH_SALT", "tapestry")).digest("hex").slice(0, 32);
}

async function audit(action, { actor = null, handle = null, ip = null, target = null, detail = {} } = {}) {
  try {
    await rest("POST", "audit_log", { actor, actor_handle: handle, ip_hash: ip, action, target, detail }, { prefer: "return=minimal" });
  } catch (e) { console.error("audit failed", e.message); }
}

// Stripe mode is pure config: STRIPE_MODE=live switches to STRIPE_LIVE_SECRET_KEY / STRIPE_LIVE_WEBHOOK_SECRET.
// Anything else (default) uses the test keys in STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET.
const stripeLive = () => env("STRIPE_MODE", "test") === "live";
const stripeKey = () => (stripeLive() ? env("STRIPE_LIVE_SECRET_KEY") : env("STRIPE_SECRET_KEY"));
const stripeWebhookSecret = () => (stripeLive() ? env("STRIPE_LIVE_WEBHOOK_SECRET") : env("STRIPE_WEBHOOK_SECRET"));
async function stripe(path, form) {
  const body = new URLSearchParams();
  const add = (k, v) => {
    if (v === undefined || v === null) return;
    if (typeof v === "object") Object.entries(v).forEach(([kk, vv]) => add(`${k}[${kk}]`, vv));
    else body.append(k, String(v));
  };
  Object.entries(form || {}).forEach(([k, v]) => add(k, v));
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form ? "POST" : "GET",
    headers: { authorization: "Bearer " + stripeKey(), "content-type": "application/x-www-form-urlencoded" },
    body: form ? body : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error("stripe: " + (j.error && j.error.message));
  return j;
}

function verifyStripe(raw, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")).filter((p) => p.length === 2 && p[0] !== "v1"));
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

async function runpod(query) {
  const r = await fetch("https://api.runpod.io/graphql", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env("RUNPOD_API_KEY") },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors) throw new Error("runpod: " + JSON.stringify(j.errors).slice(0, 200));
  return j.data;
}
const POD = () => env("RUNPOD_POD_ID");
async function podStatus() {
  const d = await runpod(`query { pod(input: {podId: "${POD()}"}) { id desiredStatus } }`);
  return d.pod ? d.pod.desiredStatus : "UNKNOWN";
}
async function podStart() { return runpod(`mutation { podResume(input: {podId: "${POD()}", gpuCount: 1}) { id desiredStatus } }`); }
async function podStop() { return runpod(`mutation { podStop(input: {podId: "${POD()}"}) { id desiredStatus } }`); }

async function fuelBalance() {
  const rows = await rest("GET", "fuel_status?select=balance_cents,pod_status");
  return { balance: Number(rows[0] ? rows[0].balance_cents : 0), pod: rows[0] && rows[0].pod_status };
}

// Reconcile the GPU pod. Fuel (donations) is display-only: the pod runs 24/7. The only automatic stop is the
// RunPod credit guard (account balance <= RUNPOD_MIN_BALANCE, default $0.50), plus an explicit desired=off.
// Starting is gated by CONTROLLER_ENABLE_START=1.
const MIN_BALANCE = () => Number(env("RUNPOD_MIN_BALANCE", "0.5"));
async function runpodBalance() {
  try { const d = await runpod(`query { myself { clientBalance } }`); const b = Number(d.myself && d.myself.clientBalance); return Number.isFinite(b) ? b : null; }
  catch (_) { return null; }   // unknown: never stop on a failed read
}
async function reconcile(reason) {
  const { balance } = await fuelBalance();
  const credit = await runpodBalance();
  const st = await podStatus();
  const desiredRows = await rest("GET", "pod_state?id=eq.1&select=desired");
  const desired = desiredRows[0] ? desiredRows[0].desired : "auto";
  const broke = credit != null && credit <= MIN_BALANCE();
  let action = "none";
  if ((broke || desired === "off") && st === "RUNNING") {
    await podStop(); action = "stop";
  } else if (!broke && credit != null && desired !== "off" && st !== "RUNNING" && env("CONTROLLER_ENABLE_START") === "1") {
    await podStart(); action = "start";
  }
  const status = action === "start" ? "waking" : action === "stop" ? "sleeping" : st === "RUNNING" ? "running" : "sleeping";
  await rest("PATCH", "pod_state?id=eq.1", { status, updated_at: new Date().toISOString(), note: `${reason}: pod ${st}, runpod $${credit == null ? "?" : credit.toFixed(2)}, fuel ${balance.toFixed(1)}c, action ${action}` }, { prefer: "return=minimal" });
  if (action !== "none") await audit(action === "start" ? "pod_start" : "pod_stop", { target: POD(), detail: { reason, balance_cents: balance, runpod_balance: credit, by: "controller" } });
  return { balance_cents: balance, runpod_balance: credit, pod: st, action, desired, start_enabled: env("CONTROLLER_ENABLE_START") === "1" };
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 256 * 1024) throw new Error("payload too large"); chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Storage prefixes to try for mirrored tapestry assets (env, SDXL, legacy SD1.5). */
function storagePrefixes() {
  return [...new Set([env("TAPESTRY_STORAGE_PREFIX", "live-sdxl"), "live-sdxl", "live"])];
}

module.exports = { adminFromToken, ADMIN_EMAILS, SITE_URL, stripeLive, stripeWebhookSecret, runpod, runpodBalance, MIN_BALANCE, env, rest, userFromToken, clientIp, ipHash, audit, stripe, verifyStripe, reconcile, fuelBalance, readRaw, podStatus, POD, storagePrefixes };
