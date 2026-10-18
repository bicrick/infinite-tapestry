"""Parallel, prioritized Storage mirror: strips first, rows after their image, loud R2 health."""
import threading
import time

from infinite_tapestry import store as st


def _mirror(monkeypatch, r2=None, workers=2):
    monkeypatch.setattr(st.R2Public, "from_env", classmethod(lambda cls: r2))
    monkeypatch.setattr(st.SupabaseMirror, "UPLOAD_WORKERS", workers)
    m = st.SupabaseMirror("https://x.supabase.co", "k", prefix="live-test")
    return m


def test_row_written_only_after_its_image(monkeypatch):
    m = _mirror(monkeypatch)
    order = []
    lock = threading.Lock()

    def req(method, path, data=None, ctype=""):
        time.sleep(0.05)
        with lock:
            order.append(("img", path))
        return b""
    monkeypatch.setattr(m, "_req", req)
    m.put("public:strips/00000001.webp", b"x", "image/webp", after=lambda: order.append(("row", 1)))
    for _ in range(100):
        if ("row", 1) in order:
            break
        time.sleep(0.02)
    assert order.index(("img", "public:strips/00000001.webp")) < order.index(("row", 1))


def test_strips_jump_ahead_of_tiles(monkeypatch):
    m = _mirror(monkeypatch, workers=1)
    gate = threading.Event()
    seen = []

    def req(method, path, data=None, ctype=""):
        gate.wait(2)
        seen.append(path)
        return b""
    monkeypatch.setattr(m, "_req", req)
    m.put("public:lod/1/000001.jpg", b"t", "image/jpeg")   # occupies the single worker
    time.sleep(0.05)
    m.put("public:lod/1/000002.jpg", b"t", "image/jpeg")
    m.put("public:strips/00000009.webp", b"s", "image/webp")
    gate.set()
    for _ in range(100):
        if len(seen) == 3:
            break
        time.sleep(0.02)
    assert seen.index("public:strips/00000009.webp") < seen.index("public:lod/1/000002.jpg")


class _R2:
    bucket, public_url, _cors = "b", "https://pub", (0.0, True)

    def __init__(self, fail):
        self.fail, self.keys = fail, []

    def put(self, key, data, ctype):
        if self.fail:
            raise RuntimeError("nope")
        self.keys.append(key)

    def cors_ok(self):
        return True


def test_r2_write_check_surfaces_in_health(monkeypatch):
    ok = _mirror(monkeypatch, r2=_R2(False))
    bad = _mirror(monkeypatch, r2=_R2(True))
    for _ in range(100):
        if ok.r2_write_ok is not None and bad.r2_write_ok is not None:
            break
        time.sleep(0.02)
    assert ok.health()["r2"]["write_ok"] is True
    assert bad.health()["r2"]["write_ok"] is False and bad.health()["r2"]["error"] == "RuntimeError"


def test_r2_off_reason_names_missing_keys_without_values(monkeypatch):
    for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL", "TAPESTRY_R2"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "secret-value-123")
    assert st.R2Public.from_env() is None
    assert "R2_ENDPOINT" in st.R2Public.off_reason and "secret-value-123" not in st.R2Public.off_reason


def test_dual_write_keeps_supabase_copy_for_fallback(monkeypatch):
    r2 = _R2(False)
    m = _mirror(monkeypatch, r2=r2)
    monkeypatch.setenv("TAPESTRY_SUPABASE_PUBLIC", "1")
    sb = []
    monkeypatch.setattr(m, "_req", lambda method, path, data=None, ctype="": sb.append(path) or b"")
    m.put("public:strips/00000005.webp", b"s", "image/webp")
    for _ in range(100):
        if sb and "live-test/strips/00000005.webp" in r2.keys:
            break
        time.sleep(0.02)
    assert sb == ["public:strips/00000005.webp"] and "live-test/strips/00000005.webp" in r2.keys
