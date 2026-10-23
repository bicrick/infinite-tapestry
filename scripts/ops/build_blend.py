#!/usr/bin/env python3
"""Build the blended LOD pyramid (lodx.BLEND_LIVE L1..L3 + lodx.BLEND_X X2..X8 + overview) from the public strips.

  python scripts/ops/build_blend.py --out DIR                  # build every complete tile into DIR/<prefix>/... (resumable)
  python scripts/ops/build_blend.py --out DIR --upload         # then put the new keys on R2 (If-None-Match: never overwrites)

Reads only public URLs (strips from the CDN, the newest index from /api/live). Each blended L1 tile also paints the next
chunk's first strip, so tile edges carry the same inpainted blend as the zoom-1 view (see lodx.py). --upload needs
R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (R2_BUCKET defaults to tapestry-strips) and writes new keys only.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import sys
import threading
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from infinite_tapestry import lodx  # noqa: E402

SW, H = 256, 1024
CDN = "https://img.infinitetapestry.app"
_tls = threading.local()


def sess() -> requests.Session:
    if not hasattr(_tls, "s"):
        _tls.s = requests.Session()
        _tls.s.headers["user-agent"] = "tapestry-blend/1"
    return _tls.s


def fetch(url: str) -> bytes | None:
    for t in range(5):
        try:
            r = sess().get(url, timeout=30)
            if r.status_code == 200:
                return r.content
            if r.status_code == 404:
                return None
        except requests.RequestException:
            pass
        time.sleep(0.5 * (t + 1))
    raise RuntimeError(f"fetch failed: {url}")


def strip(base: str, i: int) -> bytes | None:
    return fetch(f"{base}/strips/{i:08d}.webp") or fetch(f"{base}/strips/{i:08d}.jpg")


def l1_job(args):
    base, out, c = args
    p = out / lodx.live_key(1, c)
    if p.exists():
        return c, "exists"
    with cf.ThreadPoolExecutor(17) as ex:
        strips = list(ex.map(lambda i: strip(base, i), range(16 * c, 16 * c + 17)))
    data = lodx.l1_from_strips(strips, SW, H, n=16, quality=72)
    if data is None:
        return c, "empty"
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp"); tmp.write_bytes(data); tmp.rename(p)
    return c, "built"


def rd(p: Path) -> bytes | None:
    return p.read_bytes() if p.exists() else None


def wr(p: Path, data: bytes | None) -> bool:
    if data is None:
        return False
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", default="live-sdxl")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-index", type=int)
    ap.add_argument("--procs", type=int, default=8)
    ap.add_argument("--first", type=int, default=0, help="first L1 chunk (tests)")
    ap.add_argument("--last", type=int, help="last L1 chunk, exclusive (tests)")
    ap.add_argument("--upload", action="store_true")
    a = ap.parse_args()
    mx = a.max_index
    if mx is None:
        mx = int(requests.get("https://infinitetapestry.app/api/live", headers={"user-agent": "tapestry-blend/1"}, timeout=20).json()["max"])
    out = Path(a.out) / a.prefix
    base = f"{CDN}/{a.prefix}"
    n1 = mx // 16 if a.last is None else min(a.last, mx // 16)   # blended L1 c needs strip 16(c+1) <= mx
    t0, stats = time.time(), {"max_index": mx}
    import multiprocessing as mp
    with mp.Pool(a.procs) as pool:
        done = {"built": 0, "exists": 0, "empty": 0}
        for k, (c, what) in enumerate(pool.imap_unordered(l1_job, [(base, out, c) for c in range(a.first, n1)], chunksize=4)):
            done[what] += 1
            if k % 500 == 0:
                print(f"L1 {k}/{n1 - a.first} {done} {time.time() - t0:.0f}s", flush=True)
    stats["L1"] = done
    lo = a.first
    # L2 / L3 live tiles from their 4 children (lod.LodBuilder geometry)
    for level, (w, h) in ((2, (1024, 64)), (3, (1024, 16))):
        built = 0
        for c in range(lo // 4 ** (level - 1), mx // lodx.STRIPS[level]):
            p = out / lodx.live_key(level, c)
            if p.exists():
                continue
            built += wr(p, lodx.live_up([rd(out / lodx.live_key(level - 1, 4 * c + j)) for j in range(4)], w, h))
        stats[f"L{level}"] = built
    # macro X2..X8 from blended L1 / X children, then the overview
    for level in (lodx.LEVELS if a.first == 0 and a.last is None else ()):  # partial runs: live tiles only
        built = 0
        for c in range(lo // lodx.STRIPS[level], lodx.complete_chunks(level, mx)):
            p = out / lodx.key(level, c, lodx.BLEND_X)
            if p.exists():
                continue
            kids = [rd(out / (lodx.live_key(1, 4 * c + j) if level == 2 else lodx.key(level - 1, 4 * c + j, lodx.BLEND_X)))
                    for j in range(4)]
            built += wr(p, lodx.combine(kids))
        stats[f"X{level}"] = built
    n = (mx // lodx.OV_STEP) * lodx.OV_STEP
    if n and a.first == 0 and a.last is None:
        p = out / lodx.ov_key(n, lodx.BLEND_X)
        if not p.exists():
            wr(p, lodx.overview(n, lambda c: rd(out / lodx.key(5, c, lodx.BLEND_X))))
        stats["ov"] = lodx.ov_key(n, lodx.BLEND_X)
    stats["build_s"] = round(time.time() - t0, 1)
    print(json.dumps(stats), flush=True)
    if a.upload:
        upload(out, a.prefix)
    return 0


def upload(out: Path, prefix: str) -> None:
    """Put every built file under its key; If-None-Match: * so an existing object is never replaced."""
    import boto3
    from botocore.config import Config
    s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                      aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto",
                      config=Config(max_pool_connections=64, retries={"max_attempts": 6, "mode": "adaptive"}))
    B = os.environ.get("R2_BUCKET") or "tapestry-strips"
    files = [p for d in (lodx.BLEND_LIVE, lodx.BLEND_X) for p in (out / d).rglob("*") if p.is_file() and p.suffix in (".jpg", ".webp")]

    def put(p: Path) -> str:
        k = f"{prefix}/{p.relative_to(out).as_posix()}"
        ctype = "image/jpeg" if p.suffix == ".jpg" else lodx.CTYPE
        try:
            s3.put_object(Bucket=B, Key=k, Body=p.read_bytes(), ContentType=ctype, CacheControl=lodx.CACHE, IfNoneMatch="*")
            return "put"
        except Exception as e:  # noqa: BLE001
            if "PreconditionFailed" in str(e) or "412" in str(e):
                return "exists"
            raise
    st = {"put": 0, "exists": 0}
    with cf.ThreadPoolExecutor(48) as ex:
        for r in ex.map(put, files):
            st[r] += 1
    print("upload", json.dumps(st), flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
