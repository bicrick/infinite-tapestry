#!/usr/bin/env python3
"""Build / catch up the macro LOD pyramid (infinite_tapestry/lodx.py) on R2. CPU only, idempotent, never overwrites.

  python scripts/ops/build_macro.py              # every complete macro tile + the latest overview that is missing
  python scripts/ops/build_macro.py --dry-run    # plan only

Needs R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (and optionally R2_BUCKET, default tapestry-strips).
Reads the live L1 tiles (<prefix>/lod/1/*.jpg; a missing one is composed from its strips), writes only new keys under
<prefix>/lodx/ with If-None-Match: * so an existing object is never replaced. The newest strip index comes from
--max-index or the public /api/live. Used for the one-off backfill and as the scheduled catch-up (the pod also builds
tiles as chunks complete, see lod.LodBuilder).
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from infinite_tapestry import lodx  # noqa: E402

SW, H = 256, 1024


def s3client():
    import boto3
    from botocore.config import Config
    return boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto",
                        config=Config(max_pool_connections=64, retries={"max_attempts": 6, "mode": "adaptive"}))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", default="live-sdxl")
    ap.add_argument("--max-index", type=int)
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--stats", default="")
    a = ap.parse_args()
    B = os.environ.get("R2_BUCKET") or "tapestry-strips"
    s3 = s3client()
    mx = a.max_index
    if mx is None:
        with urllib.request.urlopen(urllib.request.Request("https://infinitetapestry.app/api/live", headers={"user-agent": "tapestry-macro/1"}), timeout=20) as r:
            mx = int(json.load(r)["max"])
    P = a.prefix
    existing: set[str] = set()
    for pg in s3.get_paginator("list_objects_v2").paginate(Bucket=B, Prefix=f"{P}/lodx/"):
        existing.update(o["Key"][len(P) + 1:] for o in pg.get("Contents", []))

    def get(k: str) -> bytes | None:
        try:
            return s3.get_object(Bucket=B, Key=f"{P}/{k}")["Body"].read()
        except s3.exceptions.NoSuchKey:
            return None
        except Exception as e:  # noqa: BLE001
            if "NoSuchKey" in str(e) or "404" in str(e):
                return None
            raise

    def put(k: str, data: bytes) -> bool:
        try:
            s3.put_object(Bucket=B, Key=f"{P}/{k}", Body=data, ContentType=lodx.CTYPE, CacheControl=lodx.CACHE, IfNoneMatch="*")
            return True
        except Exception as e:  # noqa: BLE001
            if "PreconditionFailed" in str(e) or "412" in str(e):
                return False   # someone (the pod) wrote it first: keep theirs
            raise

    stats = {"max_index": mx, "levels": {}, "l1_from_strips": 0, "skipped_existing": 0, "t0": time.time()}
    built: dict[str, bytes] = {}
    x5: dict[str, bytes] = {}

    def l1(c: int) -> bytes | None:
        d = get(f"lod/1/{c:06d}.jpg")
        if d:
            return d
        strips = []
        for i in range(c * 16, c * 16 + 16):
            s = get(f"strips/{i:08d}.webp") or get(f"strips/{i:08d}.jpg")
            strips.append(s)
        stats["l1_from_strips"] += 1
        return lodx.l1_from_strips(strips, SW, H)

    def child(level: int, c: int) -> bytes | None:
        if level == 1:
            return l1(c)
        k = lodx.key(level, c)
        return built.get(k) or get(k)

    def build(level: int, c: int):
        k = lodx.key(level, c)
        if k in existing:
            return k, None, "exists"
        data = lodx.combine([child(level - 1, 4 * c + j) for j in range(4)])
        if data is None:
            return k, None, "empty"
        if a.dry_run:
            return k, data, "dry"
        return k, data, "put" if put(k, data) else "exists"

    with cf.ThreadPoolExecutor(a.workers) as ex:
        for level in lodx.LEVELS:
            n = lodx.complete_chunks(level, mx)
            t0, st = time.time(), {"tiles": n, "written": 0, "bytes": 0, "exists": 0, "empty": 0}
            for k, data, what in ex.map(lambda c: build(level, c), range(n)):
                if data is not None:
                    built[k] = data
                if what in ("put", "dry"):
                    st["written"] += 1; st["bytes"] += len(data)
                elif what == "exists":
                    st["exists"] += 1
                else:
                    st["empty"] += 1
            if level == 5:
                x5 = {kk: v for kk, v in built.items() if kk.startswith("lodx/5/")}
            # drop the level below (no longer needed) to bound memory
            for kk in [x for x in built if x.startswith(f"lodx/{level - 1}/")]:
                del built[kk]
            st["s"] = round(time.time() - t0, 1)
            stats["levels"][level] = st
            print(f"X{level}: {st}", flush=True)
    n = (mx // lodx.OV_STEP) * lodx.OV_STEP
    ok = lodx.ov_key(n)
    if n and ok not in existing:
        data = lodx.overview(n, lambda c: x5.get(lodx.key(5, c)) or get(lodx.key(5, c)))
        if data:
            w = a.dry_run or put(ok, data)
            stats["overview"] = {"key": ok, "bytes": len(data), "written": bool(w)}
    stats["s"] = round(time.time() - stats.pop("t0"), 1)
    print(json.dumps(stats), flush=True)
    if a.stats:
        Path(a.stats).write_text(json.dumps(stats, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
