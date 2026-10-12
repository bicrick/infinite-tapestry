import { client } from "./sb.js";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (t) => { const s = (Date.now() - new Date(t)) / 1000; return s < 90 ? Math.round(s) + "s" : s < 5400 ? Math.round(s / 60) + "m" : Math.round(s / 3600) + "h"; };
let token = null;
async function call(action, extra = {}) {
  const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ action, ...extra }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
}
const ban = (kind, value) => `<button class="danger" data-ban="${kind}" data-v="${esc(value)}">ban ${kind}</button>`;
async function load() {
  const d = await call("recent"), L = d.limits || {};
  $("kill").textContent = L.guests_enabled ? "Guests can submit · switch to sign-in only" : "Sign-in only · let guests submit again";
  $("kill").onclick = async () => { await call("limits", { limits: { guests_enabled: !L.guests_enabled } }); load(); };
  $("kill-note").textContent = L.guests_enabled ? "" : "Kill switch is ON";
  const keys = ["guest_per_10min", "guest_max_pending", "ip_per_10min", "ip_max_pending", "brake_pending", "shadow_after_strikes", "per_minute", "max_pending"];
  $("limits").innerHTML = keys.map((k) => `<label>${k} <input type="number" data-k="${k}" value="${L[k]}" /></label>`).join("") + `<button id="save">Save</button>`;
  $("save").onclick = async () => { const limits = {}; document.querySelectorAll("[data-k]").forEach((i) => (limits[i.dataset.k] = Number(i.value))); await call("limits", { limits }); load(); };
  $("ideas").innerHTML = d.ideas.map((i) => `<tr><td class="m">${ago(i.created_at)}</td><td>@${esc(i.handle)}</td><td>${esc(i.body)}</td><td class="m">${i.status}</td><td>${ban("session", i.guest_id)}${ban("ip", i.ip_hash)}${ban("fp", i.fp_hash)}<button data-shadow="${i.guest_id}">mute</button></td></tr>`).join("");
  $("shadow").innerHTML = d.shadow.map((i) => `<tr><td class="m">${ago(i.created_at)}</td><td>@${esc(i.handle)}</td><td>${esc(i.body)}</td><td class="m">${esc(i.reason)}</td><td>${ban("ip", i.ip_hash)}</td></tr>`).join("");
  $("sessions").innerHTML = d.sessions.map((s) => `<tr><td class="m">${ago(s.last_seen)}</td><td>@${esc(s.handle)}</td><td class="m">strikes ${s.strikes}${s.shadow ? " · muted" : ""}${s.banned ? " · banned" : ""}</td><td>${ban("session", s.id)}${ban("ip", s.ip_hash)}<button data-shadow="${s.id}" data-on="${s.shadow ? 0 : 1}">${s.shadow ? "unmute" : "mute"}</button></td></tr>`).join("");
  $("bans").innerHTML = d.bans.map((b) => `<tr><td class="m">${ago(b.created_at)}</td><td>${b.kind}</td><td class="m">${esc(b.value)}</td><td><button data-unban="${b.kind}" data-v="${esc(b.value)}">unban</button></td></tr>`).join("");
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button"); if (!t) return;
  try {
    if (t.dataset.ban && t.dataset.v && t.dataset.v !== "null") { await call("ban", { kind: t.dataset.ban, value: t.dataset.v }); load(); }
    else if (t.dataset.unban) { await call("unban", { kind: t.dataset.unban, value: t.dataset.v }); load(); }
    else if (t.dataset.shadow) { await call("shadow", { session: t.dataset.shadow, on: t.dataset.on !== "0" }); load(); }
  } catch (err) { $("msg").textContent = "Failed: " + err.message; }
});
(async () => {
  const sb = await client();
  const { data } = await sb.auth.getSession();
  token = data.session && data.session.access_token;
  if (!token) { $("msg").innerHTML = 'Sign in on <a href="/">the tapestry</a> with an admin account first.'; return; }
  try { await load(); } catch (e) { $("msg").textContent = e.message === "admin_only" ? "This account isn't an admin." : "Error: " + e.message; }
})();
