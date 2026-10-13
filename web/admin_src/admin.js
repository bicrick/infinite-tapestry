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

const fmt$ = (v) => (v == null ? "—" : "$" + Number(v).toFixed(2));
const gb = (b) => (b == null ? "—" : b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(0) + " MB");
const kv = (pairs) => pairs.map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("");
let OV = null;
async function overview() {
  const d = OV = await call("overview"), g = d.gpu || {}, st = g.state || {};
  $("gpu").innerHTML = kv([["pod", (g.pod || "—").toLowerCase()], ["desired", st.desired || "—"], ["RunPod balance", fmt$(g.balance)],
    ["$/hr", g.rate_per_hr != null ? fmt$(g.rate_per_hr) : "—"], ["hours left (to $" + (g.floor ?? 0.5) + ")", g.hours_left == null ? "—" : g.hours_left.toFixed(1) + " h"],
    ["now burning", g.burning ? "yes" : "no"]]) + `<p class="fine" style="grid-column:1/-1">${esc(st.note || "")}</p>`;
  document.querySelectorAll("#gpu-seg button").forEach((b) => b.classList.toggle("on", b.dataset.d === st.desired));
  const A = d.auto || {}, live = A.theme && A.theme_until && new Date(A.theme_until) > new Date();
  $("auto-paused").checked = !!A.paused;
  $("auto-note").textContent = live ? `Theme "${A.theme}" until ${new Date(A.theme_until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "No temporary theme.";
  const W = A.mood_weights || {};
  $("moods").innerHTML = (d.moods || []).map((m) => `<label>${esc(m.key)} <input type="number" min="0" max="50" data-mood="${esc(m.key)}" value="${W[m.key] ?? m.weight}" /></label>`).join("");
  const u = d.usage || {}, S = u.storage || {};
  const supaStorage = Object.values(S).reduce((a, b) => a + Number(b || 0), 0);
  $("stats").innerHTML = kv([["viewers now", d.viewers ?? "—"], ["ideas last hour", u.ideas_1h ?? "—"], ["ideas 24 h", u.ideas_24h ?? "—"], ["waiting", u.pending ?? "—"],
    ["fuel (display)", d.fuel_cents == null ? "—" : fmt$(d.fuel_cents / 100)], ["Supabase DB", gb(u.db_bytes) + " / 0.5 GB"], ["Supabase storage", gb(supaStorage) + " / 1 GB"],
    ["R2 strips", (u.strips ?? 0).toLocaleString() + " · est. " + gb((u.strips || 0) * 50e3)], ["open reports", u.reports_open ?? 0]]);
  const H = u.ideas_hourly || [], mx = Math.max(1, ...H.map((x) => x.n));
  $("ideas-spark").innerHTML = H.map((x, i) => `<rect x="${(i * 240) / Math.max(24, H.length)}" y="${40 - (36 * x.n) / mx}" width="${240 / Math.max(24, H.length) - 2}" height="${(36 * x.n) / mx}" fill="currentColor" opacity=".3"/>`).join("");
  $("reports").innerHTML = (d.reports || []).map((r) => `<tr><td class="m">${ago(r.created_at)}</td><td>${esc(r.reason)}</td><td>${r.idea_id ? `<a href="/s/${r.idea_id}" target="_blank">${esc((r.ideas && r.ideas.body) || "idea " + r.idea_id)}</a>` : `<a href="/s/${r.strip_a}-${r.strip_b}" target="_blank">strips ${r.strip_a}–${r.strip_b}</a>`}</td>` +
    `<td>${r.idea_id ? `<button class="danger" data-idea="${r.idea_id}" data-op="reject">reject</button>` : ""}${r.ideas && r.ideas.user_id ? `<button class="danger" data-sanc="${r.ideas.user_id}" data-kind="ban">ban user</button>` : ""}<button data-rep="${r.id}" data-st="resolved">resolve</button><button data-rep="${r.id}" data-st="dismissed">dismiss</button></td></tr>`).join("") || '<tr><td class="m">No open reports.</td></tr>';
  $("queue").innerHTML = (d.ideas || []).map((i) => `<tr><td class="m">${ago(i.created_at)}</td><td>@${esc(i.handle)}</td><td>${esc(i.body)}</td><td class="m">${i.status} · ♥${i.votes}</td>` +
    `<td><button class="danger" data-idea="${i.id}" data-op="reject">reject</button><button data-idea="${i.id}" data-op="remove">remove</button>` +
    (i.user_id ? `<button data-sanc="${i.user_id}" data-kind="mute" data-min="60">mute 1h</button><button class="danger" data-sanc="${i.user_id}" data-kind="ban">ban</button>` : `${ban("session", i.guest_id)}<button data-shadow="${i.guest_id}">mute</button>`) + `</td></tr>`).join("") || '<tr><td class="m">Nothing waiting.</td></tr>';
  $("sanctions").innerHTML = (d.sanctions || []).map((x) => `<tr><td class="m">${ago(x.created_at)}</td><td>${x.kind}</td><td class="m">${esc(x.user_id || "")}</td><td class="m">${x.until ? "until " + new Date(x.until).toLocaleString() : "permanent"}</td><td><button data-unsanc="${x.id}">lift</button></td></tr>`).join("") || '<tr><td class="m">None active.</td></tr>';
  $("rel").textContent = d.release ? d.release.slice(0, 7) : "—";
  $("vercel-link").href = d.vercel_url;
  $("releases").innerHTML = (d.releases || []).slice(0, 12).map((r) => `<tr><td class="m">${ago(r.at)}</td><td><code>${r.sha.slice(0, 7)}</code>${r.sha === d.release ? " · current" : ""}</td><td>${r.sha === d.release ? "" : `<button data-rollback="${r.sha}">use this release</button>`}</td></tr>`).join("");
  $("deploys").innerHTML = (d.deploys || []).map((x) => `<tr><td class="m">${ago(x.created_at)}</td><td>${x.kind}</td><td><code>${esc(String(x.sha).slice(0, 7))}</code></td><td class="m">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">open</a>` : esc(x.note || "")}</td></tr>`).join("");
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button"); if (!t) return;
  try {
    if (t.dataset.d) {
      if (!confirm(`Set GPU desired state to "${t.dataset.d}"?` + (t.dataset.d === "off" ? "" : " The controller may start the pod (billing ~$0.90/h)."))) return;
      await call("gpu_set", { desired: t.dataset.d }); overview();
    } else if (t.dataset.idea) { await call("idea", { id: +t.dataset.idea, op: t.dataset.op }); overview(); }
    else if (t.dataset.sanc) { if (t.dataset.kind === "ban" && !confirm("Ban this user?")) return; await call("sanction", { user_id: t.dataset.sanc, kind: t.dataset.kind, minutes: +(t.dataset.min || 0) }); overview(); }
    else if (t.dataset.unsanc) { await call("unsanction", { id: +t.dataset.unsanc }); overview(); }
    else if (t.dataset.rep) { await call("report", { id: +t.dataset.rep, status: t.dataset.st }); overview(); }
    else if (t.dataset.rollback) {
      const sha = t.dataset.rollback, typed = prompt(`Point the pod at release ${sha.slice(0, 7)}? It takes effect on the next pod restart.\nType ${sha.slice(0, 7)} to confirm.`);
      if (typed !== sha.slice(0, 7)) return;
      await call("rollback", { sha, confirm: sha }); overview();
    } else if (t.id === "auto-theme-set") { await call("auto_set", { theme: $("auto-theme").value, minutes: +$("auto-mins").value }); $("auto-theme").value = ""; overview(); }
    else if (t.id === "auto-theme-clear") { await call("auto_set", { theme: "" }); overview(); }
    else if (t.id === "moods-save") { const w = {}; document.querySelectorAll("[data-mood]").forEach((i) => (w[i.dataset.mood] = Number(i.value))); await call("auto_set", { mood_weights: w }); overview(); }
    else if (t.id === "moods-reset") { await call("auto_set", { mood_weights: {} }); overview(); }
  } catch (err) { $("msg").textContent = "Failed: " + err.message; }
});
document.addEventListener("change", async (e) => { if (e.target.id === "auto-paused") { await call("auto_set", { paused: e.target.checked }).catch((err) => ($("msg").textContent = "Failed: " + err.message)); overview(); } });
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
  try { await overview(); await load(); } catch (e) { $("msg").textContent = e.message === "admin_only" ? "This account isn't an admin." : "Error: " + e.message; }
})();
