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


class LiveDirector:
    """Runtime-controllable prompt playlist with gradual blending.

    State: a `current` prompt, an optional `target` being blended toward over
    `blend` strips, and a queue of upcoming prompts. When idle for `hold`
    strips, the next queued prompt becomes the target. Thread-safe.
    """

    def __init__(
        self,
        initial: str,
        negative_prompt: str = "",
        queue: list[str] | None = None,
        hold: int = 24,
        blend: int = 8,
        loop: bool = True,
    ) -> None:
        import threading

        self._lock = threading.Lock()
        self.negative_prompt = negative_prompt
        self.current = initial
        self.target: str | None = None
        self.blend = max(1, int(blend))
        self.hold = max(0, int(hold))
        self.loop = loop
        self.queue: list[str] = list(queue or [])
        self._blend_start = 0
        self._active_since = 0

    @classmethod
    def from_schedule(
        cls, schedule: list[tuple[int, str]], negative_prompt: str = "", blend: int = 8
    ) -> "LiveDirector":
        sched = sorted(schedule, key=lambda x: x[0])
        hold = 24
        if len(sched) > 1:
            hold = max(1, sched[1][0] - sched[0][0] - blend)
        return cls(
            sched[0][1],
            negative_prompt,
            queue=[p for _, p in sched[1:]] + [sched[0][1]],
            hold=hold,
            blend=blend,
        )

    # --- control (called from the WebSocket thread) ---
    def set_prompt(self, prompt: str, blend: int | None = None, at: int = 0) -> None:
        with self._lock:
            if blend is not None:
                self.blend = max(1, int(blend))
            if self.target is not None:
                self.current = self.target
            self.target = prompt
            self._blend_start = at

    def set_queue(
        self,
        prompts: list[str],
        hold: int | None = None,
        blend: int | None = None,
        loop: bool | None = None,
    ) -> None:
        with self._lock:
            self.queue = [p for p in prompts if p.strip()]
            if hold is not None:
                self.hold = max(0, int(hold))
            if blend is not None:
                self.blend = max(1, int(blend))
            if loop is not None:
                self.loop = bool(loop)

    def skip(self, at: int) -> None:
        with self._lock:
            self._active_since = -10**9  # force advance on next frame

    # --- generator side ---
    def frame_for(self, strip_index: int) -> tuple[str, str | None, float]:
        """Return (prompt_a, prompt_b, t) for this strip; t in [0,1]."""
        with self._lock:
            if self.target is not None:
                t = (strip_index - self._blend_start + 1) / self.blend
                if t >= 1.0:
                    self.current = self.target
                    self.target = None
                    self._active_since = strip_index
                else:
                    return self.current, self.target, max(0.0, t)
            if self.queue and strip_index - self._active_since >= self.hold:
                nxt = self.queue.pop(0)
                if self.loop:
                    self.queue.append(nxt)
                self.target = nxt
                self._blend_start = strip_index
                t = 1.0 / self.blend
                if t >= 1.0:
                    self.current, self.target = nxt, None
                    self._active_since = strip_index
                    return self.current, None, 0.0
                return self.current, self.target, t
            return self.current, None, 0.0

    def state(self) -> dict:
        with self._lock:
            return {
                "current": self.current,
                "target": self.target,
                "queue": list(self.queue),
                "hold": self.hold,
                "blend": self.blend,
                "loop": self.loop,
            }
