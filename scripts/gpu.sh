#!/usr/bin/env bash
# Turn the Infinite Tapestry prod GPU on/off, or show its status. Same switch as the admin page.
#   scripts/gpu.sh status | on | off [--wait]
# Needs TAPESTRY_GPU_SECRET (= the GPU_CLI_SECRET env var on the Vercel project). Optional TAPESTRY_URL.
#   on  -> resume the pod, or create a replacement if RunPod has no GPU on its host (new pods paint in ~5-10 min)
#   off -> stop the pod (never deleted); the site shows replays
# --wait polls until the state is live (on) or off (off), up to 20 min.
set -euo pipefail
CMD="${1:-status}"; WAIT="${2:-}"
: "${TAPESTRY_GPU_SECRET:?set TAPESTRY_GPU_SECRET (Vercel env GPU_CLI_SECRET)}"
URL="${TAPESTRY_URL:-https://infinitetapestry.app}/api/admin"
case "$CMD" in status) A=gpu_status ;; on) A=gpu_on ;; off) A=gpu_off ;; *) echo "usage: $0 status|on|off [--wait]" >&2; exit 2 ;; esac
call() { curl -sS -m 60 -X POST "$URL" -H "content-type: application/json" -H "x-gpu-secret: $TAPESTRY_GPU_SECRET" -d "{\"action\":\"$1\"}"; }
show() { python3 -c '
import json,sys
d=json.loads(sys.stdin.read() or "{}")
if not d: print("error: empty response (auth?)"); sys.exit(1)
if d.get("ok") is False: print("error:", d.get("error")); sys.exit(1)
up=d.get("uptime_s"); r=d.get("rate_per_hr")
print(f"{d.get(\"state\",\"?\"):9} desired={d.get(\"desired\")} pod={d.get(\"pod_id\")} runpod={d.get(\"runpod\")} gpu={d.get(\"gpu\") or \"-\"}"
      + (f" up={up//60}m" if up else "") + (f" ${r}/h" if r and d.get("runpod")=="RUNNING" else "")
      + (f" strip={d[\"strip_index\"]}" if d.get("strip_index") is not None else "") + (f" action={d[\"action\"]}" if d.get("action") else ""))
if d.get("last_error") and d.get("desired")=="on": print("last_error:", d["last_error"])
print("STATE=" + str(d.get("state")), file=sys.stderr)'; }
OUT=$(call "$A"); echo "$OUT" | show 2>/tmp/gpu_state.$$ || { rm -f /tmp/gpu_state.$$; exit 1; }
if [ "$WAIT" = "--wait" ] && [ "$CMD" != status ]; then
  GOAL=$([ "$CMD" = on ] && echo live || echo off)
  for i in $(seq 80); do
    grep -q "STATE=$GOAL" /tmp/gpu_state.$$ && break
    sleep 15; call gpu_status | show 2>/tmp/gpu_state.$$ || true
  done
fi
rm -f /tmp/gpu_state.$$
