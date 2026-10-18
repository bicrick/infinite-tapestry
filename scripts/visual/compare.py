# Visual regression check: compare each render.mjs crop against a ground-truth band composited from the R2 sources
# (L0 strips placed exactly like the classic renderer: x0 = g*core - overlap, later strips on top; L1 tiles when the
# span is too wide for strips). Fails on mismatched content (MAE) or hard edges the reference doesn't have.
import sys, json, os, io, urllib.request, concurrent.futures as cf
from PIL import Image, ImageChops, ImageStat, ImageFilter
UA = {"User-Agent": "Mozilla/5.0 visual-test"}
open_ = lambda u, **k: urllib.request.urlopen(urllib.request.Request(u, headers=UA), **k)
R2 = "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev"; out = sys.argv[1]; CACHE = os.environ.get("CACHE", "/tmp/vt-cache"); os.makedirs(CACHE, exist_ok=True)
M = json.load(open_(R2 + "/tm/lod/manifest.json"))
OG = M["strips"]["og"]; SX = M["strips"]["sdxl"]
def get(url):
    f = os.path.join(CACHE, url.replace("/", "_")[-120:])
    if not os.path.exists(f):
        try: d = open_(url, timeout=30).read()
        except Exception: return None
        open(f, "wb").write(d)
    try: return Image.open(f).convert("RGB")
    except Exception: return None
def strip_url(g):
    if g < SX["g0"]: return f"{R2}/tm/strips/og/{g:08d}.jpg"
    i = g - SX["g0"]; return f"{R2}/live-sdxl/strips/{i:08d}.{'webp' if i >= SX['webp_from'] else 'jpg'}"
def reference(c, W, Hb):
    s = c["s"]; u0 = c["center"] - W / 2 / s; u1 = c["center"] + W / 2 / s
    ref = Image.new("RGB", (W, Hb)); head = int(c.get("head") or M["units"])
    if u1 - u0 <= 320:
        gs = [g for g in range(max(0, int(u0) - 2), min(head, int(u1) + 2))]
        with cf.ThreadPoolExecutor(16) as ex: ims = list(ex.map(lambda g: get(strip_url(g)), gs))
        for g, im in zip(gs, ims):
            if im is None: continue
            w, h = im.size; core = h / 4; ov = w - core; kx = s / core
            ref.paste(im.resize((max(1, round(w * kx)), Hb), Image.LANCZOS), (round((g - u0) * s - ov * kx), 0))
    else:
        U = 16; ts = list(range(max(0, int(u0 // U)), int(min(u1, head - 1) // U) + 1))
        with cf.ThreadPoolExecutor(16) as ex: ims = list(ex.map(lambda t: get(f"{R2}/tm/lod/1/{t:06d}.webp"), ts))
        for t, im in zip(ts, ims):
            if im is None: continue
            x0 = (t * U - u0) * s; wpx = im.size[0] / 64 * s
            ref.paste(im.resize((max(1, round(wpx)), Hb), Image.LANCZOS), (round(x0), 0))
    return ref, u0, u1
def cols(im):  # per-column mean colour profile (vertical edges show up as column jumps)
    px = im.convert("L").resize((im.size[0], 32), Image.BOX).load(); W = im.size[0]
    return [sum(px[x, y] for y in range(32)) / 32 for x in range(W)]
def edge_excess(o, r, sh=3, tol=6, thr=8):
    # columns where OURS jumps harder than the reference does anywhere within +-sh px: seams / hard block edges
    co, cr = cols(o), cols(r); n = len(co); dr = [0] + [abs(cr[x] - cr[x - 1]) for x in range(1, n)]
    out = []
    for x in range(2, n - 1):
        d = abs(co[x] - co[x - 1]); m = max(dr[max(1, x - sh):x + sh + 1])
        if d - m - tol > thr: out.append((x, round(d - m, 1)))
    return out
def block_mae(o, r, bw=32):  # mismatched content: worst 32-px column block
    W = o.size[0]; worst = 0
    for x in range(0, W - bw + 1, bw // 2):
        box = (x, 0, x + bw, o.size[1]); worst = max(worst, sum(ImageStat.Stat(ImageChops.difference(o.crop(box), r.crop(box))).mean) / 3)
    return worst
cases = json.load(open(os.path.join(out, "cases.json"))); fails = 0; rows = []
for c in cases:
    ours = Image.open(os.path.join(out, c["name"] + ".png")).convert("RGB"); W, Hb = ours.size
    k = W / c["W"]; c = dict(c, s=c["s"] * k, W=W)  # device pixels
    ref, u0, u1 = reference(c, W, Hb); head_x = (min(c.get("head") or M["units"], M["units"] if os.environ.get("PYR_ONLY") else 1e12) - u0) * c["s"]
    cut = int(max(0, min(W, head_x))) if head_x < W else W  # ignore beyond the pyramid's end (live chunks)
    o, r = ours.crop((0, 0, cut, Hb)), ref.crop((0, 0, cut, Hb))
    blur = lambda im: im.resize((max(1, cut // 8), max(1, Hb // 8)), Image.BOX)
    mae = sum(ImageStat.Stat(ImageChops.difference(blur(o), blur(r))).mean) / 3
    ex = edge_excess(o, r) if c["s"] / k >= 8 else []  # below ~8 css px/unit neighbours are distinct images in the reference too
    bm = block_mae(blur(o).resize((cut, Hb)), blur(r).resize((cut, Hb)))
    ok = mae <= float(os.environ.get("MAE_MAX", 12)) and bm <= float(os.environ.get("BLOCK_MAX", 30)) and not ex
    fails += not ok
    rows.append(dict(name=c["name"], level=c["level"], span=round(u1 - u0, 1), mae=round(mae, 2), block_mae=round(bm, 1), hard_edges=ex[:12], ok=ok))
    sheet = Image.new("RGB", (W, Hb * 2 + 6), (255, 0, 0)); sheet.paste(ours, (0, 0)); sheet.paste(ref, (0, Hb + 6)); sheet.save(os.path.join(out, c["name"] + "_vs_ref.png"))
for r in rows: print(("PASS " if r["ok"] else "FAIL ") + json.dumps(r))
json.dump(rows, open(os.path.join(out, "report.json"), "w"), indent=1); print(f"{len(rows) - fails}/{len(rows)} pass"); sys.exit(1 if fails else 0)
