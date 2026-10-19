from infinite_tapestry.store import SupabaseMirror


class FakeR2:
    public_url = "https://pub-x.r2.dev"
    bucket, _cors = "b", (0.0, True)

    def __init__(self, cors):
        self.cors, self.puts = cors, []

    def cors_ok(self):
        return self.cors

    def put(self, key, data, ctype):
        self.puts.append(key)


def _mirror(monkeypatch, r2):
    monkeypatch.setattr("infinite_tapestry.store.R2Public.from_env", classmethod(lambda cls: r2))
    return SupabaseMirror("https://sb.example", "k", prefix="live")


def test_viewers_always_on_r2(monkeypatch):
    m = _mirror(monkeypatch, FakeR2(True))
    assert m.public_base() == "https://pub-x.r2.dev/live/strips/"
    assert not hasattr(m, "fallback_base")   # no Supabase fallback
    m.r2.cors = False
    assert m.public_base().startswith("https://pub-x.r2.dev/")   # strips exist only on R2


def test_no_r2_means_no_strip_base(monkeypatch):
    m = _mirror(monkeypatch, None)
    assert m.public_base() == "" and m.get("public:strips/00000001.webp") is None


def test_reads_are_r2_only(monkeypatch):
    r2 = FakeR2(True)
    r2.get = lambda key: b"img" if key == "live/strips/00000001.webp" else None
    m = _mirror(monkeypatch, r2)
    assert m.get("public:strips/00000001.webp") == b"img"
    assert m.get("public:strips/00000002.webp") is None


def test_session_prefix(monkeypatch):
    monkeypatch.setattr("infinite_tapestry.store.R2Public.from_env", classmethod(lambda cls: None))
    monkeypatch.setenv("SUPABASE_URL", "https://sb.example"); monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k")
    monkeypatch.setenv("TAPESTRY_STORAGE_PREFIX", "ignored")
    assert SupabaseMirror.from_env().prefix == "live-sdxl"
    assert SupabaseMirror.from_env("mock").prefix == "mock"


def test_all_binary_assets_go_to_r2_and_never_supabase(monkeypatch):
    import time
    r2 = FakeR2(True)
    m = _mirror(monkeypatch, r2)
    m.put("public:strips/00000001.webp", b"s", "image/webp")
    m.put("public:lod/1/000001.jpg", b"t", "image/jpeg")
    m.put("canvas.png", b"c", "image/png")
    m.put("crops/1-2-10x10.jpg", b"x", "image/jpeg")
    for _ in range(100):
        if len(r2.puts) >= 5:   # 4 + the startup write check
            break
        time.sleep(0.02)
    assert {"live/strips/00000001.webp", "live/lod/1/000001.jpg", "live/canvas.png", "live/crops/1-2-10x10.jpg"} <= set(r2.puts)
    assert m.failed == 0


def test_r2_down_drops_binary_writes_but_keeps_rows(monkeypatch):
    import time
    m = _mirror(monkeypatch, None)
    rows = []
    m.put("public:strips/00000002.webp", b"s", "image/webp", after=lambda: rows.append(2))
    for _ in range(100):
        if rows:
            break
        time.sleep(0.02)
    assert rows == [2] and m.dropped == 1 and m.health()["r2"]["write_ok"] is False
