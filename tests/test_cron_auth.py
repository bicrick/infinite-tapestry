"""/api/tm jobs require Authorization: Bearer $CRON_SECRET (Vercel Cron sends it); the old User-Agent gate is gone."""
import json, os, shutil, subprocess, pytest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")

JS = r"""
const Module = require("module"); const orig = Module._load;
Module._load = function (r, ...a) {
  if (r.endsWith("lib/tmbuild")) return { runIndex: async () => ({ ok: 1 }), getJSON: async () => null };
  if (r.endsWith("lib/tmtiles")) return { runTiles: async () => ({ ok: 1 }), key: () => "", tileObj: async () => null };
  return orig.call(this, r, ...a);
};
const h = require(process.argv[1]);
const run = (headers) => new Promise((ok) => {
  const res = { statusCode: 0, setHeader() {}, status(c) { this.statusCode = c; return this; }, json() { ok(this.statusCode); }, end() { ok(this.statusCode); }, send() { ok(this.statusCode); } };
  h({ url: "/api/tm?job=all", headers }, res);
});
(async () => {
  const out = {
    ua: await run({ "user-agent": "vercel-cron/1.0" }),
    none: await run({}),
    wrong: await run({ authorization: "Bearer nope" }),
    good: await run({ authorization: "Bearer " + process.env.CRON_SECRET }),
  };
  console.log(JSON.stringify(out));
})();
"""


def _run(secret):
    env = {**os.environ, "SUPABASE_URL": "http://x", "SUPABASE_SERVICE_ROLE_KEY": "k"}
    env.pop("CRON_SECRET", None)
    if secret is not None:
        env["CRON_SECRET"] = secret
    p = subprocess.run([NODE, "-e", JS, str(ROOT / "web/api/tm.js")], capture_output=True, text=True, env=env, timeout=30)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout.strip().splitlines()[-1])


@pytest.mark.skipif(not NODE, reason="node not installed")
def test_cron_requires_bearer():
    r = _run("t" * 40)
    assert r == {"ua": 401, "none": 401, "wrong": 401, "good": 200}


@pytest.mark.skipif(not NODE, reason="node not installed")
def test_cron_fails_closed_without_secret():
    r = _run(None)
    assert r["good"] == 401 and r["ua"] == 401


def test_no_user_agent_gate_and_manifest():
    src = (ROOT / "web/api/tm.js").read_text()
    assert "vercel-cron" not in src and "CRON_SECRET" in src
    m = json.loads((ROOT / "scripts/ci/secrets.json").read_text())
    assert m["CRON_SECRET"]["required"] is True and "production" in m["CRON_SECRET"]["targets"]
