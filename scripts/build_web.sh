#!/usr/bin/env bash
# Assemble the Vercel app: static frontend + serverless functions + public config.
# Usage: WS_URL=wss://<pod>-8000.proxy.runpod.net/ws SUPABASE_URL=... SUPABASE_ANON_KEY=... scripts/build_web.sh OUT_DIR
set -euo pipefail
OUT=${1:-/tmp/tapestry-web-build}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$OUT" && mkdir -p "$OUT"
cp -r "$ROOT"/static/* "$OUT"/
cp -r "$ROOT"/web/api "$ROOT"/web/lib "$ROOT"/web/package.json "$ROOT"/web/vercel.json "$OUT"/
# Default matches the live 4090 burn rate; override with TAPESTRY_CENTS_PER_HOUR.
cat > "$OUT/config.js" <<CFG
window.TAPESTRY_CONFIG = {
  wsUrl: "${WS_URL:-}",
  supabaseUrl: "${SUPABASE_URL:-}",
  supabaseAnonKey: "${SUPABASE_ANON_KEY:-}",
  turnstileSiteKey: "${TURNSTILE_SITE_KEY:-}",
  google: ${TAPESTRY_GOOGLE_LOGIN:-false},
  centsPerHour: ${TAPESTRY_CENTS_PER_HOUR:-89}
};
CFG
# Facebook/LinkedIn/iMessage need absolute og/twitter image URLs.
SITE="${SITE_URL:-https://infinite-tapestry.vercel.app}"
SITE="${SITE%/}"
for f in "$OUT/index.html" "$OUT/profile.html"; do
  [ -f "$f" ] || continue
  sed -i "s|content=\"/brand/og.jpg\"|content=\"${SITE}/brand/og.jpg\"|g" "$f"
done
if [ -f "$OUT/index.html" ] && ! grep -q 'property="og:url"' "$OUT/index.html"; then
  sed -i "s|<meta property=\"og:type\" content=\"website\" />|<meta property=\"og:type\" content=\"website\" />\n  <meta property=\"og:url\" content=\"${SITE}/\" />|" "$OUT/index.html"
fi
echo "built $OUT"
