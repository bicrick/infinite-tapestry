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
async function liveChat() {
  const d = await call("live_chat");
  $("chat-switch").textContent = d.enabled ? "Chat is on · turn it off sitewide" : "Chat is off · turn it back on";
  $("chat-switch").onclick = async () => { await call("live_chat_switch", { enabled: !d.enabled }); liveChat(); };
  $("chat-note").textContent = `Signed-in only · 200 characters · no links · slow mode ${d.slow} s`;
  $("live-chat").innerHTML = d.messages.map((m) => `<tr class="${m.hidden ? "m" : ""}"><td class="m">${ago(m.created_at)}</td><td>${esc(m.handle || "")}</td><td>${esc(m.body)}${m.hidden ? " <span class=\"m\">(hidden)</span>" : ""}</td><td>${m.hidden ? "" : `<button data-chide="${m.id}">delete</button>`}${m.user_id ? ` <button data-cmute="${m.user_id}">mute 1 h</button> <button class="danger" data-cban="${m.user_id}">ban</button>` : ""}</td></tr>`).join("") || '<tr><td class="m">No messages yet.</td></tr>';
  $("live-chat").onclick = async (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.chide) await call("live_chat_hide", { id: +t.dataset.chide });
    else if (t.dataset.cmute) await call("sanction", { user_id: t.dataset.cmute, kind: "mute", minutes: 60 });
    else if (t.dataset.cban) { if (!confirm("Ban this person and hide everything they said?")) return; await call("sanction", { user_id: t.dataset.cban, kind: "ban", minutes: 0 }); }
    liveChat();
  };
}
async function load() {
  liveChat().catch(() => {});
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
const dur = (sec) => sec == null ? "—" : sec < 3600 ? Math.round(sec / 60) + " min" : (sec / 3600).toFixed(1) + " h";
const ERRS = { no_gpu_on_host: "RunPod can't start this pod: its host machine has no free GPU right now. Retry later, or migrate it to another machine in RunPod (it may get a new pod id; it is picked up automatically, or paste it under Pod).",
  start_failed: "RunPod refused to start the pod." };
function renderGpu(g, err) {
  const st = g.state || {}, age = g.last_strip_at ? (Date.now() - new Date(g.last_strip_at)) / 1000 : null;
  $("gpu").innerHTML = kv([["RunPod state", (g.pod || "—").toLowerCase()], ["GPU", g.gpu ? g.gpu + (g.location ? " · " + g.location : "") : "—"], ["uptime", g.pod === "RUNNING" ? dur(g.uptime_s) : "—"],
    ["last strip", age == null ? "—" : age < 120 ? Math.round(age) + " s ago" : dur(age) + " ago"], ["$/hr", g.rate_per_hr != null ? fmt$(g.rate_per_hr) : "—"],
    ["RunPod balance", fmt$(g.balance)], ["hours left (to $" + (g.floor ?? 0.5) + ")", g.hours_left == null ? "—" : g.hours_left.toFixed(1) + " h"], ["desired", st.desired || "—"]]);
  document.querySelectorAll("#gpu-seg button").forEach((b) => b.classList.toggle("on", b.dataset.d === st.desired));
  const e = err || st.last_error;
  const box = $("gpu-err"); box.classList.toggle("hidden", !e);
  if (e) box.innerHTML = esc(ERRS[e] || (/not enough free GPUs/i.test(e) ? ERRS.no_gpu_on_host : "Last start error: " + e)) + ` <a href="${esc(g.console_url)}" target="_blank" rel="noopener">Migrate / start on another machine →</a>`;
  $("gpu-start").disabled = g.pod === "RUNNING"; $("gpu-stop").disabled = g.pod !== "RUNNING";
  $("gpu-note").textContent = (st.note || "") + (g.start_enabled ? "" : " · controller auto-start is off (Start here still works)");
  $("gpu-id").textContent = g.id || "—"; $("gpu-console").href = g.console_url || "#";
}
async function overview() {
  const d = OV = await call("overview"), g = d.gpu || {}, st = g.state || {};
  renderGpu(g);
  const A = d.auto || {}, live = A.theme && A.theme_until && new Date(A.theme_until) > new Date();
  $("auto-paused").checked = !!A.paused;
  if (document.activeElement !== $("auto-steer")) $("auto-steer").value = A.steer || "";
  $("decisions").innerHTML = (d.decisions || []).map((x) => `<tr><td class="m">${new Date(x.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</td><td class="m">${esc(x.move)}${x.total ? ` ${x.step || "?"}/${x.total}` : ""}</td><td><b>${esc(x.journey || "")}</b> ${esc(x.reason || "")}<br><span class="fine">${esc((x.titles || []).join(" · "))}</span></td></tr>`).join("") || '<tr><td class="fine">No decisions logged yet.</td></tr>';
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
    if (t.id === "gpu-start" || t.id === "gpu-stop") {
      const on = t.id === "gpu-start";
      if (!confirm(on ? "Start the GPU pod now? Billing ~$" + ((OV && OV.gpu && OV.gpu.rate_per_hr) || 0.9) + "/h until stopped." : "Stop the GPU pod? (It is stopped, never terminated.)")) return;
      t.disabled = true; $("gpu-note").textContent = on ? "Starting…" : "Stopping…";
      const r = await call(on ? "gpu_start" : "gpu_stop");
      if (!r.ok) { renderGpu(OV.gpu, r.error === "start_failed" ? r.detail : r.error); t.disabled = false; return; }
      renderGpu(r.gpu); setTimeout(overview, 8000);
    } else if (t.id === "gpu-setid") {
      const id = $("gpu-newid").value.trim(); if (!id || !confirm("Point the app at pod " + id + "?")) return;
      const r = await call("gpu_pod_id", { pod_id: id }); $("gpu-newid").value = ""; renderGpu(r.gpu);
    } else if (t.dataset.d) {
      if (!confirm(`Set the desired state to "${t.dataset.d}"? The 5-minute controller follows it` + (t.dataset.d === "off" ? " (stops the pod)." : " (may start the pod; billing ~$0.90/h)."))) return;
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
    else if (t.id === "auto-steer-set") { await call("auto_set", { steer: $("auto-steer").value }); overview(); }
    else if (t.id === "auto-steer-clear") { $("auto-steer").value = ""; await call("auto_set", { steer: "" }); overview(); }
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
  try { if (location.hash === "#reliability") opsView().catch(() => {}); await overview(); stories().catch(() => {}); chatList().then(openChat).catch(() => {}); await load(); } catch (e) { $("msg").textContent = e.message === "admin_only" ? "This account isn't an admin." : "Error: " + e.message; }
})();

// ---------- stories: library + playlist ----------
let LIB = { stories: [], playlist: [], recent: [] };
const storyName = (id) => (LIB.stories.find((s) => s.id === id) || {}).title || "#" + id;
function storyCard(st, { saved = false } = {}) {
  const el = document.createElement("div"); el.className = "story";
  el.innerHTML = `<input class="t" value="${esc(st.title)}" aria-label="Story title" />
    <input class="th" value="${esc(st.theme || "")}" placeholder="Theme" aria-label="Theme" />
    <ol>${(st.scenes || []).map((s) => `<li><input value="${esc(s.title)}" aria-label="Scene title" /><textarea rows="2" aria-label="Scene prompt">${esc(s.prompt)}</textarea></li>`).join("")}</ol>
    <div class="acts"><button data-sa="now">Play now</button><button data-sa="end">Add to playlist</button><button data-sa="save">${saved ? "Save changes" : "Save to library"}</button><span class="fine sa-msg"></span></div>`;
  const read = () => ({ id: st.id, title: el.querySelector(".t").value, theme: el.querySelector(".th").value,
    scenes: [...el.querySelectorAll("li")].map((li) => ({ title: li.querySelector("input").value, prompt: li.querySelector("textarea").value })) });
  el.querySelector(".acts").addEventListener("click", async (e) => {
    const k = e.target.dataset.sa; if (!k) return; e.stopPropagation();
    const m = el.querySelector(".sa-msg");
    try {
      if (k === "now" && !confirm("Play this story now? It replaces the current story within ~30 s.")) return;
      if (k === "save") { const r = await call("story_save", { story: read() }); st.id = r.story.id; m.textContent = "Saved"; }
      else { const s = read(); const r = await call("playlist_add", st.id ? (await call("story_save", { story: s }), { story_id: st.id, when: k }) : { story: s, when: k }); m.textContent = k === "now" ? "Playing next" : "Added"; }
      stories();
    } catch (err) { m.textContent = "Failed: " + err.message; }
  });
  return el;
}
async function stories() {
  LIB = await call("stories");
  const now = LIB.playlist.find((p) => p.status === "playing");
  $("story-now").textContent = now ? `Playing: ${storyName(now.story_id)} (scene ${now.scene_index + 1})` : LIB.playlist.length ? "Next story starts within ~30 s." : "Nothing queued: Auto is steering on its own.";
  $("playlist").innerHTML = LIB.playlist.map((p, i) => `<tr><td class="m">${i + 1}</td><td>${esc(storyName(p.story_id))}</td><td class="m">${p.status}</td>
    <td><button data-pm="${p.id}" data-dir="up">↑</button><button data-pm="${p.id}" data-dir="down">↓</button><button class="danger" data-pr="${p.id}">remove</button></td></tr>`).join("") || '<tr><td class="m">Nothing queued.</td></tr>';
  $("library").innerHTML = LIB.stories.map((s) => `<div class="lib"><b>${esc(s.title)}</b><span>${esc(s.theme)} · ${s.scenes.length} scenes</span>
    <div class="row"><button data-lq="${s.id}" data-when="now">Play now</button><button data-lq="${s.id}" data-when="end">Queue</button><button data-le="${s.id}">Edit</button></div></div>`).join("");
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button"); if (!t) return;
  try {
    if (t.dataset.pm) { await call("playlist_move", { id: +t.dataset.pm, dir: t.dataset.dir }); stories(); }
    else if (t.dataset.pr) { await call("playlist_remove", { id: +t.dataset.pr }); stories(); }
    else if (t.dataset.lq) { if (t.dataset.when === "now" && !confirm("Play this story now?")) return; await call("playlist_add", { story_id: +t.dataset.lq, when: t.dataset.when }); stories(); }
    else if (t.dataset.le) { const s = LIB.stories.find((x) => x.id === +t.dataset.le); const box = $("story-edit"); box.innerHTML = "<h3>Edit</h3>"; box.append(storyCard(structuredClone(s), { saved: true })); box.scrollIntoView({ behavior: "smooth" }); }
  } catch (err) { $("msg").textContent = "Failed: " + err.message; }
});

// ---------- Talk to Auto ----------
let CHAT = null;
const ACTION_TEXT = { set_theme: (i) => `Set theme “${esc(i.theme)}” for ${i.minutes || 60} min`, set_paused: (i) => i.paused ? "Pause Auto" : "Resume Auto",
  queue_story: (i) => `Queue “${esc(storyName(i.story_id))}” (${i.when || "end"})` };
const doneKey = (id) => "it_act_" + id;
async function applyAction(c) {
  const i = c.input || {};
  if (c.name === "set_theme") await call("auto_set", { theme: i.theme, minutes: i.minutes || 60 });
  else if (c.name === "set_paused") await call("auto_set", { paused: !!i.paused });
  else if (c.name === "queue_story") await call("playlist_add", { story_id: i.story_id, when: i.when || "end" });
}
function renderMsg(m) {
  const out = [];
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (c.type === "text" && c.text.trim()) { const d = document.createElement("div"); d.className = "msg-b " + m.role; d.textContent = c.text; out.push(d); }
    else if (c.type === "tool_use" && c.name === "propose_story") out.push(storyCard(structuredClone(c.input)));
    else if (c.type === "tool_use" && ACTION_TEXT[c.name]) {
      const d = document.createElement("div"); const done = localStorage.getItem(doneKey(c.id));
      d.className = "action" + (done ? " done" : "");
      d.innerHTML = `<div>Auto suggests: <b>${ACTION_TEXT[c.name](c.input || {})}</b></div><div class="acts">${done ? `<span class="fine">${esc(done)}</span>` : '<button data-ok>Apply</button><button data-no>Dismiss</button>'}</div>`;
      d.addEventListener("click", async (e) => {
        if (e.target.dataset.ok !== undefined) { await applyAction(c); localStorage.setItem(doneKey(c.id), "Applied"); overview(); stories(); }
        else if (e.target.dataset.no !== undefined) localStorage.setItem(doneKey(c.id), "Dismissed");
        else return;
        d.replaceWith(...renderMsg({ role: "assistant", content: [c] }));
      });
      out.push(d);
    }
  }
  return out;
}
async function openChat(id) {
  CHAT = id; localStorage.setItem("it_chat", id || "");
  const log = $("chat-log"); log.innerHTML = "";
  if (id) for (const m of (await call("chat_get", { id })).messages) log.append(...renderMsg(m));
  if (!log.children.length) log.innerHTML = '<div class="msg-b assistant">Hi, I\'m Auto. Ask what\'s playing, or let\'s draft a story.</div>';
  log.scrollTop = log.scrollHeight;
}
async function chatList(sel) {
  const { chats } = await call("chat_list");
  $("chat-pick").innerHTML = chats.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join("") || '<option value="">New chat</option>';
  const id = sel || +localStorage.getItem("it_chat") || (chats[0] && chats[0].id) || null;
  if (id) $("chat-pick").value = id;
  return id;
}
$("chat-pick").onchange = () => openChat(+$("chat-pick").value || null);
$("chat-new").onclick = async () => { const { chat } = await call("chat_new"); await chatList(chat.id); openChat(chat.id); };
$("chat-in").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chat-form").requestSubmit(); } });
$("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("chat-in").value.trim(); if (!text) return;
  const log = $("chat-log"); if (!CHAT) log.innerHTML = "";
  $("chat-in").value = "";
  log.append(...renderMsg({ role: "user", content: [{ type: "text", text }] }));
  const w = document.createElement("div"); w.className = "msg-b assistant wait"; w.textContent = "Auto is thinking…"; log.append(w); log.scrollTop = log.scrollHeight;
  try {
    const r = await call("chat_send", { chat_id: CHAT, text });
    w.replaceWith(...renderMsg(r.message));
    if (r.chat_id !== CHAT) { CHAT = r.chat_id; localStorage.setItem("it_chat", CHAT); chatList(CHAT); }
  } catch (err) { w.textContent = "Auto couldn't answer just now. Try again."; }
  log.scrollTop = log.scrollHeight;
};

// ---------- views (sidebar / bottom nav) ----------
function show(v) {
  if (!document.getElementById("view-" + v)) v = "overview";
  document.querySelectorAll(".adm .view").forEach((x) => x.classList.toggle("on", x.id === "view-" + v));
  document.querySelectorAll(".side a[data-view]").forEach((a) => a.classList.toggle("on", a.dataset.view === v));
  if (v === "reliability" && token) opsView().catch((e) => ($("msg").textContent = "Error: " + e.message));
  if (v === "auto") { const l = $("chat-log"); l.scrollTop = l.scrollHeight; }
  window.scrollTo(0, 0);
}
addEventListener("hashchange", () => show(location.hash.slice(1)));
show(location.hash.slice(1) || "overview");
setInterval(() => { if (!document.hidden && token && $("view-overview").classList.contains("on")) overview().catch(() => {}); }, 30000);

// ---------- reliability (ops_events / ops_stats) ----------
let OPS_W = { h: 24, b: "hour" };
const secs = (ms) => ms == null ? "—" : ms < 1000 ? ms + " ms" : ms < 90000 ? (ms / 1000).toFixed(1) + " s" : ms < 5400000 ? Math.round(ms / 60000) + " min" : (ms / 3600000).toFixed(1) + " h";
const ct = (t) => new Date(t).toLocaleString([], { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";
async function opsView() {
  const d = await call("ops", { hours: OPS_W.h, bucket: OPS_W.b }), hb = d.heartbeat || {};
  const hbAge = hb.at ? (Date.now() - new Date(hb.at)) / 1000 : null;
  const rl = Object.entries(d.reloads || {}).map(([k, v]) => k + " " + v).join(", ") || "0";
  $("ops-kv").innerHTML = kv([["pod drops", d.pod_drops ?? 0], ["viewer disconnects", d.viewer_drops ?? 0], ["mean time to reconnect", secs(d.mttr_ms)],
    ["longest strip gap", d.longest_gap_s == null ? "—" : secs(d.longest_gap_s * 1000)], ["gaps > 30 s", d.gaps_over_30s ?? 0],
    ["avg time away from live", secs(d.away_ms_avg)], ["reloads", rl], ["pod heartbeat", hbAge == null ? "—" : Math.round(hbAge) + " s ago" + (hb.detail && hb.detail.release ? " · " + String(hb.detail.release).slice(0, 7) : "")]]);
  if (d.longest_gap_at) $("ops-kv").insertAdjacentHTML("beforeend", `<div><b>${esc(ct(d.longest_gap_at))}</b><span>longest gap ended</span></div>`);
  $("ops-unit").textContent = OPS_W.b;
  const B = d.buckets || [];
  $("ops-buckets").innerHTML = '<tr><th>' + OPS_W.b + ' (CT)</th><th>pod drops</th><th>viewer drops</th><th>reloads</th><th>mean reconnect</th></tr>' +
    (B.slice().reverse().map((x) => `<tr><td class="m">${esc(OPS_W.b === "day" ? x.t.slice(0, 10) : x.t.slice(5))}</td><td>${x.pod_drops}</td><td>${x.viewer_drops}</td><td>${x.reloads}</td><td class="m">${secs(x.mttr_ms)}</td></tr>`).join("") || '<tr><td class="fine">No events in this window.</td></tr>');
  $("ops-recent").innerHTML = (d.recent || []).map((e) => `<tr><td class="m">${esc(ct(e.started_at))}</td><td class="m">${esc(e.source)}</td><td><b>${esc(e.type)}</b></td><td class="m">${e.duration_ms == null ? "" : secs(e.duration_ms)}</td><td class="fine">${esc(Object.entries(e.detail || {}).filter(([k]) => k !== "build" && k !== "hidden").map(([k, v]) => k + "=" + v).join(" · ").slice(0, 160))}</td></tr>`).join("") || '<tr><td class="fine">No events yet.</td></tr>';
}
document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("#ops-seg button"); if (!b) return;
  OPS_W = { h: +b.dataset.h, b: b.dataset.b }; document.querySelectorAll("#ops-seg button").forEach((x) => x.classList.toggle("on", x === b)); opsView().catch(() => {}); });
setInterval(() => { if (!document.hidden && token && $("view-reliability").classList.contains("on")) opsView().catch(() => {}); }, 60000);
