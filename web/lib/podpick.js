// Which RunPod pod should production adopt when its current pod is stopped or gone? Pure, so it is testable.
// Rule: only RUNNING pods, named a canonical name exactly or the canonical name plus a "-suffix" (RunPod migrations
// produce names like "tapestry-sdxl-migration"). Canonical names are RUNPOD_POD_NAME and the current pod's own name.
// Ties: a pod with runtime beats one still booting, then the shortest uptime (newest rental), then an exact name,
// then the lowest id, so the choice is deterministic.

function nameMatches(name, bases) {
  const n = String(name || "");
  return bases.some((b) => n === b || n.startsWith(b + "-"));
}

const uptime = (p) => (p.runtime && Number.isFinite(Number(p.runtime.uptimeInSeconds)) ? Number(p.runtime.uptimeInSeconds) : null);

function pickAdoptPod(pods, curId, canonicalName) {
  const cur = pods.find((p) => p.id === curId);
  if (cur && cur.desiredStatus === "RUNNING") return null;
  const bases = [...new Set([canonicalName, cur && cur.name].filter(Boolean))];
  const cands = pods.filter((p) => p.id !== curId && p.desiredStatus === "RUNNING" && nameMatches(p.name, bases));
  cands.sort((a, b) => {
    const ua = uptime(a), ub = uptime(b);
    if ((ua == null) !== (ub == null)) return ua == null ? 1 : -1;
    if (ua != null && ua !== ub) return ua - ub;
    const ea = bases.includes(a.name), eb = bases.includes(b.name);
    if (ea !== eb) return ea ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
  return cands[0] || null;
}

module.exports = { pickAdoptPod, nameMatches };
