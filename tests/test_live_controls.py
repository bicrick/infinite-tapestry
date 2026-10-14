from infinite_tapestry.buffer import Strip, StripBuffer
from infinite_tapestry.prompts import LiveDirector


def test_director_blends_and_advances(fixed_widths):
    d = LiveDirector("a", queue=["b"], hold=2, blend=4, loop=False)
    assert d.frame_for(0) == ("a", None, 0.0)
    assert d.frame_for(1) == ("a", None, 0.0)
    a, b, t = d.frame_for(2)
    assert (a, b) == ("a", "b") and 0 < t < 1
    ts = [d.frame_for(i)[2] for i in range(3, 5)]
    assert ts == sorted(ts)
    assert d.frame_for(6) == ("b", None, 0.0)


def test_director_set_prompt_overrides():
    d = LiveDirector("a", hold=100, blend=2)
    d.set_prompt("z", at=10)
    assert d.frame_for(10)[1] == "z"
    assert d.frame_for(11) == ("z", None, 0.0)


def test_buffer_strips_between_and_target():
    b = StripBuffer(target=4, minimum=1, history_limit=100)
    for i in range(3):
        b.put(Strip(i, 8, 8, 0, b"", "p"))
    assert [s.index for s in b.strips_between(1, 2)] == [1, 2]
    b.set_target(32)
    assert b.target == 32
