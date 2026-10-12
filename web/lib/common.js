// Shared helpers for the Vercel functions. No dependencies: Stripe, Supabase and RunPod via fetch.
const crypto = require("crypto");

const env = (k, d) => process.env[k] || d;
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

function ipHash(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  return crypto.createHash("sha256").update(ip + "|" + env("IP_HASH_SALT", "tapestry")).digest("hex").slice(0, 32);
}

async function audit(action, { actor = null, handle = null, ip = null, target = null, detail = {} } = {}) {
  try {
    await rest("POST", "audit_log", { actor, actor_handle: handle, ip_hash: ip, action, target, detail }, { prefer: "return=minimal" });
  } catch (e) { console.error("audit failed", e.message); }
}

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
    headers: { authorization: "Bearer " + env("STRIPE_SECRET_KEY"), "content-type": "application/x-www-form-urlencoded" },
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

// Reconcile the GPU pod with the fuel tank. Starting is gated by CONTROLLER_ENABLE_START=1.
async function reconcile(reason) {
  const { balance } = await fuelBalance();
  const st = await podStatus();
  const desiredRows = await rest("GET", "pod_state?id=eq.1&select=desired");
  const desired = desiredRows[0] ? desiredRows[0].desired : "auto";
  let action = "none";
  if ((balance <= 0 || desired === "off") && st === "RUNNING") {
    await podStop(); action = "stop";
  } else if (balance > 0 && desired !== "off" && st !== "RUNNING" && env("CONTROLLER_ENABLE_START") === "1") {
    await podStart(); action = "start";
  }
  const status = action === "start" ? "waking" : action === "stop" ? "sleeping" : st === "RUNNING" ? "running" : "sleeping";
  await rest("PATCH", "pod_state?id=eq.1", { status, updated_at: new Date().toISOString(), note: `${reason}: pod ${st}, fuel ${balance.toFixed(1)}c, action ${action}` }, { prefer: "return=minimal" });
  if (action !== "none") await audit(action === "start" ? "pod_start" : "pod_stop", { target: POD(), detail: { reason, balance_cents: balance, by: "controller" } });
  return { balance_cents: balance, pod: st, action, desired, start_enabled: env("CONTROLLER_ENABLE_START") === "1" };
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 256 * 1024) throw new Error("payload too large"); chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = { env, rest, userFromToken, ipHash, audit, stripe, verifyStripe, reconcile, fuelBalance, readRaw, podStatus };
