#!/usr/bin/env bash
# Assemble the Vercel app: static frontend + serverless functions + public config.
# Usage: WS_URL=wss://<pod>-8000.proxy.runpod.net/ws SUPABASE_URL=... SUPABASE_ANON_KEY=... scripts/build_web.sh OUT_DIR
set -euo pipefail
OUT=${1:-/tmp/tapestry-web-build}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$OUT" && mkdir -p "$OUT"
cp -r "$ROOT"/static/* "$OUT"/
cp -r "$ROOT"/web/api "$ROOT"/web/lib "$ROOT"/web/package.json "$ROOT"/web/vercel.json "$OUT"/
cat > "$OUT/config.js" <<CFG
window.TAPESTRY_CONFIG = {
  wsUrl: "${WS_URL:-}",
  supabaseUrl: "${SUPABASE_URL:-}",
  supabaseAnonKey: "${SUPABASE_ANON_KEY:-}",
  google: ${TAPESTRY_GOOGLE_LOGIN:-false},
  centsPerHour: ${TAPESTRY_CENTS_PER_HOUR:-20}
};
CFG
echo "built $OUT"
