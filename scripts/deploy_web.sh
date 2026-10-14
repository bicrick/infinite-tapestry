#!/usr/bin/env bash
# Build + deploy the app to a Vercel PREVIEW, then point the Stripe webhook and the
# Supabase cron controller at the new deployment. Never deploys to production.
# Needs: VERCEL_TOKEN, STRIPE_TEST_SECRET_KEY, SUPABASE_ACCESS_TOKEN, ~/.tapestry/{supabase,app}.env
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${OUT:-/workspace/tapestry-app}
set -a; . ~/.tapestry/supabase.env; . ~/.tapestry/app.env; set +a
mkdir -p /tmp/keep && cp -r "$OUT/.vercel" /tmp/keep/ 2>/dev/null || true
if [ -z "${WS_URL:-}" ]; then eval "$("$ROOT/scripts/resolve_ws_url.sh")"; export WS_URL; fi
echo "ws: $WS_URL"
"$ROOT/scripts/build_web.sh" "$OUT" >/dev/null
cp -r /tmp/keep/.vercel "$OUT/" && printf '.env*\n' > "$OUT/.vercelignore"
cd "$OUT"
URL=$(npx -y vercel@latest deploy --yes --token "$VERCEL_TOKEN" 2>/dev/null | grep -o 'https://[a-z0-9.-]*vercel.app' | tail -1)
echo "deployment: $URL"
npx -y vercel@latest alias set "$URL" infinite-tapestry-preview.vercel.app --token "$VERCEL_TOKEN" >/dev/null 2>&1 || true
curl -s "https://api.stripe.com/v1/webhook_endpoints/$STRIPE_WEBHOOK_ID" -u "$STRIPE_TEST_SECRET_KEY:" \
  -d "url=$URL/api/stripe-webhook?x-vercel-protection-bypass=$VERCEL_BYPASS" -o /dev/null -w "stripe webhook -> %{http_code}\n"
python3 - "$URL/api/controller?x-vercel-protection-bypass=$VERCEL_BYPASS" <<'PY'
import json, os, sys, urllib.request
url = sys.argv[1]
sql = ("do $$ begin "
       "if exists (select 1 from vault.secrets where name='controller_url') then "
       "perform vault.update_secret((select id from vault.secrets where name='controller_url'), %(u)s); "
       "else perform vault.create_secret(%(u)s, 'controller_url'); end if; "
       "if not exists (select 1 from vault.secrets where name='controller_secret') then "
       "perform vault.create_secret(%(s)s, 'controller_secret'); "
       "else perform vault.update_secret((select id from vault.secrets where name='controller_secret'), %(s)s); end if; end $$;")
q = lambda v: "'" + v.replace("'", "''") + "'"
sql = sql % {"u": q(url), "s": q(os.environ["CONTROLLER_SECRET"])}
req = urllib.request.Request("https://api.supabase.com/v1/projects/vforasrnktvqzukusejq/database/query",
    data=json.dumps({"query": sql}).encode(), headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"], "Content-Type": "application/json", "User-Agent": "it-deploy"})
print("vault controller_url ->", urllib.request.urlopen(req).status)
PY
echo "$URL" > /workspace/tapestry-app-url.txt
