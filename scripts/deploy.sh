#!/usr/bin/env bash
# The one deploy path: tests pass locally, main is pushed, CI does the rest (tests -> worker release if the worker
# changed -> secrets sync -> Vercel prod deploy + smoke test + domains -> pod R2 check). The pod's supervisor picks up
# a new worker release within ~2 minutes and rolls back by itself if it does not come up healthy.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "deploy from main (or open a PR for a preview)"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first"; exit 1; }
make -s test
git pull --ff-only -q origin main
git push origin main
command -v gh >/dev/null || { echo "pushed; follow the run at https://github.com/$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')/actions"; exit 0; }
SHA=$(git rev-parse HEAD)
for i in $(seq 1 20); do ID=$(gh run list -w ci.yml -c "$SHA" -L1 --json databaseId -q '.[0].databaseId' 2>/dev/null); [ -n "$ID" ] && break; sleep 3; done
gh run watch "$ID" --exit-status
