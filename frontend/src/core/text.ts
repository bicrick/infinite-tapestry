// Small text helpers shared by the viewer chrome.
export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

// Who suggested a scene: '@handle', 'a guest' or 'Auto'. The owner is never credited (shown as Auto).
// Owner/system handles are never shown: they read as "Someone" (a user idea is never labelled Auto).
const HIDDEN = new Set(["bicrick", "auto"]);
export function credit(by: unknown, origin?: string | null, opts?: { guestNames?: boolean }): string {
  if (origin === "auto") return "Auto";
  const all = String(by || "").split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);
  const hs = all.filter((h) => !HIDDEN.has(h.toLowerCase()));
  if (!hs.length) return all.length ? "Someone" : (origin === "user" ? "a guest" : "Auto");
  const guestNames = opts && opts.guestNames;
  return hs.map((h) => (/^[a-z]+-\d{4}$/.test(h) ? (guestNames ? h : "a guest") : "@" + h)).filter((v, i, a) => a.indexOf(v) === i).join(", ");
}

// Image-only ideas read "an image from X"; text ideas show the user's own words.
export function ideaTitle(text: unknown, by: unknown, _image?: unknown): string {
  const t = String(text || "").trim();
  if (!t || /^inspired by this image$/i.test(t)) return "an image from " + credit(by, "user", { guestNames: true });
  return t.length > 120 ? t.slice(0, 119) + "…" : t;
}

export function srcLabel(by: unknown, origin?: string | null): string {
  const c = credit(by, origin);
  return c === "Auto" ? "✦ Auto" : by ? "by " + c : origin === "user" ? "Audience" : "Now";
}

export function fmtTime(t: number | null | undefined, now: Date = new Date()): string {
  if (t == null) return "";
  const d = new Date(t * 1000);
  const hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + hm;
}

/** View date line: "Today · 1:58 AM", "Yesterday · …", "Oct 21 · 1:58 AM", other years "Oct 21, 2025 · 1:58 AM" (viewer's local zone). */
export function fmtWhen(t: number | null | undefined, now: Date = new Date()): string {
  if (t == null || !Number.isFinite(t)) return "";
  const d = new Date(t * 1000);
  const hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  const date = diff === 0 ? "Today" : diff === 1 ? "Yesterday"
    : d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return date + " · " + hm;
}

// "Back to live" pill: how far back the view is.
export function agoText(t: number | null, nowSec: number, fmt: (t: number) => string = (x) => fmtTime(x)): string {
  if (t == null) return "";
  const m = Math.max(0, (nowSec - t) / 60);
  return m < 1.5 ? "" : m < 60 ? Math.round(m) + " min ago" : m < 36 * 60 ? (m / 60 < 10 ? (m / 60).toFixed(1).replace(/\.0$/, "") : Math.round(m / 60)) + " h ago" : fmt(t);
}
