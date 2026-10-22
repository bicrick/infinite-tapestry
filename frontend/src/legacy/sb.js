// One Supabase client for every page, with sessions that survive deploys, reloads and PWA launches.
// - storageKey is pinned (it equals supabase-js's default for this project, so nobody is signed out by it)
// - localStorage on our one origin; nothing here ever clears it on version changes
// - auto-refresh pauses in the background and resumes (with an immediate refresh check) on return
// - email links use the implicit flow so a link opened in another browser/app still signs that browser in
const CFG = window.TAPESTRY_CONFIG || {};
let clientP = null;
export function storageKey() {
  const ref = new URL(CFG.supabaseUrl).hostname.split(".")[0];
  return `sb-${ref}-auth-token`;
}
export function client() {
  if (clientP) return clientP;
  clientP = (async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit",
              storageKey: storageKey(), storage: window.localStorage,
              // No navigator.locks: its cross-tab lock could deadlock getSession after sleep/tab restore,
              // which hung the social boot (dead tabs, sign-in and enqueue). Token reuse is tolerated server-side.
              lock: async (_name, _timeout, fn) => await fn() },
    });
    const wake = () => { sb.auth.startAutoRefresh(); sb.auth.getSession().catch(() => {}); };
    document.addEventListener("visibilitychange", () => (document.visibilityState === "visible" ? wake() : sb.auth.stopAutoRefresh()));
    window.addEventListener("pageshow", (e) => { if (e.persisted) wake(); });
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    return sb;
  })();
  return clientP;
}
export const rememberEmail = (e) => { try { localStorage.setItem("it-email", e); } catch (_) {} };
export const lastEmail = () => { try { return localStorage.getItem("it-email") || ""; } catch (_) { return ""; } };
export async function googleEnabled() {
  try {
    const r = await fetch(`${CFG.supabaseUrl}/auth/v1/settings`, { headers: { apikey: CFG.supabaseAnonKey } });
    const j = await r.json();
    return !!(j.external && j.external.google);
  } catch (_) { return !!CFG.google; }
}
export const AUTH_ERR = (m) => {
  m = String(m || "");
  if (/rate limit|over_email_send_rate_limit|429/i.test(m)) return "Too many emails just now. Try again in a little while, or use Google.";
  if (/expired|invalid/i.test(m)) return "That code has expired or was already used. Send a new one.";
  return m || "Something went wrong. Try again.";
};
