#!/bin/bash
# Keep the app process alive: restart it whenever it exits (crash, OOM, manual kill), with backoff.
# Usage (pod start command): nohup /root/it/scripts/pod/supervise.sh >> /root/supervise.log 2>&1 &
N=0
# Stall watchdog: the process can be alive but stuck. If no strip has been written for 5 minutes
# (and the app has been up for more than 6), kill it so the loop below restarts it.
(
  while true; do
    sleep 60
    [ -f /root/supervise.pause ] && continue
    P=$(pgrep -f "m infinite_[t]apestry.main" | head -1); [ -n "$P" ] || continue
    UP=$(( $(date +%s) - $(stat -c %Y /proc/$P) ))
    AGE=$(( $(date +%s) - $(stat -c %Y /root/data-sdxl/strips.jsonl 2>/dev/null || date +%s) ))
    if [ $UP -gt 360 ] && [ $AGE -gt 300 ]; then
      # No new strip is only a stall if the app should be painting. With nobody watching, the shared clock is
      # viewer-driven and the buffer sits full by design (was: a restart + model reload every ~6 min, all day).
      H=$(curl -s -m 10 localhost:8000/health || true)
      IDLE=$(printf '%s' "$H" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin); b = d["buffer"]
    print(1 if d.get("viewers", 0) == 0 and b["depth"] >= b["target"] else 0)
except Exception:
    print(0)' 2>/dev/null)
      if [ "$IDLE" = "1" ]; then
        [ $(( AGE % 1800 )) -lt 60 ] && echo "$(date -u +%FT%TZ) supervise: idle (0 viewers, buffer full), no strip for ${AGE}s is fine"
      else
        echo "$(date -u +%FT%TZ) supervise: no strip for ${AGE}s, restarting app"; kill "$P"; sleep 20; kill -9 "$P" 2>/dev/null
      fi
    fi
  done
) &
while true; do
  [ -f /root/supervise.pause ] && { sleep 5; continue; }   # touch to hold the app down deliberately
  # A supervisor (re)started next to a running app adopts it instead of starting a second one on :8000.
  if pgrep -f "m infinite_[t]apestry.main" >/dev/null; then sleep 5; continue; fi
  START=$(date +%s)
  echo "$(date -u +%FT%TZ) supervise: starting app"
  /root/run.sh >> /root/server.log 2>&1
  RC=$?; UP=$(( $(date +%s) - START ))
  [ $UP -gt 300 ] && N=0 || N=$((N+1))
  WAIT=$(( N < 6 ? 5 * N + 2 : 30 ))
  echo "$(date -u +%FT%TZ) supervise: app exited rc=$RC after ${UP}s, restarting in ${WAIT}s"
  sleep $WAIT
done
