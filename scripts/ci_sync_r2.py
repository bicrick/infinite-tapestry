#!/usr/bin/env python3
"""CI is the source of truth for the R2 write keys (GitHub secrets R2_*). Never prints a value.
  sync   : fail if any R2 secret is missing; upsert them into Vercel env (production+preview: gpu.js podEnv hands
           them to every new pod); refresh the pod's durable copy (private Supabase object deploy/secrets/r2.env,
           read by selfboot + the pod's R2 watcher, which re-reads it and heals when its own keys stop working).
           Each target is only written when its content actually changed (compared by hash, no values logged).
  check  : the running prod pod's /health must report storage.r2.write_ok true (skipped when the pod is off).
Env: R2_* secrets, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VERCEL_TOKEN (sync), VERCEL_PROJECT_ID, VERCEL_ORG_ID."""
import hashlib, json, os, sys, time, urllib.error, urllib.request

KEYS = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL", "R2_BUCKET", "R2_ACCOUNT_ID"]
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


def sync():
    vals = {k: os.environ.get(k, "").strip() for k in KEYS}
    missing = [k for k in KEYS if not vals[k]]
    if missing:
        fail("R2 secrets missing in GitHub: " + ",".join(missing) + " (pods would start without R2 writes)")
    # Vercel env (production + preview)
    tok, proj, team = os.environ.get("VERCEL_TOKEN"), os.environ.get("VERCEL_PROJECT_ID"), os.environ.get("VERCEL_ORG_ID")
    if not (tok and proj and team):
        fail("VERCEL_TOKEN / VERCEL_PROJECT_ID / VERCEL_ORG_ID missing")
    V = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    base = f"https://api.vercel.com/v10/projects/{proj}/env"
    st, body = req(f"{base}?teamId={team}", headers=V)
    if st != 200:
        fail(f"Vercel env list failed: HTTP {st}")
    have = {}
    for e in json.loads(body).get("envs", []):
        if e["key"] in KEYS and {"production", "preview"} <= set(e.get("target", [])):
            st, one = req(f"https://api.vercel.com/v1/projects/{proj}/env/{e['id']}?teamId={team}", headers=V)
            if st == 200:   # decrypted value, hashed at once and only compared
                have[e["key"]] = h(json.loads(one).get("value") or "")
    changed = [k for k in KEYS if have.get(k) != h(vals[k])]
    for k in changed:
        st, _ = req(f"{base}?teamId={team}&upsert=true", "POST", json.dumps(
            {"key": k, "value": vals[k], "type": "encrypted", "target": ["production", "preview"]}).encode(), V)
        if st not in (200, 201):
            fail(f"Vercel env upsert {k} failed: HTTP {st}")
    print(f"vercel env: {len(KEYS) - len(changed)} unchanged, {len(changed)} updated ({','.join(changed) or '-'})")
    # durable copy for pods
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
