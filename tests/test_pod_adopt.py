"""adoptPod picks up a migrated/renamed RUNNING pod, never an EXITED one or an unrelated name."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node not installed")


def node(script, env=None):
    r = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def pick(pods, cur, name="tapestry-sdxl"):
    script = "const {pickAdoptPod} = require('./web/lib/podpick.js');" \
             f"const p = pickAdoptPod({json.dumps(pods)}, {json.dumps(cur)}, {json.dumps(name)});" \
             "console.log(JSON.stringify(p ? p.id : null));"
    return node(script)


def pod(id, name, status, up=None):
    return {"id": id, "name": name, "desiredStatus": status, "runtime": None if up is None else {"uptimeInSeconds": up}}


def test_migration_suffix_adopted_when_current_exited():
    assert pick([pod("old", "tapestry-sdxl", "EXITED"), pod("new", "tapestry-sdxl-migration", "RUNNING", 30)], "old") == "new"


def test_exact_name_still_adopted():
    assert pick([pod("old", "tapestry-sdxl", "EXITED"), pod("new", "tapestry-sdxl", "RUNNING")], "old") == "new"


def test_current_running_is_kept():
    assert pick([pod("old", "tapestry-sdxl", "RUNNING"), pod("new", "tapestry-sdxl-migration", "RUNNING")], "old") is None


def test_exited_and_unrelated_pods_never_adopted():
    pods = [pod("old", "tapestry-sdxl", "EXITED"), pod("a", "tapestry-sdxl-migration", "EXITED"),
            pod("b", "tapestry-sdxlv2", "RUNNING"), pod("c", "other-tapestry-sdxl", "RUNNING"), pod("d", "comfy", "RUNNING")]
    assert pick(pods, "old") is None
    # Current pod gone entirely: still only RUNNING matches.
    assert pick([pod("x", "tapestry-sdxl", "EXITED")], "gone") is None
    assert pick([pod("x", "tapestry-sdxl-migration", "RUNNING")], "gone") == "x"


def test_current_name_is_also_canonical():
    # Already on a migrated pod; the next migration appends another suffix.
    pods = [pod("m1", "tapestry-sdxl-migration", "EXITED"), pod("m2", "tapestry-sdxl-migration-2", "RUNNING")]
    assert pick(pods, "m1", "something-else") == "m2"


def test_tie_break_prefers_runtime_then_newest_then_exact_then_id():
    base = [pod("old", "tapestry-sdxl", "EXITED")]
    assert pick(base + [pod("boot", "tapestry-sdxl", "RUNNING"), pod("up", "tapestry-sdxl-migration", "RUNNING", 500)], "old") == "up"
    assert pick(base + [pod("long", "tapestry-sdxl", "RUNNING", 9000), pod("fresh", "tapestry-sdxl-migration", "RUNNING", 60)], "old") == "fresh"
    assert pick(base + [pod("z", "tapestry-sdxl-migration", "RUNNING", 60), pod("y", "tapestry-sdxl", "RUNNING", 60)], "old") == "y"
    assert pick(base + [pod("q2", "tapestry-sdxl-migration", "RUNNING"), pod("q1", "tapestry-sdxl-migration", "RUNNING")], "old") == "q1"


def test_adopt_pod_writes_pod_state():
    pods = [pod("old", "tapestry-sdxl", "EXITED"), pod("new", "tapestry-sdxl-migration", "RUNNING", 12)]
    script = """
const calls = [];
global.fetch = async (url, opts) => {
  calls.push({url, method: opts.method, body: opts.body});
  const json = url.includes('runpod') ? {data: {myself: {pods: %s}}} : null;
  return {ok: true, status: 200, json: async () => json, text: async () => json ? JSON.stringify(json) : ''};
};
const c = require('./web/lib/common.js');
c.adoptPod().then((id) => {
  const patch = calls.find((x) => x.method === 'PATCH' && x.url.includes('pod_state'));
  console.log(JSON.stringify({id, pod: c.POD(), patch: patch && JSON.parse(patch.body)}));
});
""" % json.dumps(pods)
    env = {"PATH": shutil.which("node").rsplit("/", 1)[0], "SUPABASE_URL": "http://sb.test", "SUPABASE_SERVICE_ROLE_KEY": "k",
           "RUNPOD_API_KEY": "k", "RUNPOD_POD_ID": "old"}
    r = node(script, env)
    assert r == {"id": "new", "pod": "new", "patch": {"pod_id": "new"}}
