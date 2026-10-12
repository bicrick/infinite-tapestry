from infinite_tapestry.store import SupabaseMirror


class FakeR2:
    public_url = "https://pub-x.r2.dev"

    def __init__(self, cors):
        self.cors, self.puts = cors, []

    def cors_ok(self):
        return self.cors

    def put(self, key, data, ctype):
        self.puts.append(key)


def _mirror(monkeypatch, cors):
    monkeypatch.delenv("R2_ENDPOINT", raising=False)
    m = SupabaseMirror("https://sb.example", "k", prefix="live")
    m.r2 = FakeR2(cors)
    return m


def test_r2_base_only_when_cors_live(monkeypatch):
    m = _mirror(monkeypatch, False)
    assert m.public_base().startswith("https://sb.example/") and m.fallback_base() is None
    assert m._supabase_public_too()
    m.r2.cors = True
    assert m.public_base() == "https://pub-x.r2.dev/live/strips/"
    assert m.fallback_base().startswith("https://sb.example/")
    assert not m._supabase_public_too()
    monkeypatch.setenv("TAPESTRY_SUPABASE_PUBLIC", "1")
    assert m._supabase_public_too()
