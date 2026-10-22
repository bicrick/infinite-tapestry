# Infinite Tapestry - everyday commands. Values come from ./.env if present (copy .env.example).
-include .env
export
PY      ?= .venv/bin/python
PORT    ?= 8000
DATA    ?= .data

.PHONY: help setup dev dev-ui dev-gpu test web deploy redeploy redeploy-worker health
help:            ## list targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/' | expand -t18

setup:           ## create .venv and install the package + test deps (CPU only), and the frontend toolchain (npm ci)
	python3 -m venv .venv && $(PY) -m pip install -q -U pip && $(PY) -m pip install -q -e ".[dev]"
	npm ci --no-audit --no-fund

dev:             ## build the frontend, then run the worker with the CPU mock generator at http://127.0.0.1:$(PORT) (viewer included)
	npm run build
	$(PY) -m infinite_tapestry.main --mock --port $(PORT) --data-dir $(DATA)

dev-ui:          ## Vite dev server (hot reload) at http://127.0.0.1:5173, proxying /ws etc. to a running `make dev` worker
	npm run dev

dev-gpu:         ## run the real SDXL worker (24 GB GPU; pip install -e ".[gpu]" first)
	$(PY) -m infinite_tapestry.main --backend sdxl --port $(PORT) --data-dir $(DATA)

test:            ## python tests + frontend typecheck/unit tests + JS syntax check of web/ (no network, no secrets)
	env -u SUPABASE_URL -u SUPABASE_SERVICE_ROLE_KEY $(PY) -m pytest -q
	npm run check
	find web scripts -type f \( -name '*.js' -o -name '*.mjs' \) -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check

web:             ## build the Vercel bundle into dist/web (what CI deploys)
	bash scripts/build_web.sh dist/web

deploy:          ## test, push main, and follow the CI deploy (web + worker if it changed)
	bash scripts/deploy.sh

redeploy:        ## re-run the CI deploy of main without a new commit
	gh workflow run ci.yml --ref main && sleep 5 && gh run watch $$(gh run list -w ci.yml -L1 --json databaseId -q '.[0].databaseId')

redeploy-worker: ## same, and force the pod onto a fresh worker release
	gh workflow run ci.yml --ref main -f force_worker=true && sleep 5 && gh run watch $$(gh run list -w ci.yml -L1 --json databaseId -q '.[0].databaseId')

health:          ## sample the prod pod's /health for 60 s (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or POD_ID)
	$(PY) scripts/ops/pod_health.py 60
