#!/usr/bin/env python3
"""GitHub is the source of truth for every runtime secret (manifest: scripts/ci/secrets.json). Never prints a value.
  sync   : for each manifest entry take the GitHub secret (or variable, kind=var). Present -> upsert into Vercel env for
           its targets when it changed (change detection by a short sha256 tag in the Vercel env comment, so even
           "sensitive" Vercel vars compare without being readable). Absent -> Vercel must already have it, else a
           required entry fails the deploy. pod=true entries (R2 keys) also refresh the pod's durable copy (private
           Supabase object deploy/secrets/r2.env, read by selfboot and the pod's R2 watcher).
  check  : the running prod pod's /health must report storage.r2.write_ok true (skipped when the pod is off).
Env: SECRETS_JSON / VARS_JSON (toJSON(secrets) / toJSON(vars) in the workflow), VERCEL_TOKEN, VERCEL_PROJECT_ID,
VERCEL_ORG_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY."""
import hashlib, json, os, sys, time, urllib.error, urllib.request
from pathlib import Path

MANIFEST = {k: v for k, v in json.loads((Path(__file__).with_name("secrets.json")).read_text()).items() if not k.startswith("_")}
KEYS = [k for k, v in MANIFEST.items() if v.get("pod")]   # R2 keys: the pod's durable copy
OBJ = "deploy/secrets/r2.env"
UA = {"User-Agent": "infinite-tapestry-ci/1"}


def fail(msg):
    print(f"::error::{msg}")
    sys.exit(1)


def req(url, method="GET", data=None, headers=None, timeout=30):
    r = urllib.request.Request(url, method=method, data=data, headers={**UA, **(headers or {})})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:   # network error: report the type only
        return 0, type(e).__name__.encode()


def h(v):
    return hashlib.sha256(v.encode()).hexdigest()


def env_file(vals):
    return "".join(f"{k}={vals[k]}\n" for k in KEYS)


def sb():
    url, key = os.environ.get("SUPABASE_URL", "").rstrip("/"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not (url and key):
        fail("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing")
    return url, {"apikey": key, "Authorization": f"Bearer {key}"}


def tag(v):
    return "sha256:" + h(v)[:12]


def github_values():
    sec = json.loads(os.environ.get("SECRETS_JSON") or "{}")
    var = json.loads(os.environ.get("VARS_JSON") or "{}")
    out = {}
    for k, m in MANIFEST.items():
        v = (var.get(k) if m.get("kind") == "var" else None) or sec.get(k) or var.get(k) or os.environ.get(k) or ""
        if v.strip():
            out[k] = v.strip()
    return out


def sync():
    vals = github_values()
    if not all(k in vals for k in KEYS):   # fail fast: pods would start without R2 writes
        fail("R2 secrets missing in GitHub: " + ",".join(k for k in KEYS if k not in vals))
    tok, proj, team = os.environ.get("VERCEL_TOKEN"), os.environ.get("VERCEL_PROJECT_ID"), os.environ.get("VERCEL_ORG_ID")
    if not (tok and proj and team):
        fail("VERCEL_TOKEN / VERCEL_PROJECT_ID / VERCEL_ORG_ID missing")
    V = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    base = f"https://api.vercel.com/v10/projects/{proj}/env"
    st, body = req(f"{base}?teamId={team}", headers=V)
    if st != 200:
        fail(f"Vercel env list failed: HTTP {st}")
    envs = json.loads(body).get("envs", [])
    missing, only_vercel, updated, unchanged = [], [], [], 0
    for k, m in MANIFEST.items():
        targets = set(m["targets"])
        cur = [e for e in envs if e["key"] == k]
        covered = set().union(*[set(e.get("target", [])) for e in cur]) if cur else set()
        if k not in vals:
            if not targets <= covered:
                if m.get("required"):
                    missing.append(k)
            else:
                only_vercel.append(k)
            continue
        want = tag(vals[k])
        same = [e for e in cur if targets <= set(e.get("target", []))]
        if same and (same[0].get("comment") or "") == want:
            unchanged += 1
            continue
        if same and not same[0].get("comment") and same[0].get("type") != "sensitive":
            st, one = req(f"https://api.vercel.com/v1/projects/{proj}/env/{same[0]['id']}?teamId={team}", headers=V)
            if st == 200 and tag(json.loads(one).get("value") or "") == want:
                req(f"https://api.vercel.com/v9/projects/{proj}/env/{same[0]['id']}?teamId={team}", "PATCH",
                    json.dumps({"comment": want}).encode(), V)
                unchanged += 1
                continue
        typ = same[0].get("type") if same and same[0].get("type") in ("sensitive", "encrypted") else "encrypted"
        for e in cur:   # a key split across per-target entries is replaced by one entry covering all targets
            if e is not (same[0] if same else None) and set(e.get("target", [])) & targets:
                req(f"https://api.vercel.com/v9/projects/{proj}/env/{e['id']}?teamId={team}", "DELETE", None, V)
        st, _ = req(f"{base}?teamId={team}&upsert=true", "POST", json.dumps(
            {"key": k, "value": vals[k], "type": typ, "target": sorted(targets), "comment": want}).encode(), V)
        if st not in (200, 201):
            fail(f"Vercel env upsert {k} failed: HTTP {st}")
        updated.append(k)
    print(f"vercel env: {unchanged} unchanged, {len(updated)} updated ({','.join(updated) or '-'})")
    if only_vercel:
        print("::warning::not in GitHub secrets yet (Vercel still has them; add them to GitHub so a rebuild from "
              "scratch works): " + ",".join(only_vercel))
    if missing:
        fail("required secrets missing in GitHub and Vercel: " + ",".join(missing))
    # durable copy for pods (R2 keys)
    url, H = sb()
    want = env_file(vals)
    st, cur = req(f"{url}/storage/v1/object/{OBJ}", headers=H)
    if st == 200 and h(cur.decode("utf-8", "replace")) == h(want):
        print("pod durable copy: unchanged")
    else:
        st, _ = req(f"{url}/storage/v1/object/{OBJ}", "POST", want.encode(),
                    {**H, "Content-Type": "text/plain", "x-upsert": "true", "cache-control": "no-cache"})
        if st not in (200, 201):
            fail(f"durable copy upload failed: HTTP {st}")
        print("pod durable copy: updated (running pods pick it up via the R2 watcher if their keys stop working)")


def check():
    url, H = sb()
    st, body = req(f"{url}/rest/v1/pod_state?id=eq.1&select=pod_id,desired", headers=H)
    rows = json.loads(body) if st == 200 else []
    pod, desired = (rows[0].get("pod_id"), rows[0].get("desired")) if rows else (None, None)
    if not pod:
        print("::warning::no pod in pod_state; R2 health check skipped")
        return
    last = None
    for _ in range(int(os.environ.get("R2_CHECK_TRIES", "10"))):
        st, body = req(f"https://{pod}-8000.proxy.runpod.net/health", timeout=15)
        if st == 200:
            try:
                r2 = json.loads(body).get("storage", {}).get("r2", {})
            except ValueError:
                r2 = {}
            if r2.get("write_ok") is True:
                print(f"pod {pod}: storage.r2.write_ok true (source {r2.get('source')})")
                return
            last = f"write_ok={r2.get('write_ok')} configured={r2.get('configured')} error={str(r2.get('error'))[:120]}"
        else:
            last = f"/health HTTP {st}"
        time.sleep(15)
    if desired == "off":
        print(f"::warning::pod {pod} is off ({last}); R2 health check skipped")
        return
    fail(f"pod {pod} R2 writes not healthy: {last}")


if __name__ == "__main__":
    {"sync": sync, "check": check}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: fail("usage: sync|check"))()
