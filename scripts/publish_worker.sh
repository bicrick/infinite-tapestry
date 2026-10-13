#!/usr/bin/env bash
# Package the pod worker at HEAD and upload it as a versioned release: deploy/worker/<sha>.tgz + latest.txt.
# Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Usage: scripts/publish_worker.sh [--no-latest]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
SHA=$(git rev-parse HEAD)
T=$(mktemp -d)/w.tgz
tar czf "$T" --exclude='__pycache__' infinite_tapestry static pyproject.toml requirements.txt scripts/pod
B="$SUPABASE_URL/storage/v1/object/deploy/worker"
H=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "x-upsert: true")
curl -sf "${H[@]}" -H "content-type: application/gzip" --data-binary @"$T" "$B/$SHA.tgz" > /dev/null
[ "${1:-}" = "--no-latest" ] || printf '%s\n' "$SHA" | curl -sf "${H[@]}" -H "content-type: text/plain" --data-binary @- "$B/latest.txt" > /dev/null
echo "published worker $SHA"
