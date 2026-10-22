# Contributing

Thanks for your interest in Infinite Tapestry. Issues and pull requests are welcome.

## Getting started

```bash
make setup   # .venv + package + test deps (Python 3.10+) + npm ci (Node 20+)
make test    # pytest + npm run check (tsc + Vitest) + JS syntax check; no secrets, no network
make dev     # npm run build, then CPU mock worker + viewer at http://127.0.0.1:8000
make dev-ui  # Vite dev server with hot reload, against the worker from make dev
```

The frontend lives in `frontend/` (Vite + strict TypeScript). The live viewer is `frontend/src/viewer/`: `camera.ts`
(what's on screen, zoom), `live-follower.ts` (shared clock), `motion.ts` (scroll physics), `renderer.ts` (the one
rAF loop), `strips.ts` / `lod.ts` / `timeline.ts` (data), `app.ts` (wiring and page chrome). Unit tests sit next to
the code (`*.test.ts`, Vitest). UI changes need pixel parity unless they are meant to change the look:
`scripts/dev/parity.mjs` diffs two builds (desktop + phone, dark + light).

The mock backend paints placeholder strips on the CPU, so you can work on the viewer, the server and the director
without a GPU. `make dev-gpu` runs the real SDXL worker on a 24 GB GPU (`pip install -e ".[gpu]"` first).

## Pull requests

- Keep changes focused, and include a test when you change behavior (`tests/` runs on the CPU with no network).
- Run `make test` before opening the PR.
- CI runs the tests on every pull request. Runs for pull requests from outside contributors need a maintainer's
  approval before they start. Pull requests never deploy to production.
- Describe what changed and why; screenshots help for UI changes.

## Reporting bugs and ideas

Use the issue templates. Please don't include secrets, tokens or personal data in issues. Security problems go
through [SECURITY.md](SECURITY.md), not public issues.

## Licenses

Code contributions are accepted under the [MIT License](LICENSE). The model weights the worker downloads keep their
own licenses (see "License and models" in the README).
