"""/export.png: public viewers get <= 200 strips and one export per 10 s per IP; the admin token is uncapped."""
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from infinite_tapestry import crowd as crowd_mod
from infinite_tapestry import server
from infinite_tapestry.buffer import StripBuffer
from infinite_tapestry.config import Config
from infinite_tapestry.generator import StripGenerator
from infinite_tapestry.mock_inpaint import MockInpainter


class FakeSupa:
    url = "http://supa.invalid"
    key = "k"

    def user_from_token(self, token):
        return {"id": "u1", "is_admin": token == "admin-token"}

    def rest(self, *a, **k):
        return []

    def __getattr__(self, name):   # anything else Crowd might touch
        return lambda *a, **k: None


class Interp:
    enabled = False


def _app(monkeypatch, n=8, supa=True):
    if supa:
        monkeypatch.setattr(crowd_mod.Supa, "from_env", classmethod(lambda cls: FakeSupa()))
    monkeypatch.setattr(server, "EXPORT_MAX_STRIPS_PUBLIC", 3)
    cfg = Config(mock=True, height=32, window_width=64, strip_width=16, overlap=4, buffer_target=n, buffer_min=1)
    buf = StripBuffer(target=n, minimum=1)
    gen = StripGenerator(cfg, MockInpainter(cfg), buf)
    for _ in range(n):
        buf.put(gen.generate_one(), block=False)
    return TestClient(server.create_app(cfg, buf, gen, interpreter=Interp()))


def _w(r):
    return Image.open(io.BytesIO(r.content)).width


def test_public_cap_and_rate_limit(monkeypatch):
    c = _app(monkeypatch)
    r = c.get("/export.png?max_strips=4000", headers={"cf-connecting-ip": "1.1.1.1"})
    assert r.status_code == 200 and _w(r) == 3 * 16          # capped to EXPORT_MAX_STRIPS_PUBLIC
    r2 = c.get("/export.png", headers={"cf-connecting-ip": "1.1.1.1"})
    assert r2.status_code == 429 and int(r2.headers["retry-after"]) >= 1
    r3 = c.get("/export.png", headers={"cf-connecting-ip": "2.2.2.2"})   # other IP unaffected
    assert r3.status_code == 200
    # a non-admin token is still a public viewer
    r4 = c.get("/export.png", headers={"cf-connecting-ip": "3.3.3.3", "authorization": "Bearer user-token"})
    assert r4.status_code == 200 and _w(r4) == 3 * 16


def test_admin_uncapped(monkeypatch):
    c = _app(monkeypatch)
    for _ in range(2):   # no cooldown either
        r = c.get("/export.png", headers={"cf-connecting-ip": "1.1.1.1", "authorization": "Bearer admin-token"})
        assert r.status_code == 200 and _w(r) == 8 * 16


def test_local_dev_without_supabase_is_uncapped(monkeypatch):
    monkeypatch.setattr(crowd_mod.Supa, "from_env", classmethod(lambda cls: None))
    c = _app(monkeypatch, supa=False)
    assert _w(c.get("/export.png")) == 8 * 16 and c.get("/export.png").status_code == 200


def test_defaults():
    assert server.EXPORT_MAX_STRIPS_PUBLIC == 200 and server.EXPORT_COOLDOWN_S >= 5
