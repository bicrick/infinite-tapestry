# Contributing

Thanks for your interest in Infinite Tapestry. Issues and pull requests are welcome.

## Getting started

```bash
make setup   # .venv + package + test deps (Python 3.10+)
make test    # pytest + JS syntax check (needs Node); no secrets, no network
make dev     # CPU mock worker + viewer at http://127.0.0.1:8000
```

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
