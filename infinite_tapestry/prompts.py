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


MIN_TRANSITION = 12  # strips; shorter blends read as hard cuts
_scene_ids = __import__("itertools").count(1)


def make_scene(
    prompt: str,
    negative: str = "",
    title: str = "",
    transition: int | None = None,
    hold: int | None = None,
    source: str = "",
) -> dict:
    """A playlist item. `transition`/`hold` are in strips (None = director default)."""
    prompt = str(prompt).strip()[:600]
    return {
        "id": next(_scene_ids),
        "title": (str(title).strip() or prompt.split(",")[0])[:80],
        "prompt": prompt,
        "negative": str(negative or "").strip()[:400],
        "transition": None if transition is None else max(MIN_TRANSITION, min(64, int(transition))),
        "hold": None if hold is None else max(0, min(500, int(hold))),
        "source": source[:200],
    }


class LiveDirector:
    """Runtime-controllable scene playlist with gradual embedding blends.

    State: the `current` scene, an optional `target` being blended toward over
    its transition length, and a queue of upcoming scenes. When the current
    scene has held for its `hold` strips, the next queued scene becomes the
    target. Thread-safe; all mutators are called from the WebSocket loop.
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
        self._current = make_scene(initial)
        self._target: dict | None = None
        self.blend = max(1, int(blend))
        self.hold = max(0, int(hold))
        self.loop = loop
        self._queue: list[dict] = [make_scene(p) for p in (queue or []) if p.strip()]
        self._blend_start = 0
        self._active_since = 0
        self._last_index = 0

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

    # --- compat properties ---
    @property
    def current(self) -> str:
        return self._current["prompt"]

    @property
    def target(self) -> str | None:
        return self._target["prompt"] if self._target else None

    @property
    def queue(self) -> list[str]:
        return [s["prompt"] for s in self._queue]

    def _blend_len(self, scene: dict | None) -> int:
        if scene and scene.get("transition"):
            return int(scene["transition"])
        return self.blend

    def _hold_len(self, scene: dict) -> int:
        h = scene.get("hold")
        return self.hold if h is None else int(h)

    def _begin(self, scene: dict, at: int) -> None:
        if self._target is not None:
            self._current = self._target
        self._target = scene
        self._blend_start = at

    # --- control ---
    def set_prompt(self, prompt: str, blend: int | None = None, at: int = 0) -> None:
        self.play_now(make_scene(prompt, transition=blend), at=at)

    def play_now(self, scene: dict, at: int = 0) -> None:
        with self._lock:
            self._begin(scene, at)

    def add(self, scenes: list[dict], position: str = "end") -> None:
        with self._lock:
            if position == "next":
                self._queue[0:0] = scenes
            else:
                self._queue.extend(scenes)
            del self._queue[100:]

    def set_queue(
        self,
        prompts: list[str],
        hold: int | None = None,
        blend: int | None = None,
        loop: bool | None = None,
    ) -> None:
        with self._lock:
            self._queue = [make_scene(p) for p in prompts if p.strip()]
            self.configure(hold=hold, blend=blend, loop=loop, _locked=True)

    def configure(self, hold=None, blend=None, loop=None, _locked: bool = False) -> None:
        def apply() -> None:
            if hold is not None:
                self.hold = max(0, int(hold))
            if blend is not None:
                self.blend = max(1, int(blend))
            if loop is not None:
                self.loop = bool(loop)

        if _locked:
            apply()
        else:
            with self._lock:
                apply()

    def _find(self, scene_id: int) -> int:
        for i, s in enumerate(self._queue):
            if s["id"] == scene_id:
                return i
        return -1

    def remove(self, scene_id: int) -> bool:
        with self._lock:
            i = self._find(int(scene_id))
            if i < 0:
                return False
            self._queue.pop(i)
            return True

    def move(self, scene_id: int, to: int) -> bool:
        with self._lock:
            i = self._find(int(scene_id))
            if i < 0:
                return False
            s = self._queue.pop(i)
            self._queue.insert(max(0, min(len(self._queue), int(to))), s)
            return True

    def edit(self, scene_id: int, **fields) -> bool:
        with self._lock:
            i = self._find(int(scene_id))
            if i < 0:
                return False
            s = self._queue[i]
            if fields.get("prompt"):
                s["prompt"] = str(fields["prompt"]).strip()[:600]
            if fields.get("title"):
                s["title"] = str(fields["title"]).strip()[:80]
            for k in ("transition", "hold"):
                if fields.get(k) is not None:
                    s[k] = max(1 if k == "transition" else 0, int(fields[k]))
            return True

    def play(self, scene_id: int, at: int = 0) -> bool:
        with self._lock:
            i = self._find(int(scene_id))
            if i < 0:
                return False
            s = self._queue.pop(i)
            if self.loop:
                self._queue.append(dict(s))
            self._begin(s, at)
            return True

    def clear(self) -> None:
        with self._lock:
            self._queue.clear()

    def skip(self, at: int) -> None:
        with self._lock:
            if self._target is not None:
                # Already transitioning: finish it now and move on.
                self._current, self._target = self._target, None
            self._active_since = -10**9  # force advance on next frame

    # --- generator side ---
    def frame_for(self, strip_index: int) -> tuple[str, str | None, float]:
        """Return (prompt_a, prompt_b, t) for this strip; t in [0,1]."""
        with self._lock:
            self._last_index = strip_index
            if self._target is not None:
                t = (strip_index - self._blend_start + 1) / self._blend_len(self._target)
                if t >= 1.0:
                    self._current = self._target
                    self._target = None
                    self._active_since = strip_index
                else:
                    return self.current, self.target, max(0.0, t)
            if self._queue and strip_index - self._active_since >= self._hold_len(self._current):
                nxt = self._queue.pop(0)
                if self.loop:
                    self._queue.append(dict(nxt))
                self._target = nxt
                self._blend_start = strip_index
                t = 1.0 / self._blend_len(nxt)
                if t >= 1.0:
                    self._current, self._target = nxt, None
                    self._active_since = strip_index
                    return self.current, None, 0.0
                return self.current, self.target, t
            return self.current, None, 0.0

    def negative_for(self, t: float) -> str:
        with self._lock:
            scene = self._target if (self._target and t >= 0.5) else self._current
            extra = scene.get("negative") or ""
        return ", ".join(x for x in (self.negative_prompt, extra) if x)

    def title_for(self, t: float) -> str:
        with self._lock:
            scene = self._target if (self._target and t >= 0.5) else self._current
            return scene["title"]

    def state(self) -> dict:
        with self._lock:
            idx = self._last_index
            progress = None
            if self._target is not None:
                progress = min(1.0, max(0.0, (idx - self._blend_start + 1) / self._blend_len(self._target)))
            held = max(0, idx - self._active_since)
            return {
                "current": self.current,
                "target": self.target,
                "current_scene": dict(self._current),
                "target_scene": dict(self._target) if self._target else None,
                "transition_progress": progress,
                "held": held if held < 10**8 else 0,
                "hold_for": self._hold_len(self._current),
                "queue": self.queue,
                "items": [dict(s) for s in self._queue],
                "hold": self.hold,
                "blend": self.blend,
                "loop": self.loop,
            }
