"""R2 is always the strip write destination, however the pod was started."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from infinite_tapestry import store as st

ROOT = Path(__file__).resolve().parents[1]
KEYS = {"R2_ENDPOINT": "https://acct.r2.cloudflarestorage.com", "R2_ACCESS_KEY_ID": "kid",
        "R2_SECRET_ACCESS_KEY": "sec", "R2_PUBLIC_URL": "https://pub-x.r2.dev", "R2_BUCKET": "tapestry-strips"}


def test_missing_keys_are_loaded_from_the_durable_copy():
    env = {"SUPABASE_URL": "https://p.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "srk"}
    body = "".join(f"{k}={v}\n" for k, v in KEYS.items()) + "OTHER=x\n"
    assert st.ensure_r2_env(env, fetch=lambda: body.encode()) == "supabase"
    assert all(env[k] == v for k, v in KEYS.items()) and "OTHER" not in env


def test_env_keys_win_and_no_fetch_when_complete():
    env = dict(KEYS)
    assert st.ensure_r2_env(env, fetch=lambda: (_ for _ in ()).throw(AssertionError("fetched"))) == "env"


def test_unreachable_copy_reports_none():
    env = {"SUPABASE_URL": "https://p.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "srk"}

    def boom():
        raise OSError("down")
    assert st.ensure_r2_env(env, fetch=boom) == "none"


def test_legacy_off_switch_is_ignored(monkeypatch):
    for k, v in KEYS.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("TAPESTRY_R2", "0")
    monkeypatch.setattr(st.R2Public, "__init__", lambda self, *a: None)
    assert st.R2Public.from_env() is not None


def test_health_is_degraded_when_r2_writes_are_unavailable():
    from fastapi.testclient import TestClient

    from infinite_tapestry.buffer import StripBuffer
    from infinite_tapestry.config import Config
    from infinite_tapestry.generator import StripGenerator
    from infinite_tapestry.mock_inpaint import MockInpainter
    from infinite_tapestry.server import create_app

    class _M:
        def __init__(self, ok):
            self.ok = ok

        def health(self):
            return {"r2": {"configured": self.ok, "write_ok": self.ok, "error": "" if self.ok else "missing R2_ENDPOINT"}}

        def public_base(self):
            return None

    cfg = Config(mock=True, height=32, window_width=64, strip_width=16, overlap=4, buffer_target=3, buffer_min=1)
    for ok, want in ((False, "degraded"), (True, "ok")):
        gen = StripGenerator(cfg, MockInpainter(cfg), StripBuffer(target=3, minimum=1))
        gen.store = type("S", (), {"mirror": _M(ok), "load_meta": lambda self: {}})()
        body = TestClient(create_app(cfg, gen.buffer, gen)).get("/health").json()
        assert body["ok"] is True and body["status"] == want
        assert bool(body["alarms"]) is (not ok)


def test_watchdog_heals_when_keys_appear(monkeypatch):
    monkeypatch.setattr(st.SupabaseMirror, "R2_RECHECK_S", 0.05)
    calls = {"n": 0}

    class _R2:
        bucket, _cors = "b", (0.0, True)

        def put(self, *a):
            pass

        def cors_ok(self):
            return True

    def from_env(cls):
        calls["n"] += 1
        return None if calls["n"] < 3 else _R2()
    monkeypatch.setattr(st.R2Public, "from_env", classmethod(from_env))
    seen = []
    m = st.SupabaseMirror("https://x.supabase.co", "k", prefix="t")
    m.on_r2_change = lambda ok, why: seen.append(ok)
    import time
    for _ in range(100):
        if m.r2_write_ok:
            break
        time.sleep(0.02)
    assert m.r2_write_ok is True and m.health()["r2"]["configured"]


def test_forced_refresh_overwrites_rotated_keys_and_reports_change():
    env = {**KEYS, "SUPABASE_URL": "https://p.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "srk"}
    rotated = {**KEYS, "R2_SECRET_ACCESS_KEY": "sec2"}
    body = "".join(f"{k}={v}\n" for k, v in rotated.items()).encode()
    assert st.ensure_r2_env(env, fetch=lambda: body, force=True) == "supabase" and env["R2_SECRET_ACCESS_KEY"] == "sec2"
    assert st.ensure_r2_env(env, fetch=lambda: body, force=True) == "none"   # nothing changed this time


def test_watchdog_heals_after_key_rotation(monkeypatch):
    monkeypatch.setattr(st.SupabaseMirror, "R2_RECHECK_S", 0.05)

    class _R2:
        bucket, _cors = "b", (0.0, True)

        def __init__(self, good):
            self.good = good

        def put(self, *a):
            if not self.good:
                raise RuntimeError("InvalidAccessKeyId")

    made = {"n": 0}

    def from_env(cls):
        made["n"] += 1
        return _R2(made["n"] > 1)   # first client has the revoked key, the rebuilt one the rotated key
    monkeypatch.setattr(st.R2Public, "from_env", classmethod(from_env))
    monkeypatch.setattr(st, "ensure_r2_env", lambda env=None, fetch=None, force=False: "supabase" if force else "env")
    m = st.SupabaseMirror("https://x.supabase.co", "k", prefix="t")
    import time
    for _ in range(100):
        if m.r2_write_ok:
            break
        time.sleep(0.02)
    assert m.r2_write_ok is True and made["n"] == 2 and st.R2Public.creds_source == "supabase"


def test_ci_sync_fails_loudly_without_r2_secrets():
    env = {"PATH": os.environ["PATH"], "R2_ENDPOINT": "x"}
    r = subprocess.run([sys.executable, str(ROOT / "scripts/ci_sync_r2.py"), "sync"], capture_output=True, text=True, env=env)
    assert r.returncode == 1 and "::error::R2 secrets missing" in r.stdout and "x" not in r.stdout.split("missing")[0][-3:]
    assert "R2_ACCESS_KEY_ID" in r.stdout


def test_ci_workflow_syncs_and_checks_r2():
    wf = (ROOT / ".github/workflows/ci.yml").read_text()
    assert "scripts/ci_sync_r2.py sync" in wf and "scripts/ci_sync_r2.py check" in wf
    for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL", "R2_BUCKET", "R2_ACCOUNT_ID"):
        assert f"{k}: ${{{{ secrets.{k} }}}}" in wf


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_gpu_js_pod_env_carries_r2_and_never_disables_it():
    script = "const {podEnv}=require('./web/lib/gpu.js'); console.log(JSON.stringify([podEnv(%s), podEnv({})]))" % json.dumps(
        {**KEYS, "SUPABASE_URL": "u"})
    r = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True,
                       env={"PATH": os.environ["PATH"]})
    assert r.returncode == 0, r.stderr
    full, bare = json.loads(r.stdout)
    assert all(full[k] == v for k, v in KEYS.items())
    assert "TAPESTRY_R2" not in full and "TAPESTRY_R2" not in bare
    assert "TAPESTRY_SUPABASE_PUBLIC" not in full   # no Supabase Storage copies any more


def test_provision_puts_r2_in_the_runpod_env():
    sys.path.insert(0, str(ROOT / "scripts/pod"))
    import provision
    out = provision.pod_env({**KEYS, "SUPABASE_URL": "u"}, "ssh-ed25519 X")
    assert '"R2_SECRET_ACCESS_KEY"' in out and '"PUBLIC_KEY"' in out and "TAPESTRY_R2\"" not in out


def test_selfboot_drops_the_off_switch_and_falls_back_to_the_durable_copy():
    src = (ROOT / "scripts/pod/selfboot.sh").read_text()
    assert "grep -v '^TAPESTRY_R2='" in src and "deploy/secrets/r2.env" in src
