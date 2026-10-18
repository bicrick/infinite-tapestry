#!/usr/bin/env python3
"""Move every binary left in Supabase Storage to R2 and delete it from Supabase (resumable; safe to rerun).

Production stores binaries only on R2. This empties Supabase Storage of anything else, one verified object at a time:
  - R2 already has it (strips: same size; tiles/canvas: present, the R2 copy is the newer one) -> delete from Supabase
  - else download -> PUT to R2 -> HEAD-verify the size -> delete from Supabase (batches of 100, as soon as verified)
  - junk (mock*/test* prefixes, release tarballs beyond the newest --deploy-keep) -> delete without copying
Never touched: tapestry/tm/idx (Time Machine JSON index), idea-refs (user uploads), deploy/secrets, deploy/worker/latest.*.
Strips whose R2 copy has a different size are kept and logged (KEPT_*), never overwritten.

Dry run by default (prints the plan). --execute does it. Runs anywhere with the env below: a laptop, the pod, or CI
(.github/workflows/ops.yml, job storage-migrate). Log: $OPS_LOG_DIR/storage_migrate.tsv (default ./ops-logs).
Env: SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY [R2_BUCKET] [THREADS=12]
Needs boto3."""
import argparse, json, os, sys, threading, time, urllib.error, urllib.request, concurrent.futures as cf

ap = argparse.ArgumentParser()
ap.add_argument("--execute", action="store_true")
ap.add_argument("--deploy-keep", type=int, default=5)
ap.add_argument("--threads", type=int, default=int(os.environ.get("THREADS", "12")))
args = ap.parse_args()

import boto3  # noqa: E402

SB = os.environ["SUPABASE_URL"].rstrip("/"); KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
B = os.environ.get("R2_BUCKET") or "tapestry-strips"
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                  aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
LOGDIR = os.environ.get("OPS_LOG_DIR", "ops-logs"); os.makedirs(LOGDIR, exist_ok=True)
LOG = open(os.path.join(LOGDIR, "storage_migrate.tsv"), "a", buffering=1)
BUCKETS = ("strips", "tapestry", "deploy")


def say(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def call(url, method="GET", body=None, tries=8, timeout=60):
    for a in range(tries):
        try:
            req = urllib.request.Request(url, method=method, headers={**H, "Content-Type": "application/json"},
                                         data=None if body is None else json.dumps(body).encode())
            return urllib.request.urlopen(req, timeout=timeout).read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None
            time.sleep((8 if e.code == 429 else 2) * (a + 1))
        except Exception:
            time.sleep(2 * (a + 1))
    raise RuntimeError(f"{method} {url.split('/storage/')[-1]} kept failing")


def walk(bucket, prefix=""):
    """All objects under prefix (Storage list API is one folder level at a time)."""
    off = 0
    while True:
        page = json.loads(call(f"{SB}/storage/v1/object/list/{bucket}", "POST",
                               {"prefix": prefix, "limit": 1000, "offset": off, "sortBy": {"column": "name", "order": "asc"}}) or b"[]")
        for e in page:
            n = f"{prefix}{e['name']}"
            if e.get("id") is None:
                yield from walk(bucket, n + "/")
            else:
                yield {"b": bucket, "n": n, "s": int((e.get("metadata") or {}).get("size") or 0), "c": e.get("created_at") or ""}
        if len(page) < 1000:
            return
        off += 1000


def protected(b, n):
    return (b == "tapestry" and n.startswith("tm/idx/")) or (b == "deploy" and n.startswith(("secrets/", "worker/latest.")))


def dest(b, n):
    if b == "strips" and n.startswith("live-sdxl/"):
        return n
    if b == "tapestry" and n.startswith(("tm/lod2/", "live-sdxl/")):
        return n
    return None


rows = [r for b in BUCKETS for r in walk(b)]
latest = (call(f"{SB}/storage/v1/object/deploy/worker/latest.txt") or b"").decode().strip()
tgz = sorted((r for r in rows if r["b"] == "deploy" and r["n"].endswith(".tgz")), key=lambda r: r["c"], reverse=True)
keep_tgz = {r["n"] for r in tgz[:args.deploy_keep]} | ({f"worker/{latest}.tgz"} if latest else set())
work, junk = [], []
for r in rows:
    b, n = r["b"], r["n"]
    if protected(b, n) or (b == "deploy" and (n in keep_tgz or not latest)):
        continue
    (junk if b == "deploy" or n.startswith(("mock", "test")) or dest(b, n) is None else work).append(r)
say(f"supabase objects {len(rows)}; junk {len(junk)} ({sum(r['s'] for r in junk)/1e6:.1f} MB); "
    f"copy-or-verify then delete {len(work)} ({sum(r['s'] for r in work)/1e6:.1f} MB)")
if not args.execute:
    for r in junk[:20]:
        say("  junk", r["b"], r["n"])
    say("dry run; pass --execute to do it")
    sys.exit(0)

r2 = {}
for pfx in sorted({dest(r["b"], r["n"]).split("/")[0] + "/" for r in work}):
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=B, Prefix=pfx):
        for o in page.get("Contents", []):
            r2[o["Key"]] = o["Size"]
say(f"r2 listed {len(r2)} keys")
pending, lock, stats = {}, threading.Lock(), {}


def bump(k, n=1):
    with lock:
        stats[k] = stats.get(k, 0) + n


def queue_delete(r, action, flush=False):
    with lock:
        if r is not None:
            pending.setdefault(r["b"], []).append(r)
            LOG.write(f"{r['b']}\t{r['n']}\t{r['s']}\t{action}\n")
        ready = [(b, l) for b, l in pending.items() if l and (len(l) >= 100 or flush)]
        for b, _ in ready:
            pending[b] = []
    for b, l in ready:
        try:
            got = json.loads(call(f"{SB}/storage/v1/object/{b}", "DELETE", {"prefixes": [x["n"] for x in l]}) or b"[]")
            bump("deleted", len(got))
        except RuntimeError:
            bump("delete_failed", len(l))


def ctype(n):
    return {"webp": "image/webp", "png": "image/png", "json": "application/json"}.get(n.rsplit(".", 1)[-1], "image/jpeg")


def one(r):
    b, n, s = r["b"], r["n"], r["s"]
    k, immutable = dest(b, n), "/strips/" in n
    have = r2.get(k)
    if have is not None and (have == s or not immutable):
        bump("already_in_r2"); return queue_delete(r, "deleted_verified_in_r2")
    if have is not None:
        bump("r2_differs_kept"); LOG.write(f"{b}\t{n}\t{s}\tKEPT_r2_size_{have}\n"); return
    try:
        d = call(f"{SB}/storage/v1/object/authenticated/{b}/{n}")
    except RuntimeError:
        d = b""
    if d is None:
        bump("gone"); return
    if len(d) != s:
        bump("fetch_err"); LOG.write(f"{b}\t{n}\t{s}\tKEPT_fetch_err\n"); return
    try:
        s3.put_object(Bucket=B, Key=k, Body=d, ContentType=ctype(n), CacheControl=(
            "public, max-age=31536000, immutable" if immutable or "/lod2/" in n else "public, max-age=60"))
        got = s3.head_object(Bucket=B, Key=k)["ContentLength"]
    except Exception as e:
        bump("r2_err"); LOG.write(f"{b}\t{n}\t{s}\tKEPT_r2_err_{type(e).__name__}\n"); return
    if got != s:
        bump("verify_bad"); LOG.write(f"{b}\t{n}\t{s}\tKEPT_verify_{got}\n"); return
    bump("copied"); queue_delete(r, "deleted_after_copy")


t0 = time.time()
for r in junk:
    queue_delete(r, "deleted_junk")
queue_delete(None, "", flush=True)
with cf.ThreadPoolExecutor(args.threads) as ex:
    for i, _ in enumerate(ex.map(one, work), 1):
        if i % 500 == 0:
            say(f"{i}/{len(work)}", stats, f"{time.time() - t0:.0f}s")
queue_delete(None, "", flush=True)
say("DONE", stats, f"{time.time() - t0:.0f}s")
