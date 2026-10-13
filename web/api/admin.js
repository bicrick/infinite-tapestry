// Admin-only moderation for guest ideas: recent submissions, one-click bans, shadow-mute,
// and the sign-in-only kill switch. Auth: the verified Supabase email must be in ADMIN_EMAILS (adminFromToken); anyone else gets an empty 403.
const UI = require("./_admin_ui.json");
const stories = require("../lib/stories");
const chat = require("../lib/autochat");
const { env, rest, adminFromToken, audit, runpod, MIN_BALANCE, POD, loadPod, adoptPod, podStart, podStop } = require("../lib/common");
const SB = () => env("SUPABASE_URL").replace(/\/$/, "");
const svc = () => ({ apikey: env("SUPABASE_SERVICE_ROLE_KEY"), authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY") });
const DESIRED = new Set(["on", "off", "auto"]);
const SHA = /^[0-9a-f]{40}$/;

async function gpu() {
  await loadPod(true);
  await adoptPod().catch(() => null);
  const id = POD();
  const [d, ps, last] = await Promise.all([
    runpod(`query { myself { clientBalance currentSpendPerHr } pod(input: {podId: "${id}"}) { id name desiredStatus costPerHr lastStatusChange machineId runtime { uptimeInSeconds } machine { gpuDisplayName location } } }`).catch(() => null),
    rest("GET", "pod_state?id=eq.1&select=status,desired,note,updated_at,last_error,pod_id").catch(() => []),
    rest("GET", "strips?order=idx.desc&limit=1&select=idx,created_at").catch(() => []),
  ]);
  const p = d && d.pod;
  const bal = d && d.myself ? Number(d.myself.clientBalance) : null;
  const rate = p ? Number(p.costPerHr) : null;
  const running = p && p.desiredStatus === "RUNNING";
  const spend = d && d.myself ? Number(d.myself.currentSpendPerHr) : null;
  const floor = MIN_BALANCE();
  return { id, name: p && p.name, pod: p ? p.desiredStatus : "UNKNOWN", gpu: p && p.machine ? p.machine.gpuDisplayName : null,
    location: p && p.machine ? p.machine.location : null, machine: p && p.machineId, uptime_s: p && p.runtime ? p.runtime.uptimeInSeconds : null,
    last_change: p && p.lastStatusChange, last_strip_at: last[0] && last[0].created_at, last_strip: last[0] && last[0].idx,
    balance: bal, rate_per_hr: rate, spend_per_hr: spend, floor,
    hours_left: bal != null && rate ? Math.max(0, (bal - floor) / rate) : null, burning: !!(running || (spend && spend > 0.05)),
    start_enabled: env("CONTROLLER_ENABLE_START") === "1", console_url: `https://console.runpod.io/pods?id=${id}`,
    state: ps[0] || null };
}
async function storageList(prefix) {
  const r = await fetch(`${SB()}/storage/v1/object/list/deploy`, { method: "POST", headers: { ...svc(), "content-type": "application/json" },
    body: JSON.stringify({ prefix, limit: 100, sortBy: { column: "created_at", order: "desc" } }) });
  return r.ok ? r.json() : [];
}
async function latestRelease() {
  const r = await fetch(`${SB()}/storage/v1/object/deploy/worker/latest.txt?t=${Date.now()}`, { headers: svc() });
  return r.ok ? (await r.text()).trim().slice(0, 40) : null;
}
async function viewers() {
  const pod = await loadPod(); if (!pod) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
  try { const r = await fetch(`https://${pod}-8000.proxy.runpod.net/health`, { signal: ctl.signal }); return r.ok ? (await r.json()).viewers ?? null : null; }
  catch (_) { return null; } finally { clearTimeout(t); }
}
const LIMIT_KEYS = ["guests_enabled", "guest_per_10min", "guest_max_pending", "ip_per_10min", "ip_max_pending", "brake_pending", "turnstile_required", "shadow_after_strikes", "per_minute", "max_pending"];

module.exports = async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const me = tok ? await adminFromToken(tok).catch(() => null) : null;
  if (!me) return res.status(403).end();
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const a = body.action || "recent";
  try {
    if (a === "ui") return res.status(200).json(UI);
    if (a === "gpu_start" || a === "gpu_stop") {   // immediate start/stop (also sets desired so the controller agrees)
      await loadPod(true);
      const on = a === "gpu_start";
      await rest("PATCH", "pod_state?id=eq.1", { desired: on ? "on" : "off", updated_at: new Date().toISOString() }, { prefer: "return=minimal" });
      await audit(on ? "admin_gpu_start" : "admin_gpu_stop", { actor: me.id, target: POD() });
      try { if (on) await podStart(); else await podStop(); }
      catch (e) { return res.status(200).json({ ok: false, error: e.message, detail: e.detail || String(e.message).slice(0, 300) }); }
      return res.status(200).json({ ok: true, gpu: await gpu() });
    }
    if (a === "gpu_pod_id") {   // {pod_id}: point everything at another pod (e.g. after a RunPod migration)
      const id = String(body.pod_id || "").trim();
      if (!/^[a-z0-9]{8,24}$/.test(id)) return res.status(400).json({ error: "bad_pod_id" });
      await rest("PATCH", "pod_state?id=eq.1", { pod_id: id }, { prefer: "return=minimal" });
      await audit("admin_pod_id", { actor: me.id, target: id, detail: { from: POD() } });
      await loadPod(true);
      return res.status(200).json({ ok: true, gpu: await gpu() });
    }
    if (a === "stories") return res.status(200).json(await stories.library());
    if (a === "story_save") return res.status(200).json({ story: await stories.save(body.story || {}) });
    if (a === "story_archive") { await rest("PATCH", `stories?id=eq.${Number(body.id)}`, { archived: true }, { prefer: "return=minimal" }); return res.status(200).json({ ok: true }); }
    if (a === "playlist_add") {   // {story_id} or {story: {...}} (saved first), when: now|next|end
      const sid = body.story_id || (await stories.save(body.story || {})).id;
      const row = await stories.enqueue(sid, body.when);
      await audit("admin_story", { actor: me.id, target: String(sid), detail: { when: body.when || "end" } });
      return res.status(200).json({ row });
    }
    if (a === "playlist_remove") { await stories.remove(body.id); return res.status(200).json({ ok: true }); }
    if (a === "playlist_move") { await stories.move(body.id, body.dir); return res.status(200).json({ ok: true }); }
    if (a === "chat_list") return res.status(200).json({ chats: await chat.chats() });
    if (a === "chat_get") return res.status(200).json({ messages: await chat.messages(body.id) });
    if (a === "chat_new") return res.status(200).json({ chat: await chat.newChat() });
    if (a === "chat_send") {
      try { return res.status(200).json(await chat.send(body.chat_id, body.text)); }
      catch (e) { return res.status(502).json({ error: e.message === "empty" ? "empty" : "auto_unavailable" }); }
    }
    if (a === "recent") {
      const [ideas, shadow, sessions, bans, limits] = await Promise.all([
        rest("GET", "ideas?guest_id=not.is.null&order=created_at.desc&limit=60&select=id,handle,body,status,created_at,guest_id,ip_hash,fp_hash"),
        rest("GET", "shadow_ideas?order=created_at.desc&limit=30&select=id,handle,body,reason,created_at,guest_id,ip_hash,fp_hash"),
        rest("GET", "guest_sessions?order=last_seen.desc&limit=60&select=id,handle,strikes,shadow,banned,ip_hash,fp_hash,last_seen"),
        rest("GET", "guest_bans?order=created_at.desc&limit=100"),
        rest("GET", "idea_limits?id=eq.1"),
      ]);
      return res.status(200).json({ ideas, shadow, sessions, bans, limits: limits[0] });
    }
    if (a === "overview") {
      const [g, cfg, usage, fuel, v, rel, files, deploys, reports, ideas, sanctions] = await Promise.all([
        gpu(), rest("GET", "auto_config?id=eq.1"), rest("POST", "rpc/admin_usage", {}), rest("GET", "fuel_status?select=balance_cents"),
        viewers(), latestRelease(), storageList("worker/"),
        rest("GET", "deploy_log?order=created_at.desc&limit=20"),
        rest("GET", "reports?order=created_at.desc&limit=50&status=eq.open&select=id,idea_id,strip_a,strip_b,reason,created_at,ideas(body,handle,status,user_id,guest_id)"),
        rest("GET", "ideas?status=in.(pending,playing)&order=created_at.desc&limit=100&select=id,handle,body,status,votes,created_at,user_id,guest_id"),
        rest("GET", "sanctions?or=(until.is.null,until.gt.now())&order=created_at.desc&limit=50&select=id,user_id,kind,until,reason,created_at"),
      ]);
      const releases = (files || []).filter((f) => /^[0-9a-f]{40}\.tgz$/.test(f.name)).map((f) => ({ sha: f.name.slice(0, 40), at: f.created_at, size: f.metadata && f.metadata.size }));
      const { MOODS } = require("../lib/moods.json");
      return res.status(200).json({ gpu: g, auto: cfg[0], moods: MOODS, usage, fuel_cents: fuel[0] ? Number(fuel[0].balance_cents) : null, viewers: v,
        release: rel, releases, deploys, reports, ideas, sanctions, vercel_url: "https://vercel.com/bicricks-projects/infinite-tapestry-app/deployments" });
    }
    if (a === "gpu_set") {   // {desired: on|off|auto, dry?}: writes the desired state; the 5-minute controller acts on it
      if (!DESIRED.has(body.desired)) return res.status(400).json({ error: "bad" });
      if (body.dry) return res.status(200).json({ ok: true, dry: true, would: { desired: body.desired } });
      await rest("PATCH", "pod_state?id=eq.1", { desired: body.desired, updated_at: new Date().toISOString(), note: `admin: desired ${body.desired}` }, { prefer: "return=minimal" });
      await audit("admin_gpu_desired", { actor: me.id, target: POD(), detail: { desired: body.desired } });
      return res.status(200).json({ ok: true, gpu: await gpu() });
    }
    if (a === "auto_set") {  // {paused, theme, minutes, mood_weights}
      const patch = { updated_at: new Date().toISOString(), updated_by: me.id };
      if ("paused" in body) patch.paused = !!body.paused;
      if ("theme" in body) {
        const t = String(body.theme || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
        patch.theme = t || null;
        patch.theme_until = t ? new Date(Date.now() + Math.max(5, Math.min(1440, Number(body.minutes) || 60)) * 60000).toISOString() : null;
      }
      if (body.mood_weights && typeof body.mood_weights === "object") {
        const w = {}; for (const [k, v] of Object.entries(body.mood_weights)) if (k.length <= 40) w[k] = Math.max(0, Math.min(50, Number(v) || 0));
        patch.mood_weights = w;
      }
      await rest("PATCH", "auto_config?id=eq.1", patch, { prefer: "return=minimal" });
      await audit("admin_auto", { actor: me.id, detail: patch });
      return res.status(200).json({ ok: true });
    }
    if (a === "idea") {      // {id, op: reject|remove}
      const id = Number(body.id); if (!id || !["reject", "remove"].includes(body.op)) return res.status(400).json({ error: "bad" });
      await rest("PATCH", `ideas?id=eq.${id}&status=in.(pending,playing)`, { status: body.op === "reject" ? "rejected" : "withdrawn" }, { prefer: "return=minimal" });
      await audit("admin_idea_" + body.op, { actor: me.id, target: String(id) });
      return res.status(200).json({ ok: true });
    }
    if (a === "sanction") {  // {user_id, kind: mute|ban, minutes}
      if (!/^[0-9a-f-]{36}$/.test(String(body.user_id)) || !["mute", "ban"].includes(body.kind)) return res.status(400).json({ error: "bad" });
      const m = Number(body.minutes) || 0;
      await rest("POST", "sanctions", { user_id: body.user_id, kind: body.kind, until: m > 0 ? new Date(Date.now() + m * 60000).toISOString() : null, reason: "admin", by_user: me.id }, { prefer: "return=minimal" });
      if (body.kind === "ban") await rest("PATCH", `ideas?user_id=eq.${body.user_id}&status=eq.pending`, { status: "rejected" }, { prefer: "return=minimal" });
      await audit("admin_" + body.kind, { actor: me.id, target: body.user_id, detail: { minutes: m } });
      return res.status(200).json({ ok: true });
    }
    if (a === "unsanction") {
      const id = Number(body.id); if (!id) return res.status(400).json({ error: "bad" });
      await rest("PATCH", `sanctions?id=eq.${id}`, { until: new Date().toISOString() }, { prefer: "return=minimal" });
      await audit("admin_unsanction", { actor: me.id, target: String(id) });
      return res.status(200).json({ ok: true });
    }
    if (a === "report") {    // {id, status: resolved|dismissed}
      const id = Number(body.id); if (!id || !["resolved", "dismissed"].includes(body.status)) return res.status(400).json({ error: "bad" });
      await rest("PATCH", `reports?id=eq.${id}`, { status: body.status }, { prefer: "return=minimal" });
      return res.status(200).json({ ok: true });
    }
    if (a === "rollback") {  // {sha, confirm: sha}: repoint the pod release pointer; the pod picks it up on its next restart
      const sha = String(body.sha || "");
      if (!SHA.test(sha) || body.confirm !== sha) return res.status(400).json({ error: "confirm" });
      const files = await storageList("worker/");
      if (!files.some((f) => f.name === sha + ".tgz")) return res.status(404).json({ error: "no_release" });
      const r = await fetch(`${SB()}/storage/v1/object/deploy/worker/latest.txt`, { method: "PUT",
        headers: { ...svc(), "content-type": "text/plain", "x-upsert": "true", "cache-control": "no-cache" }, body: sha });
      if (!r.ok) return res.status(500).json({ error: "write_failed" });
      await rest("POST", "deploy_log", { kind: "rollback", sha, note: `admin rollback by ${me.handle || me.id}` }, { prefer: "return=minimal" });
      await audit("admin_release_rollback", { actor: me.id, target: sha });
      return res.status(200).json({ ok: true, release: sha });
    }
    if (a === "ban") {   // {kind: session|ip|fp, value}
      if (!["session", "ip", "fp"].includes(body.kind) || !body.value) return res.status(400).json({ error: "bad" });
      await rest("POST", "guest_bans", { kind: body.kind, value: String(body.value), reason: body.reason || "admin" }, { prefer: "resolution=ignore-duplicates,return=minimal" });
      if (body.kind === "session") await rest("PATCH", `guest_sessions?id=eq.${encodeURIComponent(body.value)}`, { banned: true }, { prefer: "return=minimal" });
      // drop their waiting ideas
      const col = body.kind === "session" ? "guest_id" : body.kind === "ip" ? "ip_hash" : "fp_hash";
      await rest("PATCH", `ideas?${col}=eq.${encodeURIComponent(body.value)}&status=eq.pending`, { status: "rejected" }, { prefer: "return=minimal" });
      await audit("admin_ban", { actor: me.id, target: body.kind + ":" + body.value });
      return res.status(200).json({ ok: true });
    }
    if (a === "unban") {
      await rest("DELETE", `guest_bans?kind=eq.${encodeURIComponent(body.kind)}&value=eq.${encodeURIComponent(body.value)}`, undefined, { prefer: "return=minimal" });
      if (body.kind === "session") await rest("PATCH", `guest_sessions?id=eq.${encodeURIComponent(body.value)}`, { banned: false }, { prefer: "return=minimal" });
      await audit("admin_unban", { actor: me.id, target: body.kind + ":" + body.value });
      return res.status(200).json({ ok: true });
    }
    if (a === "shadow") {   // {session, on}
      await rest("PATCH", `guest_sessions?id=eq.${encodeURIComponent(body.session)}`, { shadow: !!body.on }, { prefer: "return=minimal" });
      if (body.on) await rest("PATCH", `ideas?guest_id=eq.${encodeURIComponent(body.session)}&status=eq.pending`, { status: "rejected" }, { prefer: "return=minimal" });
      await audit("admin_shadow", { actor: me.id, target: body.session, detail: { on: !!body.on } });
      return res.status(200).json({ ok: true });
    }
    if (a === "limits") {   // {limits: {...}}  e.g. {guests_enabled:false} = sign-in only
      const patch = {}; for (const k of LIMIT_KEYS) if (body.limits && k in body.limits) patch[k] = body.limits[k];
      await rest("PATCH", "idea_limits?id=eq.1", patch, { prefer: "return=minimal" });
      await audit("admin_limits", { actor: me.id, detail: patch });
      return res.status(200).json({ ok: true });
    }
    res.status(400).json({ error: "unknown_action" });
  } catch (e) { console.error("admin", e.message); res.status(500).json({ error: "server" }); }
};
