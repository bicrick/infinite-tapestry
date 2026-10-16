#!/bin/bash
# Boot a worker on a pod created by the GPU switch (web/lib/gpu.js). Secrets arrive as pod env vars; this writes
# /root/.tapestry.env + /root/run.sh, points /root/it at the release ($1) and starts boot.sh (deps, newest release,
# supervisor). Safe to run again on every container start.
set -u
SHA="${1:-}"
umask 077
env | grep -E '^(SUPABASE_|TAPESTRY_|RUNPOD_|R2_)[A-Z0-9_]*=' | while IFS='=' read -r k v; do printf '%s=%q\n' "$k" "$v"; done > /root/.tapestry.env
umask 022
cat > /root/run.sh <<'R'
#!/bin/bash
set -a; . /root/.tapestry.env; set +a
cd /root/it
exec python -m infinite_tapestry.main --host 0.0.0.0 --port 8000 --data-dir /root/data-sdxl
R
chmod +x /root/run.sh
if [ -n "$SHA" ] && [ -f "/root/releases/$SHA/infinite_tapestry/server.py" ]; then
  touch "/root/releases/$SHA/.ok"
  if [ -d /root/it ] && [ ! -L /root/it ]; then mv /root/it /root/it-pre-release; fi
  ln -sfn "/root/releases/$SHA" /root/it
fi
chmod +x /root/it/scripts/pod/*.sh
pkill -f supervise.sh 2>/dev/null || true
echo "$(date -u +%FT%TZ) selfboot: release ${SHA:-?}"
exec bash /root/it/scripts/pod/boot.sh
