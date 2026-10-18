"""Web/cron never writes binary assets to Supabase Storage: TM tiles go to R2 (signed PUT), readers try R2 first."""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
needs_node = pytest.mark.skipif(not shutil.which("node"), reason="node not installed")


def node(script, env):
    r = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True,
                       env={"PATH": os.environ["PATH"], **env})
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip().splitlines()[-1])


R2ENV = {"R2_ENDPOINT": "https://acct.r2.cloudflarestorage.com", "R2_ACCESS_KEY_ID": "AKTEST",
         "R2_SECRET_ACCESS_KEY": "SKTEST", "R2_BUCKET": "tapestry-strips", "SUPABASE_URL": "https://proj.supabase.co",
         "SUPABASE_SERVICE_ROLE_KEY": "svc"}


@needs_node
def test_tm_tile_put_goes_to_r2_and_json_stays_on_supabase():
    script = """
    const calls = []; global.fetch = async (url, o = {}) => { calls.push({ url, method: o.method || 'GET', auth: !!(o.headers||{}).authorization && /AWS4-HMAC-SHA256/.test(o.headers.authorization) }); return { ok: true, json: async () => ({}), text: async () => '' }; };
    const { putObj, putJSON } = require('./web/lib/tmbuild.js');
    (async () => { await putObj('tm/lod2/1/000001.webp', Buffer.from('img'), 'image/webp'); await putJSON('tm/lod2/manifest.json', { a: 1 });
      console.log(JSON.stringify(calls)); })();
    """
    calls = node(script, R2ENV)
    assert calls[0]["url"] == "https://acct.r2.cloudflarestorage.com/tapestry-strips/tm/lod2/1/000001.webp"
    assert calls[0]["method"] == "PUT" and calls[0]["auth"]
    assert calls[1]["url"].startswith("https://proj.supabase.co/storage/v1/object/tapestry/tm/lod2/manifest.json")


@needs_node
def test_tile_put_without_r2_keys_fails_instead_of_falling_back_to_supabase():
    script = """
    const calls = []; global.fetch = async (url) => { calls.push(url); return { ok: true, text: async () => '' }; };
    const { putObj } = require('./web/lib/tmbuild.js');
    putObj('tm/lod2/1/000001.webp', Buffer.from('x'), 'image/webp').then(() => console.log(JSON.stringify({ ok: true, calls })),
      (e) => console.log(JSON.stringify({ ok: false, calls, msg: e.message })));
    """
    out = node(script, {"SUPABASE_URL": "https://proj.supabase.co"})
    assert out["ok"] is False and out["calls"] == [] and "R2 write keys missing" in out["msg"]


@needs_node
def test_sigv4_matches_reference_signature():
    # Independent SigV4 computed in Python for the same request must match the Node signer.
    import datetime, hashlib, hmac
    script = """
    const { signPut } = require('./web/lib/r2.js');
    const s = signPut({ endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'b', key: 'a/b c.webp', body: Buffer.from('hello'),
      contentType: 'image/webp', accessKey: 'AK', secretKey: 'SK', now: new Date('2026-10-18T01:02:03Z') });
    console.log(JSON.stringify(s));
    """
    s = node(script, {})
    body_hash = hashlib.sha256(b"hello").hexdigest()
    amz, day = "20261018T010203Z", "20261018"
    hdrs = {"content-type": "image/webp", "host": "acct.r2.cloudflarestorage.com", "x-amz-content-sha256": body_hash, "x-amz-date": amz}
    names = sorted(hdrs)
    canon = "\n".join(["PUT", "/b/a/b%20c.webp", ""] + [f"{n}:{hdrs[n]}" for n in names] + ["", ";".join(names), body_hash])
    scope = f"{day}/auto/s3/aws4_request"
    sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
    k = hmac.new(b"AWS4SK", day.encode(), hashlib.sha256).digest()
    for part in ("auto", "s3", "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    assert s["headers"]["authorization"].endswith("Signature=" + sig)
    assert s["url"] == "https://acct.r2.cloudflarestorage.com/b/a/b%20c.webp"


def test_no_binary_writes_to_supabase_storage_in_web():
    # Only JSON (tm index/manifest) and the deploy pointer may be written to Supabase Storage from web code.
    allowed = {"lib/tmbuild.js", "api/admin.js"}
    for f in list(WEB.glob("api/*.js")) + list(WEB.glob("lib/*.js")):
        src = f.read_text()
        if re.search(r"storage/v1/object/[^`]*`,\s*\{\s*method:\s*\"(POST|PUT)\"", src) or ".upload(" in src:
            assert str(f.relative_to(WEB)) in allowed, f"binary write to Supabase Storage in {f}"
    tb = (WEB / "lib/tmbuild.js").read_text()
    assert "if (!/json/.test(type)) return r2Put(" in tb


def test_readers_try_r2_before_supabase():
    for name in ("api/snapshot.js", "api/og.js"):
        src = (WEB / name).read_text()
        assert src.index("r2Get(") < src.index("storage/v1/object/tapestry"), name
    about = (WEB / "api/about.js").read_text()
    tile = about[about.index("async function tile("):]
    assert tile.index("r2Get(") < tile.index("storage/v1/object/tapestry")
    assert "(await r2Get(`sb-tapestry/${name}`)) || (await sbGet(" in about


@needs_node
def test_tm_getjson_throws_on_storage_error_instead_of_resetting_index():
    script = """
    let status = 500; global.fetch = async () => ({ ok: status === 200, status, json: async () => ({ v: 2 }), text: async () => status === 400 ? '{"error":"not_found"}' : 'Internal' });
    const { getJSON } = require('./web/lib/tmbuild.js');
    (async () => { const out = {};
      try { await getJSON('tm/idx/state.json'); out.e500 = 'returned'; } catch (e) { out.e500 = 'threw'; }
      status = 400; out.missing = await getJSON('x.json'); status = 200; out.ok = await getJSON('x.json');
      console.log(JSON.stringify(out)); })();
    """
    out = node(script, {"SUPABASE_URL": "https://proj.supabase.co"})
    assert out == {"e500": "threw", "missing": None, "ok": {"v": 2}}


def test_tm_tail_catchup_is_resumable():
    src = (WEB / "lib/tmtiles.js").read_text()
    assert "man.tail = { l: 1" in src and "delete man.tail" in src and "if (Date.now() - t0 >= budgetMs) { T.l = l; T.t = t; break outer; }" in src
