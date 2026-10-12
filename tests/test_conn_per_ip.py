"""8 connections per IP, keyed by cf-connecting-ip (not spoofable XFF)."""

from fastapi.testclient import TestClient

from infinite_tapestry.buffer import StripBuffer
from infinite_tapestry.config import Config
from infinite_tapestry.server import create_app


def test_eight_cap_uses_cf_connecting_ip_not_spoofed_xff():
    cfg = Config(mock=True, height=32, window_width=64, strip_width=16, overlap=4, buffer_target=2, buffer_min=1)
    app = create_app(cfg, StripBuffer(2, 1))
    held = []
    with TestClient(app) as c:
        for i in range(1, 12):
            cm = c.websocket_connect(
                "/ws",
                headers={"cf-connecting-ip": "203.0.113.50", "x-forwarded-for": f"198.51.100.{i}"},
            )
            ws = cm.__enter__()
            try:
                msg = ws.receive_json()
                assert msg["type"] == "config"
                held.append(cm)
            except Exception:
                try:
                    cm.__exit__(None, None, None)
                except Exception:
                    pass
                break
        n = len(held)
        for cm in held:
            try:
                cm.__exit__(None, None, None)
            except Exception:
                pass
    assert n == 8, f"expected 8 held under one cf-connecting-ip, got {n}"
