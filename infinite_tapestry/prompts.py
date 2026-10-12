"""Scheduled prompt drift across strips."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PromptFrame:
    prompt: str
    negative_prompt: str
    strip_index: int
    segment: str
    t: float  # 0..1 progress within current segment toward next


class PromptScheduler:
    """Pick (and lightly describe) the active prompt for a strip index.

    Embeddings aren't interpolated here — that needs the text encoder on GPU.
    For the MVP we switch prompts at schedule boundaries and expose `t` so a
    future GPU path can blend embeddings. Between boundaries we keep the
    current prompt so newly revealed strips stay locally consistent.
    """

    def __init__(
        self,
        schedule: list[tuple[int, str]],
        negative_prompt: str = "",
    ) -> None:
        if not schedule:
            raise ValueError("prompt schedule must not be empty")
        self.schedule = sorted(schedule, key=lambda x: x[0])
        if self.schedule[0][0] != 0:
            # Ensure we always have a starting prompt.
            self.schedule = [(0, self.schedule[0][1])] + list(self.schedule)
        self.negative_prompt = negative_prompt

    def frame_for(self, strip_index: int) -> PromptFrame:
        if strip_index < 0:
            raise ValueError("strip_index must be >= 0")

        idx = 0
        for i, (start, _) in enumerate(self.schedule):
            if start <= strip_index:
                idx = i
            else:
                break

        start, prompt = self.schedule[idx]
        if idx + 1 < len(self.schedule):
            next_start, _ = self.schedule[idx + 1]
            span = max(1, next_start - start)
            t = min(1.0, max(0.0, (strip_index - start) / span))
            segment = f"{idx}->{idx + 1}"
        else:
            t = 1.0
            segment = f"{idx}"

        return PromptFrame(
            prompt=prompt,
            negative_prompt=self.negative_prompt,
            strip_index=strip_index,
            segment=segment,
            t=t,
        )
