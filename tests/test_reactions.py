from infinite_tapestry.reactions import Reactions


def test_bucket_and_batch():
    r = Reactions(rate=0.0, burst=5, ip_rate=0.0, ip_burst=7)
    ok = [r.add("a", "ip", "lol", 10, "Cheese caves") for _ in range(8)]
    assert ok.count(True) == 5
    assert [r.add("b", "ip", "fire", 10) for _ in range(3)].count(True) == 2  # ip cap 7
    assert not r.add("c", "ip2", "nope", 1)
    assert r.take_batch() == {"lol": 5, "fire": 2}
    assert r.take_batch() is None
    rows = r.take_dirty()
    assert rows == [{"strip": 10, "counts": {"lol": 5, "fire": 2}, "title": "Cheese caves"}]
