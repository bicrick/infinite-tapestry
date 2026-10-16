// One GPU switch. pod_state.desired is the single source of truth:
//   on  -> keep a RUNNING tapestry-sdxl* pod with a healthy worker: resume the recorded pod; if RunPod has no free
//          GPU on its host (or the pod is gone), create a replacement pod that boots the worker by itself
//          (dockerStartCmd below), point pod_state.pod_id at it and leave the old pod EXITED.
//   off -> stop the recorded pod; the site falls back to replay.
// Used by the admin switch, scripts/gpu.sh (x-gpu-secret) and the 5-minute controller (reconcile in common.js).
const { env, rest, runpod, audit, POD, loadPod, adoptPod, podStart, podStop } = require("./common");

const GPU_TYPES = ["NVIDIA GeForce RTX 4090", "NVIDIA RTX A5000", "NVIDIA GeForce RTX 3090", "NVIDIA L4"];
const IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04";
// Public half of the ops SSH key (~/.ssh/rp_tapestry on the ops box), so replacement pods stay reachable for debugging.
const SSH_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDp57zMh4aousl6AeuPp8rZOinwFnkIVKy+wc+NqGLri box-tapestry";
const POD_ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TAPESTRY_ANTHROPIC_API_KEY", "RUNPOD_API_KEY",
  "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL", "R2_BUCKET", "TAPESTRY_SDXL_MODEL"];
const POD_FIXED = { TAPESTRY_BACKEND: "sdxl", TAPESTRY_STORAGE_PREFIX: "live-sdxl", TAPESTRY_GPU_CENTS_PER_HOUR: "89",
  TAPESTRY_SITE_URL: "https://infinitetapestry.app" };

// Container start command for replacement pods: pull the newest CI worker release from the private Supabase `deploy`
// bucket, run its scripts/pod/selfboot.sh in the background (env file, run.sh, deps, supervisor), and hand PID 1 to the
// image's normal /start.sh (SSH etc.). Runs again on every resume, so a restarted pod also picks up the newest release.
const BOOT = 'B="$SUPABASE_URL/storage/v1/object/deploy/worker"; A="apikey: $SUPABASE_SERVICE_ROLE_KEY"; Z="Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"; ' +
  '( for i in 1 2 3 4 5 6; do S=$(curl -sf -H "$A" -H "$Z" "$B/latest.txt?t=$(date +%s)" | tr -dc a-f0-9 | head -c 40); ' +
  '[ -n "$S" ] && mkdir -p /root/releases/$S && curl -sf -H "$A" -H "$Z" "$B/$S.tgz" | tar xz -C /root/releases/$S && break; sleep 10; done; ' +
  'bash /root/releases/$S/scripts/pod/selfboot.sh "$S" >> /root/selfboot.log 2>&1 ) & exec /start.sh';

function podEnv(e = process.env) {
  const out = { PUBLIC_KEY: SSH_PUB };
  for (const k of POD_ENV_KEYS) if (e[k]) out[k] = e[k];
  Object.assign(out, POD_FIXED);
  if (!out.R2_ACCESS_KEY_ID) out.TAPESTRY_R2 = "0";
  return out;
}
const replacementName = (now = new Date()) => "tapestry-sdxl-" + now.toISOString().slice(2, 16).replace(/[-T:]/g, "");

async function runpodRest(method, path, body) {
  const r = await fetch(`https://rest.runpod.io/v1${path}`, { method, headers: { authorization: "Bearer " + env("RUNPOD_API_KEY"), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (_) {}
  if (!r.ok) throw new Error(`runpod ${r.status}: ${(j && (j.error || j.message)) || txt.slice(0, 200)}`);
  return j;
}

async function createReplacement(reason) {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RUNPOD_API_KEY"].filter((k) => !env(k));
  if (missing.length) throw new Error("replacement needs env " + missing.join(","));
  const old = POD();
  const p = await runpodRest("POST", "/pods", { name: replacementName(), imageName: IMAGE, gpuTypeIds: GPU_TYPES, gpuTypePriority: "custom",
    gpuCount: 1, cloudType: "SECURE", containerDiskInGb: 60, volumeInGb: 0, ports: ["8000/http", "22/tcp"], minRAMPerGPU: 24,
    env: podEnv(), dockerStartCmd: ["bash", "-c", BOOT] });
  await rest("PATCH", "pod_state?id=eq.1", { pod_id: p.id, last_error: null, updated_at: new Date().toISOString(), note: `replacement ${p.id} for ${old} (${reason})` }, { prefer: "return=minimal" });
  await audit("pod_replace", { target: p.id, detail: { from: old, reason, cost_per_hr: p.costPerHr, gpu: p.gpu && p.gpu.displayName } });
  await loadPod(true);
  return p.id;
}

async function podInfo(id) {
  const d = await runpod(`query { pod(input: {podId: "${id}"}) { id name desiredStatus costPerHr runtime { uptimeInSeconds } machine { gpuDisplayName } } }`).catch(() => null);
  return d && d.pod;
}
async function health(id) {
  if (!id) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000);
  try { const r = await fetch(`https://${id}-8000.proxy.runpod.net/health`, { signal: ctl.signal }); return r.ok ? await r.json().catch(() => ({})) : null; }
  catch (_) { return null; } finally { clearTimeout(t); }
}

/** Make reality match desired=on. Returns the action taken. */
async function ensureOn(reason) {
  await loadPod(true);
  await adoptPod().catch(() => null);
  const p = await podInfo(POD());
  if (p && p.desiredStatus === "RUNNING") return "none";
  if (p) {
    try { await podStart(); return "start"; }
    catch (e) { if (e.message !== "no_gpu_on_host") return "start_failed:" + (e.detail || e.message); }
  }
  const id = await createReplacement(p ? "no free GPU on host" : "pod missing");
  return "replace:" + id;
}
async function ensureOff() {
  await loadPod(true);
  const p = await podInfo(POD());
  if (p && p.desiredStatus === "RUNNING") { await podStop(); return "stop"; }
  return "none";
}

/** off | starting | live | stopping, from desired + RunPod state + worker /health. */
function phase(desired, podStatusStr, healthy) {
  const running = podStatusStr === "RUNNING";
  if (desired === "off") return running ? "stopping" : "off";
  return running && healthy ? "live" : "starting";
}
async function status() {
  await loadPod(true);
  const [ps] = await rest("GET", "pod_state?id=eq.1&select=desired,status,note,last_error,pod_id,updated_at").catch(() => [null]);
  const id = POD();
  const [p, h] = await Promise.all([podInfo(id), health(id)]);
  const desired = ps && ps.desired === "off" ? "off" : "on";
  return { state: phase(desired, p && p.desiredStatus, !!h), desired, pod_id: id, pod_name: p && p.name, runpod: p ? p.desiredStatus : "UNKNOWN",
    gpu: p && p.machine ? p.machine.gpuDisplayName : null, uptime_s: p && p.runtime ? p.runtime.uptimeInSeconds : null,
    rate_per_hr: p ? Number(p.costPerHr) : null, strip_index: h ? h.strip_index ?? null : null, viewers: h ? h.viewers ?? null : null,
    note: ps && ps.note, last_error: ps && ps.last_error };
}
async function setDesired(on, actor, via) {
  await rest("PATCH", "pod_state?id=eq.1", { desired: on ? "on" : "off", updated_at: new Date().toISOString(), note: `${via}: switched ${on ? "on" : "off"}` }, { prefer: "return=minimal" });
  await audit(on ? "gpu_on" : "gpu_off", { actor, target: POD(), detail: { via } });
  const action = on ? await ensureOn(via) : await ensureOff();
  const st = await status();
  // keep pod_state.status in step so /api/live (and the replay/live choice in clients) reacts without waiting for the cron
  await rest("PATCH", "pod_state?id=eq.1", { status: st.runpod === "RUNNING" ? "running" : on ? "waking" : "sleeping",
    note: `${via}: switched ${on ? "on" : "off"}, action ${action}` }, { prefer: "return=minimal" }).catch(() => {});
  return { action, ...st };
}

module.exports = { podEnv, replacementName, phase, status, setDesired, ensureOn, ensureOff, createReplacement, BOOT, GPU_TYPES };
