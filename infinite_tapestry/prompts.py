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


QUALITY_NEGATIVE = ("wallpaper, tiled, empty composition, lifeless, cluttered duplicates")
MIN_TRANSITION = 1  # strips; scenes change every ~10-15 s (blend 2-4 + hold 1-3 at ~2.7 s/strip)
MAX_TRANSITION = 3
MAX_HOLD_USER = 4  # klein is coherent: short scenes (~10-15 s)
MAX_HOLD = 4  # scenes should switch often; long holds read as stalls
_scene_ids = __import__("itertools").count(1)


from .themes import clean_title as _clean_title  # noqa: E402


def make_scene(
    prompt: str,
    negative: str = "",
    title: str = "",
    transition: int | None = None,
    hold: int | None = None,
    source: str = "",
    origin: str = "user",
    style: str | None = None,
    lora: str | None = None,
    beats: list | None = None,
) -> dict:
    """A playlist item. `transition`/`hold` are in strips (None = director default)."""
    prompt = str(prompt).strip()[:600]
    return {
        "id": next(_scene_ids),
        "title": (_clean_title(title) or _clean_title(prompt.split(",")[0]) or str(title).strip()
                  or prompt.split(",")[0])[:80],
        "prompt": prompt,
        "negative": str(negative or "").strip()[:400],
        "transition": None if transition is None else max(MIN_TRANSITION, min(MAX_TRANSITION, int(transition))),
        "hold": None if hold is None else max(0, min(MAX_HOLD_USER if origin == "user" else MAX_HOLD, int(hold))),
        "source": source[:200],
        "origin": origin if origin in ("user", "auto", "seed") else "user",
        "style": _norm_style(lora) if lora else _label(style),
        "lora": _norm_style(lora) if lora else None,
        "beats": [str(b).strip()[:600] for b in (beats or []) if str(b).strip()][:4],
    }


def _label(style) -> str:
    """Free-form style label for captions (the look itself lives in the prompt)."""
    s = str(style or "none").strip().lower()[:24]
    return s or "none"


def _norm_style(style):
    from .styles import normalize
    return normalize(style)


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
        hold: int = 12,
        blend: int = 8,
        loop: bool = False,
    ) -> None:
        import threading

        self._lock = threading.Lock()
        self.negative_prompt = negative_prompt
        self._current = make_scene(initial, origin="seed")
        self.history: list[dict] = [dict(self._current)]
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
        """Start from the first scheduled prompt; any others are queued once
        (no looping). Autopilot fills the queue from there."""
        sched = sorted(schedule, key=lambda x: x[0])
        return cls(sched[0][1], negative_prompt, queue=[p for _, p in sched[1:]],
                   hold=3, blend=max(MIN_TRANSITION, min(blend, MAX_TRANSITION)), loop=False)

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
        h = self.hold if h is None else int(h)
        # Variable scene length (~20-45 s with the blend at ~2.9 s/strip): ideas linger a bit longer
        # than default, quiet Auto filler moves on sooner. Same for everyone, donor or not.
        if scene.get("origin") == "user":  # ideas linger longer than Auto filler
            base = 0 if h <= 0 else max(2, min(MAX_HOLD_USER, h))
        else:
            # a little variation: alternate scenes run one strip shorter/longer (2-4 strips)
            jitter = sum(map(ord, str(scene.get("title") or scene.get("prompt") or ""))) % 3 - 1
            base = 0 if h <= 0 else max(2, min(MAX_HOLD, h + jitter))
        # Crowd heat: the scene on stage lingers while people react to it (+1 strip per ~6 reactions, up to +3).
        heat = getattr(self, "heat", None)
        if heat is not None and scene is self._current and base > 0:
            try:
                base = base + min(2, int(heat(self._active_since)) // 6)
            except Exception:
                pass
        return base

    def _begin(self, scene: dict, at: int) -> None:
        if self._target is not None:
            self._promote(self._target)
        self._target = scene
        self._blend_start = at

    def _promote(self, scene: dict) -> None:
        self._current = scene
        self.history.append(dict(scene))
        del self.history[:-30]

    def add_user(self, scenes: list[dict], position: str = "end") -> int:
        """Queue user scenes ahead of every pending auto scene. Pending auto
        scenes are dropped (autopilot regenerates them to bridge from the
        user's destination). Returns how many auto items were dropped."""
        with self._lock:
            users = [s for s in self._queue if s.get("origin") != "auto"]
            dropped = len(self._queue) - len(users)
            if not users and self._target is None and (self._current or {}).get("origin") != "user":
                # Nothing user-made ahead: cut the current auto hold short so the
                # idea starts weaving in on the very next strip.
                self._active_since = -10**9
            if position == "next":
                users[0:0] = scenes
            else:
                users.extend(scenes)
            self._queue = users[:100]
            return dropped

    def trim_auto(self, keep: int) -> bool:
        """Keep only the first `keep` pending auto scenes (ideas are waiting). True if anything was dropped."""
        with self._lock:
            out, n = [], 0
            for s in self._queue:
                if s.get("origin") == "auto":
                    n += 1
                    if n > keep:
                        continue
                out.append(s)
            changed = len(out) != len(self._queue)
            self._queue = out
            return changed

    def drop_auto(self) -> None:
        with self._lock:
            self._queue = [s for s in self._queue if s.get("origin") != "auto"]

    def upcoming_count(self) -> int:
        with self._lock:
            return len(self._queue) + (1 if self._target else 0)

    def recent(self, n: int = 8) -> list[dict]:
        """Recent played scenes plus anything in flight/queued, oldest first."""
        with self._lock:
            out = [dict(s) for s in self.history[-n:]]
            if self._target:
                out.append(dict(self._target))
            out.extend(dict(s) for s in self._queue)
            return out

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
                self._promote(self._target)
                self._target = None
            self._active_since = -10**9  # force advance on next frame

    # --- generator side ---
    def _beat(self, scene: dict | None, k: int, last: bool = False) -> str:
        """Prompt for the k-th held strip of a scene: scenes unfold as 2-4 sub-beats
        (approach -> reveal -> climax) with different framing on the same subject."""
        if not scene:
            return ""
        beats = [b for b in (scene.get("beats") or []) if b]
        if not beats:
            return scene["prompt"]
        if last:
            return beats[-1]
        n = len(beats)
        return beats[min(n - 1, max(0, k) * n // max(1, self._hold_len(scene)))]

    def frame_for(self, strip_index: int) -> tuple[str, str | None, float]:
        """Return (prompt_a, prompt_b, t) for this strip; t in [0,1]."""
        with self._lock:
            self._last_index = strip_index
            if self._target is not None:
                t = (strip_index - self._blend_start + 1) / self._blend_len(self._target)
                if t >= 1.0:
                    self._promote(self._target)
                    self._target = None
                    self._active_since = strip_index
                else:
                    return self._beat(self._current, strip_index, last=True), self._beat(self._target, 0), max(0.0, t)
            if self._queue and strip_index - self._active_since >= self._hold_len(self._current):
                nxt = self._queue.pop(0)
                if self.loop:
                    self._queue.append(dict(nxt))
                self._target = nxt
                self._blend_start = strip_index
                t = 1.0 / self._blend_len(nxt)
                if t >= 1.0:
                    self._promote(nxt)
                    self._target = None
                    self._active_since = strip_index
                    return self._beat(self._current, 0), None, 0.0
                return self._beat(self._current, 0, last=True), self._beat(self._target, 0), t
            return self._beat(self._current, strip_index - self._active_since), None, 0.0

    def styles_for(self, t: float) -> tuple[str, str | None]:
        """(style of current scene, style of target scene or None) — call right after frame_for."""
        with self._lock:
            def lora(sc):  # only explicitly requested user styles drive LoRAs/triggers
                return (sc or {}).get("lora") or "none"
            a = lora(self._current)
            b = lora(self._target) if self._target else None
            return a, (b or "none") if self._target else None

    def ref_ids(self) -> tuple[int | None, int | None]:
        """Scene ids (current, target) for reference-image lookup — call right after frame_for."""
        with self._lock:
            return (self._current or {}).get("id"), (self._target or {}).get("id") if self._target else None

    def negative_for(self, t: float) -> str:
        with self._lock:
            scene = self._target if (self._target and t >= 0.5) else self._current
            extra = scene.get("negative") or ""
        return ", ".join(x for x in (self.negative_prompt, extra, QUALITY_NEGATIVE) if x)

    def title_for(self, t: float) -> str:
        with self._lock:
            scene = self._target if (self._target and t >= 0.5) else self._current
            return scene["title"]

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "current": self._current, "target": self._target, "queue": self._queue,
                "history": self.history[-30:], "blend_start": self._blend_start,
                "active_since": self._active_since, "hold": self.hold, "blend": self.blend,
                "loop": self.loop, "next_id": next(_scene_ids),
            }

    def load_dict(self, d: dict) -> None:
        global _scene_ids
        with self._lock:
            self._current = d.get("current") or self._current
            self._target = d.get("target")
            self._queue = list(d.get("queue") or [])
            self.history = list(d.get("history") or [self._current])
            self._blend_start = int(d.get("blend_start", 0))
            self._active_since = int(d.get("active_since", 0))
            # Clamp persisted timings to the current (shorter) limits.
            self.hold = max(2, min(MAX_HOLD, int(d.get("hold", self.hold))))
            self.blend = max(MIN_TRANSITION, min(self.blend, MAX_TRANSITION, int(d.get("blend", self.blend))))
            for s in self._queue + ([self._target] if self._target else []):
                if s.get("transition"):
                    s["transition"] = max(MIN_TRANSITION, min(MAX_TRANSITION, int(s["transition"])))
                if s.get("hold") is not None:
                    s["hold"] = max(2, min(MAX_HOLD_USER if s.get("origin") == "user" else MAX_HOLD, int(s["hold"])))
            if self._current.get("hold") is not None:
                self._current["hold"] = max(0, min(MAX_HOLD, int(self._current["hold"])))
            self.loop = bool(d.get("loop", False))
            _scene_ids = __import__("itertools").count(int(d.get("next_id", 1)) + 1)

    def flagged_scene(self) -> dict:
        """The scene currently being painted (target if blending), for strike bookkeeping."""
        with self._lock:
            return dict(self._target or self._current or {})

    def drop_flagged(self, at: int) -> None:
        """Abandon the scene being painted after an explicit-content flag; resume on Auto."""
        with self._lock:
            if self._target is not None:
                self._target = None
            else:
                safe = next((dict(x) for x in reversed(self.history) if x.get("origin") == "auto"), None)
                if safe:
                    self._current = safe
            self._active_since = at

    def safe_prompt(self) -> str:
        """Most recent Auto scene prompt to repaint with after an explicit-content flag."""
        with self._lock:
            for s in reversed(self.history + self._queue):
                if s.get("origin") == "auto" and s.get("prompt"):
                    return s["prompt"]
        return "cinematic photo, wide empty desert highway at dusk, 24mm"

    def caption(self) -> dict:
        """Scene the most recent strip mostly shows (target once past halfway through a blend)."""
        with self._lock:
            sc = self._current or {}
            if self._target is not None:
                t = (self._last_index - self._blend_start + 1) / max(1, self._blend_len(self._target))
                if t >= 0.5:
                    sc = self._target
            return {k: sc.get(k) for k in ("title", "by", "style", "origin") if sc.get(k)}

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
                "history": [{"title": h["title"], "origin": h.get("origin")} for h in self.history[-8:]],
            }
