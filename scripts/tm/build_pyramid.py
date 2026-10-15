#!/usr/bin/env python3
"""Time Machine v3 tile pyramid on R2. Every strip = one equal-width unit on one global line (all history from
the first OG-era strip): OG era (SD 1.5, Supabase Storage) upscaled to the SDXL unit; SDXL strips cut from the
pod's level-1 tiles on R2, or from the strips themselves at the live tip. Missing strips stay dark gaps.

  L1: 16 units/tile, 1024x256 (64 px/unit)    L2: 64 u/t, 1024x64    L3..L7: x4 units per tile, height stays 64
  (anisotropic: deep zoom-outs read as a colour ribbon). Full-res strips are the deepest level (manifest.strips).

  python3 scripts/tm/build_pyramid.py            incremental: only tiles touched since manifest.units (cron)
  python3 scripts/tm/build_pyramid.py --full     everything (resumable via local cache /workspace/tm-pyr)
  python3 scripts/tm/build_pyramid.py --og-strips   mirror normalised OG-era strips to R2 tm/strips/og/ (one-off)
Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
(read from ~/.tapestry/*.env when present). Exits 0 with a note if R2 creds are missing. Never touches the pod.
"""
import io, json, os, pathlib, sys, time, urllib.request, urllib.error, concurrent.futures as cf, threading
from PIL import Image

for f in ["~/.tapestry/supabase.env", "~/.tapestry/app.env"]:
    p = pathlib.Path(f).expanduser()
    if p.exists():
        for l in p.read_text().splitlines():
            l = l.strip().removeprefix("export ")
            if "=" in l and not l.startswith("#"):
                k, v = l.split("=", 1); os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
need = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
if not all(os.environ.get(k) for k in need):
    print("tm pyramid: R2 creds missing (" + ", ".join(k for k in need if not os.environ.get(k)) + "); skipping"); sys.exit(0)
import boto3
SB, KEY = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": KEY, "authorization": "Bearer " + KEY, "user-agent": "tapestry-tm/1"}
OUT = pathlib.Path(os.environ.get("TM_PYR_CACHE", "/workspace/tm-pyr")); UPT = {1: 16}; TW, UW = 1024, 64; LMAX = 7
for l in range(2, LMAX + 1): UPT[l] = UPT[l - 1] * 4
s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                  aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
BUCKET = os.environ["R2_BUCKET"]

def get(url, tries=3):
    for _ in range(tries):
        try: return urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 404): return None
        except Exception: time.sleep(1)
    return None
def r2get(key):
    for _ in range(4):
        try: return s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
        except s3.exceptions.NoSuchKey: return None
        except Exception: time.sleep(1)
    return None
def rows(session, a=0):
    out, frm = [], 0
    while True:
        r = json.loads(get(f"{SB}/rest/v1/strips?select=idx,path&session=eq.{session}&idx=gte.{a}&order=idx.asc&offset={frm}&limit=1000"))
        out += r; frm += 1000
        if len(r) < 1000: return out

state = json.loads(get(f"{SB}/storage/v1/object/tapestry/tm/idx/state.json"))
eras = state["eras"]; og, sd = eras[0], eras[1]
N = sd["g0"] + sd["b"] + 1
old = json.loads(r2get("tm/lod/manifest.json") or b"{}")
FULL = "--full" in sys.argv or not old
start = 0 if FULL else max(0, min(old.get("units", 0), N) - 64)  # redo the tip: strips may land on R2 late
og_paths = {r["idx"]: r["path"] for r in rows(og["session"])} if start < sd["g0"] or "--og-strips" in sys.argv else {}
sd_paths = {r["idx"]: r["path"] for r in rows(sd["session"], max(0, (start - sd["g0"]) // 16 * 16))}

def og_unit_full(i):  # normalised OG strip: right-most core (1/4 of height wide), upscaled to 256x1024
    b = og_paths.get(i) and get(f"{SB}/storage/v1/object/tapestry/{og_paths[i]}")
    if not b: return None
    im = Image.open(io.BytesIO(b)).convert("RGB"); core = im.height // 4
    return im.crop((im.width - core, 0, im.width, im.height)).resize((256, 1024), Image.LANCZOS)

if "--og-strips" in sys.argv:
    def up(i):
        u = og_unit_full(i)
        if not u: return 0
        bio = io.BytesIO(); u.save(bio, "JPEG", quality=85)
        s3.put_object(Bucket=BUCKET, Key=f"tm/strips/og/{i:08d}.jpg", Body=bio.getvalue(), ContentType="image/jpeg", CacheControl="public, max-age=31536000, immutable")
        return 1
    with cf.ThreadPoolExecutor(16) as ex: print("og strips mirrored:", sum(ex.map(up, sorted(og_paths))))
    sys.exit(0)

_src, _lock = {}, threading.Lock()
def sdxl_tile(c):
    with _lock:
        if c in _src: return _src[c]
    b = r2get(f"{sd['session']}/lod/1/{c:06d}.jpg")
    im = Image.open(io.BytesIO(b)).convert("RGB") if b else None
    with _lock:
        _src[c] = im
        if len(_src) > 64: _src.pop(next(iter(_src)))
    return im

def unit(g):
    if g < sd["g0"]:
        u = og_unit_full(g); return u and u.resize((UW, 256), Image.LANCZOS)
    k = g - sd["g0"]; src = sdxl_tile(k // 16)
    if src is not None and src.width >= (k % 16 + 1) * UW:
        return src.crop(((k % 16) * UW, 0, (k % 16 + 1) * UW, 256))
    p = sd_paths.get(k); b = p and r2get(p)  # live tip: the pod hasn't built this L1 tile yet
    if not b: return None
    im = Image.open(io.BytesIO(b)).convert("RGB"); core = im.height // 4
    return im.crop((im.width - core, 0, im.width, im.height)).resize((UW, 256), Image.LANCZOS)

def path(l, t): return OUT / str(l) / f"{t:06d}.webp"
def child(l, t):
    p = path(l, t)
    if not p.exists():
        b = r2get(f"tm/lod/{l}/{t:06d}.webp")
        if not b: return None
        p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b)
    return Image.open(p).convert("RGB")

def build(l, t, force):
    p = path(l, t)
    if p.exists() and not force: return 0
    p.parent.mkdir(parents=True, exist_ok=True)
    n = min(UPT[l], N - t * UPT[l])
    if l == 1:
        im = Image.new("RGB", (n * UW, 256), (10, 10, 12))
        for i in range(n):
            u = unit(t * 16 + i)
            if u: im.paste(u, (i * UW, 0))
    else:
        w = max(1, round(n * TW / UPT[l])); im = Image.new("RGB", (w, 64), (10, 10, 12)); x = 0
        for c in range(4 * t, min(4 * t + 4, -(-N // UPT[l - 1]))):
            ch = child(l - 1, c)
            cw = max(1, round(UPT[l - 1] * TW / UPT[l]) if ch is None else round(ch.width / 4))
            if ch is not None: im.paste(ch.resize((cw, 64), Image.BOX), (x, 0))
            x += cw
    im.save(p, "WEBP", quality=72, method=4)
    last = t == -(-N // UPT[l]) - 1
    s3.put_object(Bucket=BUCKET, Key=f"tm/lod/{l}/{t:06d}.webp", Body=p.read_bytes(), ContentType="image/webp",
                  CacheControl="public, max-age=120" if last else "public, max-age=31536000, immutable")
    return 1

t0 = time.time(); built = {}
for l in range(1, LMAX + 1):
    first, nt = start // UPT[l], -(-N // UPT[l])
    with cf.ThreadPoolExecutor(24 if l == 1 else 8) as ex:
        built[l] = sum(ex.map(lambda t: build(l, t, not FULL or t >= nt - 1), range(first, nt)))
man = {"v": 2, "units": N, "tile_w": TW, "unit_px_l1": UW, "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
       "levels": [{"l": l, "units_per_tile": UPT[l], "tiles": -(-N // UPT[l]), "h": 256 if l == 1 else 64} for l in range(1, LMAX + 1)],
       "eras": eras,
       # deepest level: one image per strip, drawn as its right-most core (height/4 wide) = the same unit as the tiles
       "strips": {"og": {"g0": og["g0"], "n": og.get("n", 0), "url": "tm/strips/og/{i8}.jpg"},
                  "sdxl": {"g0": sd["g0"], "n": sd.get("n", 0), "url": sd["session"] + "/strips/{i8}.{ext}", "webp_from": 6598}}}
s3.put_object(Bucket=BUCKET, Key="tm/lod/manifest.json", Body=json.dumps(man).encode(), ContentType="application/json", CacheControl="public, max-age=60")
print(f"tm pyramid: units {old.get('units')} -> {N}, built {built}, {time.time() - t0:.0f}s")
