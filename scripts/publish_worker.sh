#!/usr/bin/env bash
# Package the pod worker at HEAD as a versioned release: deploy/worker/<sha>.tgz + latest.txt (private Supabase
# bucket `deploy`). Running pods poll latest.txt (scripts/pod/supervise.sh) and switch to a new release by themselves.
# Skipped when the worker code is unchanged since the current release (web-only commits never restart the pod).
# Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Usage: scripts/publish_worker.sh [--no-latest] [--force]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
SHA=$(git rev-parse HEAD)
# Content id of everything the pod runs (static/ ships too, but Vercel serves the site, so it does not count).
TREE=$(for p in infinite_tapestry scripts/pod pyproject.toml requirements.txt; do git rev-parse "HEAD:$p"; done | sha1sum | cut -c1-40)
B="$SUPABASE_URL/storage/v1/object/deploy/worker"
A=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")
R=(--retry 6 --retry-all-errors --retry-delay 5 --max-time 120)
CUR=$(curl -sf "${R[@]}" "${A[@]}" "$B/latest.tree?t=$(date +%s)" 2>/dev/null | tr -dc 'a-f0-9' || true)
if [ "$CUR" = "$TREE" ] && [[ " $* " != *" --force "* ]]; then
  echo "worker unchanged (tree ${TREE:0:12}); not publishing, the pod keeps its release"; exit 0
fi
T=$(mktemp -d)/w.tgz
tar czf "$T" --exclude='__pycache__' infinite_tapestry static pyproject.toml requirements.txt scripts/pod
curl -sf "${R[@]}" "${A[@]}" -H "x-upsert: true" -H "content-type: application/gzip" --data-binary @"$T" "$B/$SHA.tgz" > /dev/null
if [[ " $* " != *" --no-latest "* ]]; then
  printf '%s\n' "$SHA" | curl -sf "${R[@]}" "${A[@]}" -H "x-upsert: true" -H "content-type: text/plain" --data-binary @- "$B/latest.txt" > /dev/null
  printf '%s\n' "$TREE" | curl -sf "${R[@]}" "${A[@]}" -H "x-upsert: true" -H "content-type: text/plain" --data-binary @- "$B/latest.tree" > /dev/null
fi
# Keep the newest KEEP_RELEASES tarballs (rollback targets); older ones are deleted.
python3 - "$SHA" <<'PY' || echo "release prune failed (non-fatal)"
import json, os, sys, urllib.request
u, k = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": k, "Authorization": f"Bearer {k}", "Content-Type": "application/json"}
def call(path, method, body):
    return json.loads(urllib.request.urlopen(urllib.request.Request(f"{u}/storage/v1/object/{path}", method=method,
                      headers=H, data=json.dumps(body).encode()), timeout=60).read() or b"[]")
rel = [e for e in call("list/deploy", "POST", {"prefix": "worker/", "limit": 1000}) if e["name"].endswith(".tgz")]
rel.sort(key=lambda e: e.get("created_at") or "", reverse=True)
old = [f"worker/{e['name']}" for e in rel[int(os.environ.get("KEEP_RELEASES", "8")):] if not e["name"].startswith(sys.argv[1])]
if old:
    call("deploy", "DELETE", {"prefixes": old})
print(f"releases kept {min(len(rel), len(rel) - len(old))}, pruned {len(old)}")
PY
curl -sf -X POST "$SUPABASE_URL/rest/v1/deploy_log" "${A[@]}" -H "Content-Type: application/json" -H "Prefer: return=minimal" \
  -d "{\"kind\":\"worker\",\"sha\":\"$SHA\",\"run_id\":\"${GITHUB_RUN_ID:-}\"}" > /dev/null || echo "deploy_log write failed (non-fatal)"
echo "published worker $SHA (tree ${TREE:0:12})"
