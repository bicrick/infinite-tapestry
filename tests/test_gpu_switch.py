"""The one GPU switch: phases, replacement pod config, CLI auth surface, admin UI."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
node_only = pytest.mark.skipif(not shutil.which("node"), reason="node not installed")


def node(script, env=None):
    r = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@node_only
def test_phases():
    out = node("const g=require('./web/lib/gpu.js');console.log(JSON.stringify(["
               "g.phase('off','EXITED',false),g.phase('off','RUNNING',true),g.phase('on','EXITED',false),"
               "g.phase('on','RUNNING',false),g.phase('on','RUNNING',true)]))")
    assert out == ["off", "stopping", "starting", "starting", "live"]


@node_only
def test_replacement_pod_env_and_name():
    out = node("const g=require('./web/lib/gpu.js');"
               "const e=g.podEnv({SUPABASE_URL:'u',SUPABASE_SERVICE_ROLE_KEY:'k',RUNPOD_API_KEY:'r',STRIPE_SECRET_KEY:'no'});"
               "console.log(JSON.stringify({e, n:g.replacementName(new Date('2026-10-16T20:05:00Z')), boot:g.BOOT}))")
    e = out["e"]
    assert e["SUPABASE_URL"] == "u" and e["TAPESTRY_BACKEND"] == "sdxl" and "TAPESTRY_R2" not in e   # R2 is never switched off
    assert "STRIPE_SECRET_KEY" not in e and e["PUBLIC_KEY"].startswith("ssh-ed25519 ")
    assert out["n"] == "tapestry-sdxl-2610162005"   # adoptPod's "tapestry-sdxl-*" rule matches it
    assert "selfboot.sh" in out["boot"] and out["boot"].endswith("exec /start.sh")


@node_only
def test_cli_secret_cannot_reach_other_admin_actions(monkeypatch):
    # without a Supabase admin token, only gpu_* actions accept the CLI secret
    script = """
process.env.GPU_CLI_SECRET='x'.repeat(32); process.env.SUPABASE_URL='http://127.0.0.1:9';
const h=require('./web/api/admin.js');
function run(action, secret){ return new Promise((ok)=>{ const res={code:0,setHeader(){},status(c){this.code=c;return this},json(){ok(this.code)},end(){ok(this.code)}};
  h({headers:{'x-gpu-secret':secret}, body:{action}}, res); }); }
(async()=>{ console.log(JSON.stringify([await run('recent','x'.repeat(32)), await run('gpu_status','y'.repeat(32))])); })();
"""
    assert node(script) == [403, 403]


def test_scripts_and_ui():
    sh = (ROOT / "scripts/gpu.sh").read_text()
    assert "TAPESTRY_GPU_SECRET" in sh and "x-gpu-secret" in sh
    assert (ROOT / "scripts/pod/selfboot.sh").exists()
    ui = json.loads((ROOT / "web/api/_admin_ui.json").read_text())
    assert 'id="gpu-switch"' in ui["html"] and "gpu-seg" not in ui["html"]
    assert "exit 1" not in (ROOT / "scripts/resolve_ws_url.sh").read_text().split("proxy.runpod.net/health", 1)[1]
