"""Production-readiness guards: admin auth, mood sync, legal pages, Stripe mode, single SITE_URL, Auto steering."""
import asyncio, json, pathlib, re
from datetime import datetime, timedelta, timezone

from infinite_tapestry.autopilot import Autopilot
from infinite_tapestry.moods import MOODS, MoodRotator
from infinite_tapestry.prompts import LiveDirector
from tests.test_autopilot import FakeAuto

ROOT = pathlib.Path(__file__).resolve().parents[1]
rd = lambda p: (ROOT / p).read_text()


def test_moods_json_in_sync():
    j = json.loads(rd("web/lib/moods.json"))["MOODS"]
    assert [(m["key"], m["weight"], m["beautiful"]) for m in j] == [(k, w, b) for k, w, b, *_ in MOODS]


def test_admin_checks_admin_before_any_action():
    s = rd("web/api/admin.js")
    gate = s.index('if (!me) return res.status(403).end();')
    assert "adminFromToken" in s and "is_admin" not in s.split("module.exports")[1]
    first = min(s.index(m.group(0)) for m in re.finditer(r'\ba === "', s))
    assert gate < first
    for a in ["overview", "gpu_set", "auto_set", "idea", "sanction", "unsanction", "report", "rollback"]:
        assert f'"{a}"' in s
    assert "confirm" in s  # rollback requires a typed confirmation


def test_report_endpoint_and_legal_pages():
    r = rd("web/api/report.js")
    assert "ip_hash" in r and "reports" in r
    v = json.loads(rd("web/vercel.json"))
    assert any(x.get("source") == "/privacy" for x in v.get("rewrites", []))
    assert "privacy" in rd("static/terms.html").lower() and (ROOT / "static/privacy.html").exists()


def test_stripe_mode_is_config_only():
    c = rd("web/lib/common.js")
    for k in ["STRIPE_MODE", "STRIPE_LIVE_SECRET_KEY", "STRIPE_LIVE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET"]:
        assert k in c
    w = rd("web/api/stripe-webhook.js")
    assert "livemode" in w and "on_conflict" in w + rd("web/lib/common.js") or "stripe_session_id" in w


def test_site_url_single_source():
    for p in ["web/api", "web/lib", "infinite_tapestry"]:
        for f in (ROOT / p).rglob("*"):
            if f.suffix in (".js", ".py"):
                for line in f.read_text().splitlines():
                    if "infinite-tapestry.vercel.app" in line:
                        assert "SITE_URL" in line or "SITE" in line, f"{f}: {line.strip()}"
    ci = rd(".github/workflows/ci.yml")
    assert "vars.SITE_URL" in ci and 'alias set "$URL" "$d"' in ci


def test_no_model_vendor_name_in_static():
    for f in (ROOT / "static").rglob("*"):
        if f.suffix in (".html", ".js", ".css"):
            t = f.read_text().lower().replace('x === "claude"', "")  # the handle filter that hides it
            assert "claude" not in t, f


def test_apply_config_pause_theme_weights():
    d = LiveDirector("seed", hold=0, blend=2)
    ap = Autopilot(d, FakeAuto(), min_interval=0)
    soon = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
    ap.apply_config({"paused": True, "theme": "tide pools", "theme_until": soon, "mood_weights": {MOODS[0][0]: 0}})
    assert ap.admin_paused and ap.vibe == "tide pools" and ap.moods.weights[MOODS[0][0]] == 0
    asyncio.run(ap.tick())
    assert d.state()["items"] == []  # paused: nothing queued
    for _ in range(50):
        assert ap.moods._pick() != MOODS[0][0]
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    ap.apply_config({"paused": False, "theme": "tide pools", "theme_until": past})
    assert not ap.admin_paused and ap.admin_theme == "" and ap.vibe == ""
    asyncio.run(ap.tick())
    assert len(d.state()["items"]) == 2


def test_admin_shell_ships_no_admin_ui():
    h = rd("static/admin.html") + rd("static/gate.js")
    for w in ["GPU", "Steer", "overview", "rollback", "Reports", "admin.js"]:
        assert w not in h, w
    assert not (ROOT / "static/admin.js").exists()
    import importlib.util
    spec = importlib.util.spec_from_file_location("g", ROOT / "scripts/gen_admin_ui.py"); g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
    assert json.loads(rd("web/api/_admin_ui.json")) == g.pack()


def test_admin_email_allowlist():
    c = rd("web/lib/common.js")
    assert 'env("ADMIN_EMAILS", "patrickbrownai@gmail.com")' in c and "email_confirmed_at" in c
    m = rd("web/middleware.js")
    assert "/lib/:path*" in m and "/api/_:path*" in m
