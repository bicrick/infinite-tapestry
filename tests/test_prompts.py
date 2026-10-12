"""Tests for prompt schedule drift."""

from __future__ import annotations

import pytest

from infinite_tapestry.prompts import PromptScheduler


def test_frame_at_boundaries():
    sched = PromptScheduler(
        [(0, "meadow"), (10, "forest"), (20, "snow")],
        negative_prompt="bad",
    )
    f0 = sched.frame_for(0)
    assert f0.prompt == "meadow"
    assert f0.t == pytest.approx(0.0)
    assert f0.negative_prompt == "bad"

    f5 = sched.frame_for(5)
    assert f5.prompt == "meadow"
    assert f5.t == pytest.approx(0.5)

    f10 = sched.frame_for(10)
    assert f10.prompt == "forest"
    assert f10.t == pytest.approx(0.0)

    f25 = sched.frame_for(25)
    assert f25.prompt == "snow"
    assert f25.t == pytest.approx(1.0)


def test_schedule_must_be_nonempty():
    with pytest.raises(ValueError):
        PromptScheduler([])
