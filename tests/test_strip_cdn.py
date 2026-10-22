"""Live strip URLs always point at the public R2 bucket (R2 is the only binary store)."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
SB = "https://proj.supabase.co"
R2 = "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev"


def node(script, env=None):
    r = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def bases(extra):
    env = {"PATH": os.environ["PATH"], "SUPABASE_URL": SB}
    env.update(extra)
    script = "const {stripBases} = require('./web/lib/stripcdn.js'); console.log(JSON.stringify(stripBases()));"
    return node(script, env)


def test_strips_always_load_from_r2():
    assert bases({}) == {"strip_base": f"{R2}/live-sdxl/strips/", "lod_base": f"{R2}/live-sdxl/lod/"}
    assert bases({"R2_PUBLIC_URL": "https://cdn.example/"})["strip_base"] == "https://cdn.example/live-sdxl/strips/"
    # Old switches are gone: no Supabase bucket, no fallback bases, no prefix override.
    for extra in ({"TAPESTRY_STRIP_CDN": "supabase"}, {"TAPESTRY_R2": "0"}, {"TAPESTRY_STORAGE_PREFIX": "live"}):
        assert bases(extra) == {"strip_base": f"{R2}/live-sdxl/strips/", "lod_base": f"{R2}/live-sdxl/lod/"}


def test_client_has_no_supabase_strip_fallback():
    src = (ROOT / "frontend/src/legacy/client.js").read_text()
    assert "strip_base_fb" not in src and "stripCdn" not in src and "cdnBase" not in src


def test_live_handler_delegates_bases():
    src = (ROOT / "web/api/live.js").read_text()
    assert "stripBases()" in src
    assert "pub-631bdb4d40c54807b1c2de9402e07893" not in src


def _build(out, extra):
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("R2_") or key.startswith("TAPESTRY_") or key in ("WS_URL", "SUPABASE_URL", "SUPABASE_ANON_KEY"):
            env.pop(key, None)
    env.update({"SUPABASE_URL": SB, "SUPABASE_ANON_KEY": "anon", "WS_URL": "wss://example/ws"})
    env.update(extra)
    r = subprocess.run(["bash", "scripts/build_web.sh", str(out)], cwd=ROOT, capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    return (out / "config.js").read_text()


def test_build_has_no_strip_cdn_switch(tmp_path):
    cfg = _build(tmp_path / "plain", {"R2_PUBLIC_URL": R2, "TAPESTRY_STRIP_CDN": "r2"})
    assert "cdnBase" not in cfg and "stripCdn" not in cfg


def test_live_reports_pod_heartbeat():
    src = (ROOT / "web/api/live.js").read_text()
    assert "ops_heartbeat" in src and "heartbeat_at" in src
    client = (ROOT / "frontend/src/legacy/client.js").read_text()
    assert "j.heartbeat_at" in client


def test_client_stream_hardening():
    src = (ROOT / "frontend/src/legacy/client.js").read_text()
    assert "v=2&bytes=1" in src                     # live strip bytes on the socket
    assert "SW() * 6) livePos = projected" not in src   # no 6-strip snap
    assert "livePos = null;\n" not in src.split("ws.onopen")[1].split("ws.onmessage")[0]   # kept on reconnect
    assert "lastMsgAt" in src and "10000" in src    # dead-socket watchdog
