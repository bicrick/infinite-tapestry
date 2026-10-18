#!/bin/bash
# Keep the app process alive: restart it whenever it exits (crash, OOM, manual kill), with backoff.
# Usage (pod start command): nohup /root/it/scripts/pod/supervise.sh >> /root/supervise.log 2>&1 &
N=0
# Release follower: every RELEASE_POLL_S, if deploy/worker/latest.txt names a release other than the one /root/it
# points at, fetch it and restart the app on it. If the new release does not answer /health within 5 minutes, go back
# to the previous one and never retry that sha (CI publishes a release only when the worker code changed).
RELEASE_POLL_S=${RELEASE_POLL_S:-120}
(
  BAD=""
  while true; do
    sleep "$RELEASE_POLL_S"
    [ -f /root/supervise.pause ] && continue
    set -a; . /root/.tapestry.env 2>/dev/null; set +a
    [ -n "${SUPABASE_URL:-}" ] || continue
    NEW=$(curl -sf --retry 3 --retry-all-errors --max-time 15 -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
          "$SUPABASE_URL/storage/v1/object/deploy/worker/latest.txt?t=$(date +%s)" | tr -dc 'a-f0-9' | head -c 40) || continue
    CUR=$(basename "$(readlink -f /root/it)")
    [ -n "$NEW" ] && [ "$NEW" != "$CUR" ] && [ "$NEW" != "$BAD" ] || continue
    PREV=$(readlink -f /root/it)
    bash /root/it/scripts/pod/fetch_release.sh || continue
    [ "$(basename "$(readlink -f /root/it)")" = "$NEW" ] || continue
    echo "$(date -u +%FT%TZ) supervise: release ${CUR:0:7} -> ${NEW:0:7}, restarting app"
    P=$(pgrep -f "m infinite_[t]apestry.main" | head -1)
    if [ -n "$P" ]; then kill "$P"; for i in $(seq 1 25); do kill -0 "$P" 2>/dev/null || break; sleep 1; done; kill -9 "$P" 2>/dev/null; fi
    OK=0; for i in $(seq 1 60); do sleep 5; curl -sf -m 3 localhost:8000/health >/dev/null && { OK=1; break; }; done
    if [ $OK = 0 ]; then
      echo "$(date -u +%FT%TZ) supervise: release ${NEW:0:7} never became healthy; back to $(basename "$PREV" | cut -c1-7)"
      BAD=$NEW; ln -sfn "$PREV" /root/it.new && mv -T /root/it.new /root/it
      P=$(pgrep -f "m infinite_[t]apestry.main" | head -1); [ -n "$P" ] && kill -9 "$P"
    fi
  done
) &
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
