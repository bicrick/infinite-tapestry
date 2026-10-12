"""Tests for strip buffer depth, ack, and pub/sub."""

from __future__ import annotations

import threading
import time

import pytest

from infinite_tapestry.buffer import Strip, StripBuffer


def _strip(i: int) -> Strip:
    return Strip(
        index=i,
        width=160,
        height=512,
        overlap=32,
        jpeg=b"\xff\xd8fake",
        prompt=f"p{i}",
    )


def test_put_and_depth_with_ack():
    buf = StripBuffer(target=3, minimum=1)
    assert buf.needs_fill()
    assert buf.put(_strip(0))
    assert buf.put(_strip(1))
    assert buf.depth() == 2
    buf.acknowledge(0)
    assert buf.depth() == 1
    assert buf.peek_depth()["acknowledged"] == 1


def test_needs_fill_respects_target():
    buf = StripBuffer(target=2, minimum=1)
    buf.put(_strip(0))
    buf.put(_strip(1))
    assert not buf.needs_fill()
    buf.acknowledge(0)
    assert buf.needs_fill()


def test_subscribe_receives_puts():
    buf = StripBuffer(target=4, minimum=1)
    seen: list[int] = []
    unsub = buf.subscribe(lambda s: seen.append(s.index))
    buf.put(_strip(0))
    buf.put(_strip(1))
    assert seen == [0, 1]
    unsub()
    buf.put(_strip(2))
    assert seen == [0, 1]


def test_snapshot_and_strips_after():
    buf = StripBuffer(target=8, minimum=1)
    for i in range(5):
        buf.put(_strip(i))
    assert [s.index for s in buf.snapshot()] == [0, 1, 2, 3, 4]
    assert [s.index for s in buf.strips_after(2)] == [3, 4]


def test_history_limit_trims():
    buf = StripBuffer(target=4, minimum=1, history_limit=3)
    for i in range(5):
        # Keep unacked depth low so puts don't block on target.
        if i:
            buf.acknowledge(i - 1)
        assert buf.put(_strip(i), block=False)
    hist = buf.snapshot()
    assert len(hist) == 3
    assert hist[0].index == 2


def test_wait_for_strip_after():
    buf = StripBuffer(target=4, minimum=1)

    def producer():
        time.sleep(0.05)
        buf.put(_strip(0))

    threading.Thread(target=producer, daemon=True).start()
    got = buf.wait_for_strip_after(-1, timeout=1.0)
    assert got is not None
    assert got.index == 0


def test_close_stops_needs_fill():
    buf = StripBuffer(target=3, minimum=1)
    buf.close()
    assert buf.closed
    assert not buf.needs_fill()
    assert buf.put(_strip(0)) is False


def test_invalid_ctor():
    with pytest.raises(ValueError):
        StripBuffer(target=1, minimum=2)
    with pytest.raises(ValueError):
        StripBuffer(target=2, minimum=0)
