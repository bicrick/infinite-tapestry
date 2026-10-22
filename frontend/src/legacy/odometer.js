// Odometer: each digit is a vertical 0–9 strip (doubled so it can roll either way); only changed digits roll.
(() => {
  const RM = matchMedia("(prefers-reduced-motion: reduce)");
  const DUR = 450;
  function Odometer(el, opts = {}) {
    el.classList.add("odo");
    el.setAttribute("aria-live", "off"); el.setAttribute("role", "img");
    const wait = opts.debounce ?? 1000;
    let shown = null, pending = null, timer = 0, lastAt = 0;
    const digits = [];   // { box, strip, d }
    const mkDigit = () => {
      const box = document.createElement("span"); box.className = "odo-d";
      const strip = document.createElement("span"); strip.className = "odo-s";
      strip.textContent = "01234567890123456789".split("").join("\n");
      box.setAttribute("aria-hidden", "true"); box.appendChild(strip);
      return { box, strip, d: 0 };
    };
    const place = (g, cell, anim) => {
      g.strip.style.transition = anim && !RM.matches ? `transform ${DUR}ms cubic-bezier(.2,.8,.2,1)` : "none";
      g.strip.style.transform = `translateY(${-cell * 5}%)`;   // 20 cells → 5% each
    };
    function fit() {   // smooth width when the digit count changes
      const w = digits.reduce((s, g) => s + g.box.getBoundingClientRect().width, 0);
      el.style.width = w ? w + "px" : "";
    }
    function render(n) {
      const s = String(Math.max(0, Math.floor(n)));
      const up = shown == null || n >= shown;
      const first = shown == null;
      // add/remove leading digits
      while (digits.length < s.length) {
        const g = mkDigit(); digits.unshift(g); el.insertBefore(g.box, el.firstChild);
        place(g, 0, false);
        if (!first && !RM.matches) { g.box.classList.add("enter"); requestAnimationFrame(() => requestAnimationFrame(() => g.box.classList.remove("enter"))); }
      }
      while (digits.length > s.length) {
        const g = digits.shift();
        if (RM.matches) { g.box.remove(); continue; }
        g.box.classList.add("leave"); g.box.style.position = "absolute"; g.box.style.left = "0";
        setTimeout(() => g.box.remove(), DUR);
      }
      s.split("").forEach((ch, i) => {
        const g = digits[i], to = +ch, from = g.d;
        if (first || to === from) { if (first) place(g, to, false); g.d = to; return; }
        const start = up ? from : from + 10;
        const end = up ? (to > from ? to : to + 10) : (to < from ? to + 10 : to);
        place(g, start, false);
        void g.strip.offsetHeight;   // commit the start cell
        g.box.classList.add("rolling");
        place(g, end, true);
        setTimeout(() => { g.box.classList.remove("rolling"); place(g, to, false); }, DUR + 20);
        g.d = to;
      });
      el.setAttribute("aria-label", s);
      shown = n;
      requestAnimationFrame(fit);
    }
    return {
      set(n) {
        n = Number(n) || 0;
        if (n === shown && pending == null) return;
        pending = n;
        const now = performance.now();
        const due = shown == null ? 0 : Math.max(0, wait - (now - lastAt));
        clearTimeout(timer);
        timer = setTimeout(() => { const v = pending; pending = null; lastAt = performance.now(); if (v !== shown) render(v); }, due);
      },
      get value() { return shown; },
    };
  }
  window.Odometer = Odometer;
})();
