// Captions credit, same rules as client.js credit(): "Auto" for auto scenes, never the owner's handle ("Someone" when
// only hidden handles), guests as "a guest". Never "Claude".
(() => {
  "use strict";
  const HIDDEN = new Set(["bicrick", "auto"]);
  window.Tapestry.credit = function credit(by, origin, opts) {
    if (origin === "auto") return "Auto";
    const all = String(by || "").split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);
    const hs = all.filter((h) => !HIDDEN.has(h.toLowerCase()));
    if (!hs.length) return all.length ? "Someone" : origin === "user" ? "a guest" : "Auto";
    return hs.map((h) => (/^[a-z]+-\d{4}$/.test(h) ? (opts && opts.guestNames ? h : "a guest") : "@" + h)).filter((v, i, a) => a.indexOf(v) === i).join(", ");
  };
})();
