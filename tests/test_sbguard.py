import urllib.error
import urllib.request

import pytest

from infinite_tapestry import sbguard


class Clock:
    def __init__(self): self.t = 0.0
    def __call__(self): return self.t


def _req():
    return urllib.request.Request("http://127.0.0.1:9/x")


def test_trips_after_consecutive_outages_then_fails_fast(monkeypatch):
    clk = Clock(); b = sbguard.Breaker(clock=clk); calls = []
    def boom(req, timeout): calls.append(1); raise urllib.error.URLError("timed out")
    monkeypatch.setattr(urllib.request, "urlopen", boom)
    for _ in range(3):
        with pytest.raises(urllib.error.URLError): sbguard.urlopen_read(_req(), 1, b)
    assert b.is_open and len(calls) == 3
    with pytest.raises(sbguard.SupabaseUnavailable): sbguard.urlopen_read(_req(), 1, b)
    assert len(calls) == 3  # no network while open


def test_half_open_probe_success_closes(monkeypatch):
    clk = Clock(); b = sbguard.Breaker(clock=clk)
    for _ in range(3): b.fail()
    clk.t += 16

    class R:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b"[]"
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout: R())
    assert sbguard.urlopen_read(_req(), 1, b) == b"[]"
    assert not b.is_open


def test_cooldown_doubles_and_caps():
    clk = Clock(); b = sbguard.Breaker(clock=clk)
    for _ in range(3): b.fail()
    assert b.open_until == 15
    clk.t = 15; b.before(); b.fail()
    assert b.open_until == 15 + 30
    for _ in range(10):
        clk.t = b.open_until; b.before(); b.fail()
    assert b.open_until - clk.t == sbguard.Breaker.MAX_S


def test_client_errors_do_not_trip(monkeypatch):
    b = sbguard.Breaker()
    def e409(req, timeout): raise urllib.error.HTTPError(req.full_url, 409, "conflict", {}, None)
    monkeypatch.setattr(urllib.request, "urlopen", e409)
    for _ in range(5):
        with pytest.raises(urllib.error.HTTPError): sbguard.urlopen_read(_req(), 1, b)
    assert not b.is_open
