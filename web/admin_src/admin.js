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
const PHASE = { off: "Off", starting: "Starting…", live: "Live", stopping: "Stopping…" };
function renderGpu(g, err) {
  const st = g.state || {}, w = g.switch || {}, age = g.last_strip_at ? (Date.now() - new Date(g.last_strip_at)) / 1000 : null;
  const ph = w.state || "off", on = w.desired !== "off";
  $("gpu-switch").setAttribute("aria-checked", String(on));
  $("gpu-phase").textContent = PHASE[ph] || ph; $("gpu-phase").className = "gsw-state " + ph;
  $("gpu-sub").textContent = [w.pod_id ? "pod " + w.pod_id : "", w.gpu || "", w.uptime_s != null && w.runpod === "RUNNING" ? "up " + dur(w.uptime_s) : "",
    w.rate_per_hr != null && w.runpod === "RUNNING" ? fmt$(w.rate_per_hr) + "/h" : ""].filter(Boolean).join(" · ") +
    (ph === "starting" ? " · new pods take ~5–10 min to paint" : "");
  $("gpu").innerHTML = kv([["last strip", age == null ? "—" : age < 120 ? Math.round(age) + " s ago" : dur(age) + " ago"], ["viewers", w.viewers ?? "—"],
    ["RunPod balance", fmt$(g.balance)], ["hours left (to $" + (g.floor ?? 0.5) + ")", g.hours_left == null ? "—" : g.hours_left.toFixed(1) + " h"]]);
  const e = err || (on ? st.last_error : null);
  const box = $("gpu-err"); box.classList.toggle("hidden", !e);
  if (e) box.textContent = "Last error: " + e;
  $("gpu-note").textContent = "On keeps a GPU painting (it replaces the pod by itself if RunPod has no GPU on its host). Off stops it; the site shows replays. " + (st.note || "");
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
    if (t.id === "gpu-switch") {
      const on = t.getAttribute("aria-checked") !== "true";
      if (!confirm(on ? "Turn the GPU on? Billing ~$" + ((OV && OV.gpu && OV.gpu.rate_per_hr) || 0.89) + "/h until you turn it off." : "Turn the GPU off? The site will show replays (the pod is stopped, never deleted).")) return;
      t.disabled = true; $("gpu-phase").textContent = on ? "Starting…" : "Stopping…";
      const r = await call(on ? "gpu_on" : "gpu_off"); t.disabled = false;
      if (!r.ok) { renderGpu(OV.gpu, r.error); return; }
      renderGpu(r.gpu); setTimeout(overview, 8000);
    } else if (t.id === "gpu-setid") {
      const id = $("gpu-newid").value.trim(); if (!id || !confirm("Point the app at pod " + id + "?")) return;
      const r = await call("gpu_pod_id", { pod_id: id }); $("gpu-newid").value = ""; renderGpu(r.gpu);

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
  try { if (location.hash === "#reliability") opsView().catch(() => {}); await overview(); stories().catch(() => {}); chatList().then(openChat).catch(() => {}); if (location.hash === "#config" || location.hash === "#render") renderView().catch(() => {}); await load(); } catch (e) { $("msg").textContent = e.message === "admin_only" ? "This account isn't an admin." : "Error: " + e.message; }
})();

// ---------- stories: library + playlist ----------
let LIB = { stories: [], playlist: [], recent: [] };
const storyName = (id) => (LIB.stories.find((s) => s.id === id) || {}).title || "#" + id;
function storyCard(st, { saved = false } = {}) {
  const el = document.createElement("div"); el.className = "story";
  el.innerHTML = `<input class="t" value="${esc(st.title)}" aria-label="Story title" />
    <input class="th" value="${esc(st.theme || "")}" placeholder="Premise: who or what, where, what happens" aria-label="Premise" />
    <input class="sty" value="${esc(st.style || "")}" placeholder="One look for every scene, e.g. linocut print" aria-label="Story look" />
    <ol>${(st.scenes || []).map((s) => `<li><input value="${esc(s.title)}" aria-label="Scene title" /><textarea rows="2" aria-label="Scene prompt">${esc(s.prompt)}</textarea></li>`).join("")}</ol>
    <div class="acts"><button data-sa="now">Play now</button><button data-sa="end">Add to playlist</button><button data-sa="save">${saved ? "Save changes" : "Save to library"}</button><span class="fine sa-msg"></span></div>`;
  const read = () => ({ id: st.id, title: el.querySelector(".t").value, theme: el.querySelector(".th").value, style: el.querySelector(".sty").value,
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
  $("library").innerHTML = LIB.stories.map((s) => `<div class="lib"><b>${esc(s.title)}</b><span>${esc(s.theme)}${s.style ? " · " + esc(s.style) : ""} · ${s.scenes.length} scenes</span>
    <div class="row"><button data-lq="${s.id}" data-when="now">Play now</button><button data-lq="${s.id}" data-when="end">Queue</button><button data-le="${s.id}">Edit</button><button class="danger" data-ld="${s.id}">Delete</button></div></div>`).join("") || '<p class="fine">No saved stories yet. Draft one in Talk to Auto.</p>';
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button"); if (!t) return;
  try {
    if (t.dataset.pm) { await call("playlist_move", { id: +t.dataset.pm, dir: t.dataset.dir }); stories(); }
    else if (t.dataset.pr) { await call("playlist_remove", { id: +t.dataset.pr }); stories(); }
    else if (t.dataset.lq) { if (t.dataset.when === "now" && !confirm("Play this story now?")) return; await call("playlist_add", { story_id: +t.dataset.lq, when: t.dataset.when }); stories(); }
    else if (t.dataset.ld) {
      const st = LIB.stories.find((x) => x.id === +t.dataset.ld) || {};
      if (!(await confirmBox(`Delete the story “${st.title}”?`, "This permanently removes it from the library and its playlist history. It can't be undone.", "Delete story"))) return;
      await call("story_delete", { id: +t.dataset.ld, confirm: +t.dataset.ld }); $("story-edit").innerHTML = ""; stories();
    }
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
let CHATS = [];
const SUGGEST = ["What's playing right now?", "Draft a 7-scene story about a night in a 1920s jazz club", "Pause Auto for a bit", "Suggest a theme for this evening"];
function emptyState(log) {
  log.innerHTML = `<div class="tta-empty"><span class="tta-av big" aria-hidden="true">A</span><b>Hi, I'm Auto.</b><span class="fine">Ask what's playing, draft a story, or steer the stream. Anything that changes the live stream shows up as a card for you to apply.</span>
    <div class="chips">${SUGGEST.map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div></div>`;
}
function bubble(role, el) { const row = document.createElement("div"); row.className = "mrow " + role; if (role === "assistant") row.innerHTML = '<span class="tta-av" aria-hidden="true">A</span>'; row.append(el); return row; }
async function openChat(id) {
  CHAT = id; localStorage.setItem("it_chat", id || "");
  const c = CHATS.find((x) => x.id === id);
  $("chat-title").textContent = c ? c.title : "New conversation";
  $("chat-del").classList.toggle("hidden", !id);
  document.querySelectorAll("#chat-items .ci").forEach((x) => x.classList.toggle("on", +x.dataset.id === id));
  const log = $("chat-log"); log.innerHTML = "";
  if (id) for (const m of (await call("chat_get", { id })).messages) for (const el of renderMsg(m)) log.append(el.classList.contains("msg-b") ? bubble(m.role, el) : el);
  if (!log.children.length) emptyState(log);
  log.scrollTop = log.scrollHeight;
}
async function chatList(sel) {
  CHATS = (await call("chat_list")).chats || [];
  $("chat-items").innerHTML = CHATS.map((c) => `<div class="ci" data-id="${c.id}" role="button" tabindex="0"><span class="ci-t">${esc(c.title)}</span><span class="ci-m">${ago(c.updated_at)}</span>
    <button type="button" class="ci-x" data-cdel="${c.id}" title="Delete conversation" aria-label="Delete conversation">×</button></div>`).join("") || '<p class="fine pad">No conversations yet.</p>';
  const id = sel || +localStorage.getItem("it_chat") || (CHATS[0] && CHATS[0].id) || null;
  return CHATS.some((c) => c.id === id) ? id : (CHATS[0] && CHATS[0].id) || null;
}
async function deleteChat(id) {
  const c = CHATS.find((x) => x.id === id) || {};
  if (!(await confirmBox(`Delete “${c.title || "this conversation"}”?`, "The conversation and all its messages are removed permanently.", "Delete conversation"))) return;
  await call("chat_delete", { id, confirm: id });
  if (CHAT === id) { CHAT = null; localStorage.removeItem("it_chat"); }
  openChat(await chatList(CHAT));
}
$("chat-items").addEventListener("click", (e) => {
  const x = e.target.closest("[data-cdel]"); if (x) { e.stopPropagation(); deleteChat(+x.dataset.cdel).catch((err) => ($("msg").textContent = "Failed: " + err.message)); return; }
  const it = e.target.closest(".ci"); if (it) openChat(+it.dataset.id);
});
$("chat-del").onclick = () => CHAT && deleteChat(CHAT).catch((err) => ($("msg").textContent = "Failed: " + err.message));
$("chat-new").onclick = () => { CHAT = null; localStorage.removeItem("it_chat"); openChat(null); $("chat-in").focus(); };
$("chat-log").addEventListener("click", (e) => { const q = e.target.closest("[data-q]"); if (q) { $("chat-in").value = q.dataset.q; $("chat-form").requestSubmit(); } });
const grow = () => { const t = $("chat-in"); t.style.height = "auto"; t.style.height = Math.min(180, t.scrollHeight) + "px"; };
$("chat-in").addEventListener("input", grow);
$("chat-in").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chat-form").requestSubmit(); } });
$("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("chat-in").value.trim(); if (!text) return;
  const log = $("chat-log"); if (log.querySelector(".tta-empty")) log.innerHTML = "";
  $("chat-in").value = ""; grow();
  for (const el of renderMsg({ role: "user", content: [{ type: "text", text }] })) log.append(bubble("user", el));
  const w = document.createElement("div"); w.className = "msg-b assistant wait"; w.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  const wr = bubble("assistant", w); log.append(wr); log.scrollTop = log.scrollHeight;
  $("chat-form").classList.add("busy");
  try {
    const r = await call("chat_send", { chat_id: CHAT, text });
    const els = renderMsg(r.message).map((el) => (el.classList.contains("msg-b") ? bubble("assistant", el) : el));
    wr.replaceWith(...(els.length ? els : [bubble("assistant", Object.assign(document.createElement("div"), { className: "msg-b assistant", textContent: "(no reply)" }))]));
    if (r.chat_id !== CHAT) { CHAT = r.chat_id; localStorage.setItem("it_chat", CHAT); }
    await chatList(CHAT); document.querySelectorAll("#chat-items .ci").forEach((x) => x.classList.toggle("on", +x.dataset.id === CHAT));
    const c = CHATS.find((x) => x.id === CHAT); if (c) $("chat-title").textContent = c.title; $("chat-del").classList.remove("hidden");
  } catch (err) { w.classList.remove("wait"); w.textContent = "Auto couldn't answer just now. Try again."; }
  $("chat-form").classList.remove("busy");
  log.scrollTop = log.scrollHeight;
};

// ---------- confirm dialog ----------
function confirmBox(title, body, ok) {
  return new Promise((res) => {
    const d = document.createElement("dialog"); d.className = "cdlg";
    d.innerHTML = `<b>${esc(title)}</b><p class="fine">${esc(body)}</p><div class="row end"><button value="no" class="ghost">Cancel</button><button value="ok" class="danger-fill">${esc(ok)}</button></div>`;
    document.body.append(d);
    d.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { d.close(); res(b.value === "ok"); d.remove(); } else if (e.target === d) { d.close(); res(false); d.remove(); } });
    d.addEventListener("cancel", () => { res(false); d.remove(); });
    d.showModal();
  });
}

// ---------- live render settings ----------
let RS = null, RS_DEF = null, RS_SEED = 1;
const rsEls = () => [...document.querySelectorAll("#view-config input[type=range]")];
function rsRead() { const r = {}; rsEls().forEach((i) => (r[i.dataset.k] = +i.value)); return r; }
function rsDual(id, kmin, kmax) {
  const box = $(id), [a, b] = box.querySelectorAll("input"), lo = +a.min, hi = +a.max;
  if (+a.value > +b.value) { const t = a.value; a.value = b.value; b.value = t; }
  const p = (v) => ((v - lo) * 100) / (hi - lo);
  box.querySelector(".dual-fill").style.cssText = `left:${p(+a.value)}%;right:${100 - p(+b.value)}%`;
  return [+a.value, +b.value];
}
function rnd() { RS_SEED = (RS_SEED * 16807) % 2147483647; return RS_SEED / 2147483647; }
function rsDraw() {
  const [amin, amax] = rsDual("rs-auto"), [umin, umax] = rsDual("rs-user"), r = rsRead();
  $("rs-auto-v").textContent = amin === amax ? `${amin} strips` : `${amin}–${amax} strips`;
  $("rs-user-v").textContent = umin === umax ? `${umin} strips` : `${umin}–${umax} strips`;
  $("rs-seam-v").textContent = `${r.seam_px} px`; $("rs-str-v").textContent = r.bridge_strength.toFixed(2);
  const save = RS_SEED; RS_SEED = save;
  // example ribbon: alternate Auto and idea scenes; 1 strip = 256 px
  const S = 256, seq = [], kinds = ["auto", "auto", "user", "auto", "user", "auto", "auto", "user", "auto"];
  let x = 0, k = 0;
  while (x < 40 * S && k < 40) { const kind = kinds[k % kinds.length], [lo, hi] = kind === "user" ? [umin, umax] : [amin, amax];
    const w = lo + Math.floor(rnd() * (hi - lo + 1)); seq.push({ kind, x, w }); x += w * S; k++; }
  RS_SEED = save;
  const total = Math.min(x, 40 * S), sx = 960 / total, H = 120;
  const pal = { auto: ["#7d8fa8", "#8aa79a", "#a69077", "#9a86ab", "#7fa3a8"], user: ["#d58b4e"] };
  let out = "", ai = 0;
  for (const s of seq) {
    if (s.x >= total) break;
    const col = s.kind === "user" ? pal.user[0] : pal.auto[ai++ % pal.auto.length], w = Math.min(s.w * S, total - s.x) * sx;
    out += `<rect x="${s.x * sx}" y="18" width="${w}" height="${H - 36}" fill="${col}" opacity="${s.kind === "user" ? 0.85 : 0.55}"/>`;
    for (let j = 1; j < s.w && (s.x + j * S) < total; j++) out += `<line x1="${(s.x + j * S) * sx}" x2="${(s.x + j * S) * sx}" y1="18" y2="${H - 18}" stroke="rgba(0,0,0,.12)" stroke-width="1"/>`;
    if (w > 34) out += `<text x="${s.x * sx + 5}" y="13" font-size="10" fill="currentColor" opacity=".7">${s.kind === "user" ? "idea" : "Auto"} · ${s.w}</text>`;
    if (s.x > 0) {   // join: crossfade (seam_px) + repaint zone (+128 px into the new scene), strength = opacity
      const z = (r.seam_px + 128) * sx;
      out += `<rect x="${s.x * sx - r.seam_px * sx}" y="18" width="${z}" height="${H - 36}" fill="url(#hatch)" opacity="${0.25 + 0.75 * r.bridge_strength}"/>`;
      out += `<rect x="${s.x * sx - r.seam_px * sx}" y="${H - 16}" width="${r.seam_px * sx}" height="4" fill="#e9c46a"/>`;
    }
  }
  $("rs-prev").innerHTML = `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#fff" opacity=".55"/></pattern></defs>` + out;
  const avgA = (amin + amax) / 2, avgU = (umin + umax) / 2;
  $("rs-legend").innerHTML = `Example of ~40 strips. Hatched = join zone (repainted; denser = stronger). Yellow = crossfade. At ~3.5 s per strip, Auto scenes last ~${Math.round(avgA * 3.5)} s and ideas ~${Math.round(avgU * 3.5)} s on average.`;
  const dirty = RS && JSON.stringify(rsRead()) !== JSON.stringify(RS);
  $("rs-state").textContent = dirty ? "Unsaved changes" : RS ? "Saved · the pod picks this up within ~15 s" : "";
}
function rsSet(r) { rsEls().forEach((i) => { if (r[i.dataset.k] != null) i.value = r[i.dataset.k]; }); rsDraw(); }
async function renderView() {
  const d = await call("render_get"); RS_DEF = d.defaults; RS = { ...d.defaults, ...d.render };
  rsSet(RS); RS = rsRead(); rsDraw();
}
document.addEventListener("input", (e) => { if (e.target.closest && e.target.closest("#view-config")) rsDraw(); });
$("rs-reroll").onclick = () => { RS_SEED = (RS_SEED * 48271 + 7) % 2147483647 || 1; rsDraw(); };
$("rs-reset").onclick = () => RS_DEF && rsSet(RS_DEF);
$("rs-save").onclick = async () => {
  try { const r = await call("render_set", { render: rsRead() }); RS = { ...RS_DEF, ...r.render }; rsSet(RS); $("rs-state").textContent = "Saved · the pod picks this up within ~15 s"; }
  catch (err) { $("msg").textContent = "Failed: " + err.message; }
};

// ---------- views (sidebar / bottom nav) ----------
function show(v) {
  if (v === "render") v = "config";   // old link
  if (!document.getElementById("view-" + v)) v = "overview";
  document.querySelectorAll(".adm .view").forEach((x) => x.classList.toggle("on", x.id === "view-" + v));
  document.querySelectorAll(".side a[data-view]").forEach((a) => a.classList.toggle("on", a.dataset.view === v));
  if (v === "reliability" && token) opsView().catch((e) => ($("msg").textContent = "Error: " + e.message));
  if (v === "auto") { const l = $("chat-log"); l.scrollTop = l.scrollHeight; }
  if (v === "config" && token) renderView().catch((e) => ($("msg").textContent = "Error: " + e.message));
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
// keep the GPU switch's status fresh (off / starting / live) without reloading the whole overview
setInterval(() => { if (!document.hidden && OV && OV.gpu) call("gpu_status").then((w) => { if (w && w.state) { OV.gpu.switch = w; renderGpu(OV.gpu); } }).catch(() => {}); }, 15000);
