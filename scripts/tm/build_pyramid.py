#!/usr/bin/env python3
"""Time Machine v3 tile pyramid (prototype). Every strip = one equal-width unit on one global line:
OG era (SD 1.5, 128x512 cores, Supabase Storage) is upscaled to the SDXL unit; SDXL strips are cut from the
pod's existing level-1 tiles on R2. Missing strips stay dark gaps.

  L1: 16 units/tile, 1024x256 (64 px/unit)    L2: 64 u/t, 1024x64     L3: 256 u/t, 1024x64 (anisotropic: height
  L4: 1024 u/t ...  L7: 65536 u/t              stays 64 px so deep zoom-outs read as a colour ribbon)

Output: R2 tm/lod/{L}/{t:06d}.webp + tm/lod/manifest.json. Resumable (local cache in /workspace/tm-pyr).
Env: ~/.tapestry/supabase.env + app.env (R2_*). Box-only; never touches the pod.
"""
import io, json, os, pathlib, sys, urllib.request, concurrent.futures as cf, threading
from PIL import Image

def load_env():
    for f in ["~/.tapestry/supabase.env", "~/.tapestry/app.env"]:
        for l in pathlib.Path(f).expanduser().read_text().splitlines():
            l = l.strip().removeprefix("export ")
            if "=" in l and not l.startswith("#"):
                k, v = l.split("=", 1); os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
load_env()
SB, KEY, PUB = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_ROLE_KEY"], os.environ["R2_PUBLIC_URL"].rstrip("/")
H = {"apikey": KEY, "authorization": "Bearer " + KEY}
OUT = pathlib.Path("/workspace/tm-pyr"); UPT = {1: 16}; TW, UW = 1024, 64
for l in range(2, 8): UPT[l] = UPT[l - 1] * 4
import boto3
s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                  aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
BUCKET = os.environ["R2_BUCKET"]

def get(url, headers=None, tries=3):
    for i in range(tries):
        try: return urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "tapestry-tm/1", **(headers or {})}), timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 404): return None
        except Exception: pass
    return None

def rows(session):
    out, frm = [], 0
    while True:
        r = json.loads(urllib.request.urlopen(urllib.request.Request(f"{SB}/rest/v1/strips?select=idx,path&session=eq.{session}&order=idx.asc", headers={**H, "range": f"{frm}-{frm+999}"}), timeout=60).read())
        out += r; frm += 1000
        if len(r) < 1000: return out

state = json.loads(get(f"{SB}/storage/v1/object/tapestry/tm/idx/state.json", H))
eras = state["eras"]; og, sd = eras[0], eras[1]
N = sd["g0"] + sd["b"] + 1
og_paths = {r["idx"]: r["path"] for r in rows(og["session"])}
_src, _lock = {}, threading.Lock()
def sdxl_tile(c):
    with _lock:
        if c in _src: return _src[c]
    b = None
    for _ in range(4):  # S3 API, not the rate-limited r2.dev public URL
        try: b = s3.get_object(Bucket=BUCKET, Key=f"{sd['session']}/lod/1/{c:06d}.jpg")["Body"].read(); break
        except s3.exceptions.NoSuchKey: break
        except Exception: __import__("time").sleep(1)
    im = Image.open(io.BytesIO(b)).convert("RGB") if b else None
    if b is None: print("missing sdxl L1", c, flush=True)
    with _lock:
        _src[c] = im
        if len(_src) > 64: _src.pop(next(iter(_src)))
    return im

def unit(g):
    if g < sd["g0"]:
        p = og_paths.get(g)
        b = p and get(f"{SB}/storage/v1/object/tapestry/{p}", H)
        if not b: return None
        im = Image.open(io.BytesIO(b)).convert("RGB"); core = im.height // 4  # 128 of 512
        return im.crop((im.width - core, 0, im.width, im.height)).resize((UW, 256), Image.LANCZOS)
    k = g - sd["g0"]; src = sdxl_tile(k // 16)
    if src is None or src.width < (k % 16 + 1) * UW: return None
    return src.crop(((k % 16) * UW, 0, (k % 16 + 1) * UW, 256))

def path(l, t): return OUT / str(l) / f"{t:06d}.webp"
def upload(l, t, last):
    s3.put_object(Bucket=BUCKET, Key=f"tm/lod/{l}/{t:06d}.webp", Body=path(l, t).read_bytes(), ContentType="image/webp",
                  CacheControl="public, max-age=300" if last else "public, max-age=31536000, immutable")

def build(l, t, last):
    p = path(l, t)
    if p.exists() and not last: return 0
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
            ch = Image.open(path(l - 1, c)).convert("RGB")
            cw = max(1, round(ch.width / 4)); im.paste(ch.resize((cw, 64), Image.BOX), (x, 0)); x += cw
    im.save(p, "WEBP", quality=72, method=4)
    upload(l, t, last); return 1

for l in range(1, 8):
    nt = -(-N // UPT[l])
    with cf.ThreadPoolExecutor(24 if l == 1 else 8) as ex:
        done = sum(ex.map(lambda t: build(l, t, t == nt - 1), range(nt)))
    print(f"L{l}: {nt} tiles ({done} built)", flush=True)
man = {"v": 1, "units": N, "tile_w": TW, "unit_px_l1": UW,
       "levels": [{"l": l, "units_per_tile": UPT[l], "tiles": -(-N // UPT[l]), "h": 256 if l == 1 else 64} for l in range(1, 8)],
       "eras": eras, "strips": {"og": f"{SB}/storage/v1/object/public/tapestry/", "sdxl": f"{PUB}/{sd['session']}/strips/"}}
s3.put_object(Bucket=BUCKET, Key="tm/lod/manifest.json", Body=json.dumps(man).encode(), ContentType="application/json", CacheControl="public, max-age=60")
print("manifest", json.dumps(man)[:300])
