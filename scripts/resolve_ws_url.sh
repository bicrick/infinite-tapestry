#!/usr/bin/env bash
# Prints WS_URL=wss://<pod>-8000.proxy.runpod.net/ws for the CURRENT pod (Supabase pod_state.pod_id, the same
# source the API and /api/live use). If the pod is off/unhealthy it still prints that URL with a warning: the client
# follows /api/live's pod.ws at runtime, so config.js wsUrl is only a first-paint hint. Never hardcode a pod id.
# Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Usage: eval "$(scripts/resolve_ws_url.sh)" or >> $GITHUB_ENV
set -euo pipefail
# Supabase may be slow or unreachable, so this makes a few bounded tries and then falls back to the pod id the live site already uses (config.js wsUrl) so a DB blip never blocks a deploy.
POD=""
for n in 1 2 3; do
  POD=$(curl -sf --connect-timeout 5 -m 15 "$SUPABASE_URL/rest/v1/pod_state?id=eq.1&select=pod_id" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    | python3 -c 'import json,sys; r=json.load(sys.stdin); print((r[0].get("pod_id") or "") if r else "")' 2>/dev/null) || POD=""
  [[ "$POD" =~ ^[a-z0-9]+$ ]] && break
  sleep 5
done
if ! [[ "$POD" =~ ^[a-z0-9]+$ ]]; then
  LIVE="${SITE_URL:-https://infinitetapestry.app}"
  POD=$(curl -sf -m 15 "$LIVE/config.js" | sed -n 's#.*wss://\([a-z0-9]*\)-8000\.proxy\.runpod\.net/ws.*#\1#p' | head -n1 || true)
  [[ "$POD" =~ ^[a-z0-9]+$ ]] && echo "::warning::Supabase pod_state unreachable; reusing live config.js pod $POD" >&2
fi
[[ "$POD" =~ ^[a-z0-9]+$ ]] || { echo "::error::pod_state.pod_id is empty/invalid and no live config.js fallback" >&2; exit 1; }
for n in 1 2 3 4 5; do
  if curl -sf -m 10 "https://$POD-8000.proxy.runpod.net/health" -o /dev/null; then echo "WS_URL=wss://$POD-8000.proxy.runpod.net/ws"; exit 0; fi
  sleep 6
done
echo "::warning::pod $POD /health does not respond (GPU off or booting); config.js points at it anyway, clients follow /api/live" >&2
echo "WS_URL=wss://$POD-8000.proxy.runpod.net/ws"
