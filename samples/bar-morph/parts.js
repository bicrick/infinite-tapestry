// DOM builders for the composer in both shapes. Every part is absolutely positioned at its resting slot so the
// morph never touches layout: it only animates transform and opacity.

export const G = { W: 560, H: 52, BTN: 40, TOP: 6, GAP: 2, INSET: 5, TEXT_X: 17, REF_X: 473, SEND_X: 515 };

const ICON = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
export const ARROW = ICON('<path d="M12 19V5M6 11l6-6 6 6"/>');
export const IMAGE = ICON('<rect x="4" y="5" width="16" height="14" rx="3"/><circle cx="9.5" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3 3L15 13l4 4"/>');

// Same glyphs and order as the timeline controls in static/unified.js.
export const CONTROLS = [
  ["zout", "Zoom out", '<path d="M5 12h14"/>'],
  ["zin", "Zoom in", '<path d="M5 12h14M12 5v14"/>'],
  ["prev", "Previous prompt", '<path d="M15 6l-6 6 6 6"/>'],
  ["play", "Play from here", '<path d="M8 6l10 6-10 6z"/>'],
  ["next", "Next prompt", '<path d="M9 6l6 6-6 6"/>'],
  ["cal", "Calendar and events", '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>'],
];
export const GROUP_W = CONTROLS.length * G.BTN + (CONTROLS.length - 1) * G.GAP;

export function el(tag, cls, html, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.append(e);
  return e;
}
export const at = (e, x) => { e.style.left = x + "px"; return e; };

export function bar(mount) {
  const dock = el("div", "dock", null, mount);
  return el("div", "bar", null, dock);
}

export const pill = (parent) => el("div", "glass pill", null, parent);

export function splitPill(parent) {
  return { shadow: el("div", "shadow", null, parent), l: el("div", "glass cap l", null, parent),
    mid: el("div", "glass mid", null, parent), r: el("div", "glass cap r", null, parent) };
}

export function field(parent, x = G.TEXT_X) {
  const f = el("textarea", "field lv", null, parent);
  Object.assign(f, { rows: 1, placeholder: "Where next?", spellcheck: false });
  f.setAttribute("aria-label", "Where next?");
  return at(f, x);
}
export const ghostField = (parent, x = G.TEXT_X) => at(el("div", "field ghost blur", "Where next?", parent), x);

export function refBtn(parent, x = G.REF_X, ghost = false) {
  const b = el(ghost ? "div" : "button", "icon ref lv" + (ghost ? " ghost blur" : ""), IMAGE, parent);
  if (!ghost) { b.type = "button"; b.title = "Add a reference image (optional)"; }
  return at(b, x);
}

export function control(parent, [id, title, d], x, ghost = false) {
  const b = el(ghost ? "div" : "button", "icon tl" + (ghost ? " ghost blur" : ""), ICON(d), parent);
  if (!ghost) { b.type = "button"; b.dataset.ctl = id; b.title = title; b.setAttribute("aria-label", title); }
  return at(b, x);
}

export function liveLabel(parent, ghost = false) {
  return el("span", "live-label tl" + (ghost ? " blur" : ""), "Live", parent);
}

export function send(parent, x = G.SEND_X) {
  const b = at(el("button", "icon send", null, parent), x);
  b.type = "button"; b.setAttribute("aria-label", "Send");
  const arrow = el("span", null, ARROW, b), dot = el("i", "dot", null, b);
  arrow.style.display = "grid";
  return { btn: b, arrow, dot };
}

// Overflow window whose visible span is moved by translating the window one way and its content the other,
// so the content stays put while the clip edge sweeps across it (no width or clip-path animation).
export function sweepWindow(parent, x, w) {
  const win = at(el("div", "win", null, parent), x);
  Object.assign(win.style, { top: G.TOP + "px", width: w + "px", height: G.BTN + "px" });
  const inner = el("div", "win-in", null, win);
  Object.assign(inner.style, { position: "absolute", left: 0, top: 0, width: w + "px", height: G.BTN + "px" });
  return { win, inner, x };
}

export function measure(e) { return e.getBoundingClientRect().width; }
