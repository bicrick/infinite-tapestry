"""Live strip URLs stay on the public Supabase bucket unless R2 is actually in use."""
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


def test_public_url_alone_stays_on_supabase():
    got = bases({"R2_PUBLIC_URL": R2})
    assert got["strip_base"] == f"{SB}/storage/v1/object/public/strips/live-sdxl/strips/"
    assert got["lod_base"] == f"{SB}/storage/v1/object/public/strips/live-sdxl/lod/"


def test_session_prefix_defaults_and_overrides():
    assert bases({})["strip_base"].endswith("/strips/live-sdxl/strips/")
    got = bases({"TAPESTRY_STORAGE_PREFIX": "live"})
    assert got["strip_base"] == f"{SB}/storage/v1/object/public/strips/live/strips/"
    assert got["lod_base"] == f"{SB}/storage/v1/object/public/strips/live/lod/"


def test_explicit_r2_opt_in():
    got = bases({"TAPESTRY_STRIP_CDN": "r2", "R2_PUBLIC_URL": R2 + "/"})
    assert got == {"strip_base": f"{R2}/live-sdxl/strips/", "lod_base": f"{R2}/live-sdxl/lod/"}
    # The known public host is only a fallback after an explicit opt-in, not the default.
    got = bases({"TAPESTRY_STRIP_CDN": "r2"})
    assert got["strip_base"] == f"{R2}/live-sdxl/strips/"


def test_write_capable_r2_and_the_off_switch():
    keys = {"R2_ENDPOINT": "https://acct.r2.cloudflarestorage.com", "R2_ACCESS_KEY_ID": "k",
            "R2_SECRET_ACCESS_KEY": "s", "R2_PUBLIC_URL": "https://pub-x.r2.dev"}
    assert bases(keys)["strip_base"] == "https://pub-x.r2.dev/live-sdxl/strips/"
    assert bases({**keys, "TAPESTRY_R2": "0"})["strip_base"].startswith(f"{SB}/storage/")
    assert bases({**keys, "TAPESTRY_STRIP_CDN": "supabase"})["strip_base"].startswith(f"{SB}/storage/")
    # A public URL without the write keys is not write-capable.
    assert "r2.dev" not in bases({"R2_PUBLIC_URL": R2, "R2_ACCESS_KEY_ID": "k"})["strip_base"]


def test_rewrite_requires_explicit_r2():
    script = """
const {rewriteSupabaseBases} = require('./web/lib/stripcdn.js');
const config = {strip_base: '%s/storage/v1/object/public/strips/live-sdxl/strips/',
  lod_base: '%s/storage/v1/object/public/strips/live-sdxl/lod/', strip_base_fb: 'x', lod_base_fb: 'y'};
const kept = rewriteSupabaseBases(config, {cdnBase: '%s'});
const moved = rewriteSupabaseBases(config, {cdnBase: '%s', stripCdn: 'r2'});
console.log(JSON.stringify({kept, moved}));
""" % (SB, SB, R2, R2)
    got = node(script, {"PATH": os.environ["PATH"]})
    assert got["kept"]["strip_base"].startswith(SB + "/storage/")
    assert "strip_base_fb" not in got["kept"] and "lod_base_fb" not in got["kept"]
    assert got["moved"]["strip_base"] == f"{R2}/live-sdxl/strips/"
    assert got["moved"]["lod_base"] == f"{R2}/live-sdxl/lod/"
    src = (ROOT / "static/client.js").read_text()
    assert 'page.stripCdn === "r2" && cdn' in src
    assert 'if (cdn) for (const k of ["strip_base", "lod_base"])' not in src


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


def test_build_omits_r2_cdn_unless_opted_in(tmp_path):
    plain = _build(tmp_path / "plain", {"R2_PUBLIC_URL": R2})
    assert 'cdnBase: ""' in plain
    assert "stripCdn" not in plain
    assert "r2.dev" not in plain
    opted = _build(tmp_path / "r2", {"TAPESTRY_STRIP_CDN": "r2", "R2_PUBLIC_URL": R2 + "/"})
    assert f'cdnBase: "{R2}"' in opted
    assert 'stripCdn: "r2"' in opted
