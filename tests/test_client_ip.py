"""Per-IP caps must use the proxy-set client IP, not a spoofable X-Forwarded-For."""

from infinite_tapestry.server import client_ip


class _WS:
    def __init__(self, headers, host="10.0.0.9"):
        self.headers = headers
        self.client = type("C", (), {"host": host})()


def test_prefers_cf_connecting_ip_over_spoofed_xff():
    ws = _WS({"x-forwarded-for": "1.2.3.4, 9.9.9.9", "cf-connecting-ip": "203.0.113.50"})
    assert client_ip(ws) == "203.0.113.50"


def test_prefers_x_real_ip_over_xff():
    ws = _WS({"x-forwarded-for": "1.2.3.4", "x-real-ip": "198.51.100.7"})
    assert client_ip(ws) == "198.51.100.7"


def test_xff_uses_rightmost_proxy_hop():
    # Client spoofs leftmost; trusted proxy appends the real peer.
    ws = _WS({"x-forwarded-for": "1.2.3.4, 203.0.113.9"})
    assert client_ip(ws) == "203.0.113.9"


def test_falls_back_to_socket_peer():
    ws = _WS({}, host="192.0.2.1")
    assert client_ip(ws) == "192.0.2.1"
