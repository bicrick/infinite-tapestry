// Designed 1200x630 link-preview cards (World Labs-style minimalism) over real tapestry crops.
// One source of truth for the static variants (pre-rendered) and the live /api/og cards.
const fs = require("fs"), path = require("path");

const font = (w) => fs.readFileSync(path.join(__dirname, "fonts", `inter-${w}.woff`));
const FONTS = [300, 400, 500].map((w) => ({ name: "Inter", data: font(w), weight: w, style: "normal" }));
const MARK = "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="2 14 60 36"><g fill="none" stroke-linecap="round">
<path d="M32 32c5-7 9-10 14-10a10 10 0 0 1 0 20c-5 0-9-3-14-10C27 25 23 22 18 22a10 10 0 0 0 0 20c5 0 9-3 14-10" stroke="#efe9df" stroke-width="3.2"/></g></svg>`).toString("base64");

const h = (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children } });
const INK = "#f3eee6", DIM = "rgba(243,238,230,0.72)", BG = "#0b0b0d";

const brand = (size = 26) => h("div", { style: { display: "flex", alignItems: "center", gap: 14 } },
  h("img", { src: MARK, width: size * 1.67, height: size }),
  h("div", { style: { fontSize: size * 0.92, fontWeight: 500, color: INK, letterSpacing: -0.2 } }, "Infinite Tapestry"));
const url = () => h("div", { style: { fontSize: 20, color: DIM, fontWeight: 400, flexShrink: 0 } }, "infinite-tapestry.vercel.app");
const livePill = (n) => h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "9px 18px", borderRadius: 999, background: "rgba(11,11,13,0.55)", border: "1px solid rgba(243,238,230,0.18)", fontSize: 20, color: INK } },
  h("div", { style: { width: 10, height: 10, borderRadius: 10, background: "#4ade80" } }),
  n > 0 ? `live · ${n} watching` : "live now");
const shade = (dir, a) => h("div", { style: { position: "absolute", left: 0, top: 0, width: 1200, height: 630, display: "flex", backgroundImage: `linear-gradient(${dir}, rgba(11,11,13,${a}) 0%, rgba(11,11,13,0) 55%)` } });
const bgImg = (src, w = 1200, hh = 630, extra = {}) => h("img", { src, width: w, height: hh, style: { position: "absolute", left: 0, top: 0, objectFit: "cover", ...extra } });

// v: full | close | band | live | by
function tree({ v = "full", img, band, line, sub, by, viewers = 0 }) {
  const root = (...c) => h("div", { style: { position: "relative", display: "flex", width: 1200, height: 630, background: BG, fontFamily: "Inter", color: INK } }, ...c);
  if (v === "band") {
    // Dark field, a long panorama of the tapestry as a thin ribbon with a soft glow, text above and below.
    return root(
      h("img", { src: band || img, width: 1200, height: 236, style: { position: "absolute", left: 0, top: 197, objectFit: "cover" } }),
      h("div", { style: { position: "absolute", left: 64, top: 60, display: "flex" } }, brand(28)),
      h("div", { style: { position: "absolute", right: 64, top: 62, display: "flex" } }, livePill(viewers)),
      h("div", { style: { position: "absolute", left: 64, bottom: 64, right: 64, display: "flex", justifyContent: "space-between", alignItems: "flex-end" } },
        h("div", { style: { fontSize: 36, fontWeight: 300, letterSpacing: -0.8, color: INK, maxWidth: 760, lineHeight: 1.15 } }, line || "You choose where it goes."),
        url()));
  }
  if (v === "close") {
    // Text panel left, a tight crop right, hairline between.
    return root(
      bgImg(img, 760, 630, { left: 440 }),
      h("div", { style: { position: "absolute", left: 440, top: 0, width: 160, height: 630, display: "flex", backgroundImage: `linear-gradient(to right, ${BG}, rgba(11,11,13,0))` } }),
      h("div", { style: { position: "absolute", left: 64, top: 64, bottom: 64, width: 420, display: "flex", flexDirection: "column", justifyContent: "space-between" } },
        brand(26),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 18 } },
          h("div", { style: { fontSize: 54, fontWeight: 300, lineHeight: 1.08, letterSpacing: -1.4 } }, line || "Suggest what comes next."),
          h("div", { style: { fontSize: 22, color: DIM, lineHeight: 1.4 } }, sub || "A painting that never ends. Anyone can steer it.")),
        url()));
  }
  // full-bleed variants: full | live | by
  const big = v === "by" ? `“${line}”` : (line || "You choose where it goes.");
  return root(
    bgImg(img),
    shade("to top", 0.88), shade("to bottom", 0.55),
    h("div", { style: { position: "absolute", left: 60, top: 54, display: "flex" } }, brand(26)),
    v === "live" ? h("div", { style: { position: "absolute", right: 60, top: 50, display: "flex" } }, livePill(viewers)) : null,
    h("div", { style: { position: "absolute", left: 60, right: 60, bottom: 56, display: "flex", flexDirection: "column", gap: 14 } },
      h("div", { style: { fontSize: v === "by" ? (big.length > 60 ? 44 : 54) : 52, fontWeight: 300, lineHeight: 1.1, letterSpacing: -1.2, maxWidth: 1000 } }, big),
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
        h("div", { style: { fontSize: 24, color: DIM } }, v === "by" ? `by @${by} · woven into the Infinite Tapestry` : (sub || "An endless painting, live.")),
        url())));
}

async function render(opts) {
  const { ImageResponse } = await import("@vercel/og");   // ESM-only package
  const r = new ImageResponse(tree(opts), { width: 1200, height: 630, fonts: FONTS });
  return Buffer.from(await r.arrayBuffer());
}
const toDataUrl = (buf, type = "image/jpeg") => `data:${type};base64,${Buffer.from(buf).toString("base64")}`;
module.exports = { render, toDataUrl };
