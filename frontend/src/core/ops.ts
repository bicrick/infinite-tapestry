// Reliability telemetry: sampled (1 in 2 tabs), anonymous (random per-tab id), batched, beacon on hide.
import "./globals";

export function installOps(): void {
  const on = Math.random() < 0.5 && !/[?&]noops/.test(location.search), q: unknown[] = [];
  const sid = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);
  const build = String((window.TAPESTRY_CONFIG || {}).buildId || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
  const flush = () => {
    if (!q.length) return;
    const body = JSON.stringify({ sid, events: q.splice(0, 10) });
    try { if (!(navigator.sendBeacon && navigator.sendBeacon("/api/ops", new Blob([body], { type: "application/json" })))) fetch("/api/ops", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {}); } catch (_) { /* ignore */ }
  };
  setInterval(flush, 30000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  addEventListener("pagehide", flush);
  window.TapestryOps = { report(type, ms, d) { if (!on || q.length > 30) return; q.push({ type, at: Date.now() - (ms || 0), ms: ms == null ? null : Math.round(ms), d: Object.assign({ build, hidden: document.hidden ? "1" : "0" }, d || {}) }); }, flush };
}
