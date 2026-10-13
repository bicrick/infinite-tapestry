#!/bin/bash
# Pull the newest CI-built worker release (Supabase Storage, private bucket `deploy`) into /root/releases/<sha>
# and point /root/it at it. Any failure keeps the current /root/it, so a restart never loses working code.
set -u
set -a; . /root/.tapestry.env; set +a
B="$SUPABASE_URL/storage/v1/object/deploy/worker"
H=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")
SHA=$(curl -sf --max-time 15 "${H[@]}" "$B/latest.txt" | tr -dc 'a-f0-9' | head -c 40) || SHA=""
[ -n "$SHA" ] || { echo "fetch_release: no latest.txt, keeping /root/it"; exit 0; }
D=/root/releases/$SHA
if [ ! -f "$D/.ok" ]; then
  mkdir -p "$D" && curl -sf --max-time 60 "${H[@]}" "$B/$SHA.tgz" -o /tmp/w.tgz && tar xzf /tmp/w.tgz -C "$D" \
    && [ -f "$D/infinite_tapestry/server.py" ] && touch "$D/.ok" || { echo "fetch_release: download failed, keeping /root/it"; rm -rf "$D"; exit 0; }
fi
# /root/it becomes a symlink to the release (the old directory is kept once as /root/it-pre-release).
if [ -d /root/it ] && [ ! -L /root/it ]; then mv /root/it /root/it-pre-release; fi
ln -sfn "$D" /root/it.new && mv -T /root/it.new /root/it
echo "fetch_release: /root/it -> $SHA"
