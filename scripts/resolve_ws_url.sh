#!/usr/bin/env bash
# Prints WS_URL=wss://<pod>-8000.proxy.runpod.net/ws for the CURRENT pod (Supabase pod_state.pod_id, the same
# source the API and /api/live use) and fails unless that pod's /health answers. Never hardcode a pod id.
# Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Usage: eval "$(scripts/resolve_ws_url.sh)" or >> $GITHUB_ENV
set -euo pipefail
POD=$(curl -sf "$SUPABASE_URL/rest/v1/pod_state?id=eq.1&select=pod_id" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print((r[0].get("pod_id") or "") if r else "")')
[[ "$POD" =~ ^[a-z0-9]+$ ]] || { echo "::error::pod_state.pod_id is empty/invalid" >&2; exit 1; }
for n in 1 2 3 4 5; do
  if curl -sf -m 10 "https://$POD-8000.proxy.runpod.net/health" -o /dev/null; then echo "WS_URL=wss://$POD-8000.proxy.runpod.net/ws"; exit 0; fi
  sleep 6
done
echo "::error::pod $POD /health does not respond; refusing to build a config pointing at it" >&2
exit 1
