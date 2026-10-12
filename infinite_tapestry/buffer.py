"""Thread-safe strip ring + pub/sub between generator and WebSocket clients."""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque


@dataclass
class Strip:
    """One generated tapestry strip ready for the client."""

    index: int
    width: int
    height: int
    overlap: int
    jpeg: bytes
    prompt: str
    created_at: float = field(default_factory=time.time)


Subscriber = Callable[[Strip], None]


class StripBuffer:
    """Append-only strip history with occupancy helpers and fan-out notify.

    The generator only `put`s. Clients never destructively pop; they advance
    their own cursor over `history` (or receive pushes via `subscribe`).
    `depth` is how many strips have been produced but not yet acknowledged
    as consumed by the slowest subscriber cursor — for a single-viewer MVP
    we expose `produced - acknowledged`.
    """

    def __init__(self, target: int, minimum: int, history_limit: int = 64) -> None:
        if minimum < 1:
            raise ValueError("minimum must be >= 1")
        if target < minimum:
            raise ValueError("target must be >= minimum")
        self.target = target
        self.minimum = minimum
        self.history_limit = history_limit
        self._history: Deque[Strip] = deque()
        self._cond = threading.Condition()
        self._closed = False
        self._produced = 0
        self._acknowledged = 0
        self._subscribers: list[Subscriber] = []

    def __len__(self) -> int:
        return self.depth()

    @property
    def produced(self) -> int:
        with self._cond:
            return self._produced

    @property
    def acknowledged(self) -> int:
        with self._cond:
            return self._acknowledged

    def depth(self) -> int:
        """Unacked strips — proxy for how far ahead of the viewer we are."""
        with self._cond:
            return max(0, self._produced - self._acknowledged)

    def is_low(self) -> bool:
        return self.depth() < self.minimum

    def needs_fill(self) -> bool:
        with self._cond:
            return (not self._closed) and (self._produced - self._acknowledged) < self.target

    def close(self) -> None:
        with self._cond:
            self._closed = True
            self._cond.notify_all()

    @property
    def closed(self) -> bool:
        with self._cond:
            return self._closed

    def subscribe(self, callback: Subscriber) -> Callable[[], None]:
        with self._cond:
            self._subscribers.append(callback)

        def unsubscribe() -> None:
            with self._cond:
                if callback in self._subscribers:
                    self._subscribers.remove(callback)

        return unsubscribe

    def put(self, strip: Strip, block: bool = True, timeout: float | None = None) -> bool:
        """Append a strip once the unacked depth is under target (+slack)."""
        deadline = None if timeout is None else time.monotonic() + timeout
        subscribers: list[Subscriber] = []
        with self._cond:
            while True:
                if self._closed:
                    return False
                depth = self._produced - self._acknowledged
                if depth < self.target + 2:
                    self._history.append(strip)
                    while len(self._history) > self.history_limit:
                        self._history.popleft()
                    self._produced += 1
                    subscribers = list(self._subscribers)
                    self._cond.notify_all()
                    break
                if not block:
                    return False
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return False
                    self._cond.wait(timeout=remaining)
                else:
                    self._cond.wait(timeout=0.5)

        for cb in subscribers:
            try:
                cb(strip)
            except Exception:
                pass
        return True

    def restore(self, strips: list["Strip"], produced: int) -> None:
        """Seed history after a restart; viewers resume at the newest strip."""
        with self._cond:
            self._history = deque(strips[-self.history_limit:])
            self._produced = produced
            self._acknowledged = max(0, produced - 1)
            self._cond.notify_all()

    def acknowledge(self, index: int) -> None:
        """Client finished displaying through `index` (inclusive)."""
        with self._cond:
            if index + 1 > self._acknowledged:
                self._acknowledged = index + 1
                self._cond.notify_all()

    def set_target(self, target: int) -> None:
        with self._cond:
            self.target = max(self.minimum, int(target))
            self._cond.notify_all()

    def strips_between(self, start: int, end: int) -> list[Strip]:
        with self._cond:
            if not self._history:
                return []
            first = self._history[0].index
            lo = max(0, start - first)
            hi = max(0, end - first + 1)
            return [s for s in list(self._history)[lo:hi] if start <= s.index <= end]

    def snapshot(self) -> list[Strip]:
        with self._cond:
            return list(self._history)

    def strips_after(self, index: int) -> list[Strip]:
        with self._cond:
            return [s for s in self._history if s.index > index]

    def wait_for_strip_after(self, index: int, timeout: float = 0.5) -> Strip | None:
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                for s in self._history:
                    if s.index > index:
                        return s
                if self._closed:
                    return None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._cond.wait(timeout=remaining)

    def peek_depth(self) -> dict[str, int | bool]:
        with self._cond:
            depth = max(0, self._produced - self._acknowledged)
            return {
                "depth": depth,
                "target": self.target,
                "minimum": self.minimum,
                "produced": self._produced,
                "acknowledged": self._acknowledged,
                "history": len(self._history),
                "low": depth < self.minimum,
                "closed": self._closed,
            }

    def wait_until_needs_fill(self, timeout: float = 1.0) -> bool:
        with self._cond:
            if self._closed:
                return False
            depth = self._produced - self._acknowledged
            if depth < self.target:
                return True
            self._cond.wait(timeout=timeout)
            depth = self._produced - self._acknowledged
            return (not self._closed) and depth < self.target
