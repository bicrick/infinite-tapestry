"""Global, server-driven scroll timeline shared by every viewer.

`pos` is the world-x (px) of the RIGHT edge of the live view, so it doesn't
depend on any viewer's screen width. Auto mode is a smoothed control loop:
feed-forward on the GPU's measured paint rate (px/s), feedback that steers the
unseen runway (generated px - pos) toward `target_ahead` strips, a low-pass on
the desired speed, an acceleration limit, and a soft brake near the edge so
the scroll eases instead of stalling.
"""

from __future__ import annotations

import math
import threading
import time


class Timeline:
    def __init__(
        self,
        strip_width: int,
        default_speed: float = 30.0,
        target_ahead: float = 3.0,
        gain: float = 0.6,
        tau: float = 4.0,
        accel: float = 6.0,
        headroom: float = 0.85,
    ) -> None:
        self.sw = strip_width
        self.default_speed = default_speed
        self.target_ahead = target_ahead
        self.gain, self.tau, self.accel, self.headroom = gain, tau, accel, headroom
        self.mode = "auto"
        self.manual_speed = default_speed
        self.multiplier = 1.0
        self.pos: float | None = None
        self.speed = 0.0
        self._smooth = 0.0
        self._lock = threading.Lock()
        self.updated = time.time()

    def set_speed(self, mode: str | None = None, manual: float | None = None, multiplier: float | None = None) -> None:
        with self._lock:
            if mode in ("auto", "manual"):
                self.mode = mode
            if manual is not None:
                self.manual_speed = max(2.0, min(200.0, float(manual)))
            if multiplier is not None:
                self.multiplier = max(1.0, min(8.0, float(multiplier)))

    def desired(self, ahead: float, capacity: float | None) -> float:
        if self.mode == "manual":
            return self.manual_speed * self.multiplier
        target = self.sw * self.target_ahead
        # Slow down when the runway is short; never run faster than headroom x capacity when it's long,
        # so the GPU keeps ~15% slack to rebuild the buffer after a stall (the buffer itself holds more than target).
        k = max(0.2, min(1.0, 1 + self.gain * (ahead - target) / target))
        return (capacity or self.default_speed) * self.headroom * k * self.multiplier

    def step(self, dt: float, generated_px: float, capacity: float | None) -> float:
        with self._lock:
            if self.pos is None:
                if generated_px <= 0:
                    return 0.0
                self.pos = max(0.0, generated_px - self.sw * self.target_ahead)
            ahead = generated_px - self.pos
            want = self.desired(ahead, capacity)
            if not self._smooth:
                self._smooth = want
            tau = self.tau if self.mode == "auto" else 0.4
            self._smooth += (want - self._smooth) * (1 - math.exp(-dt / tau))
            acc = self.accel * self.multiplier if self.mode == "auto" else 200.0
            dv = max(-acc * dt, min(acc * dt, self._smooth - self.speed))
            self.speed = max(0.0, self.speed + dv)
            brake = max(0.0, ahead) / 1.5
            if self.speed > brake:
                self.speed += (brake - self.speed) * min(1.0, dt * 4)
            self.pos += min(self.speed * dt, max(0.0, ahead))
            self.updated = time.time()
            return self.speed

    def state(self) -> dict:
        with self._lock:
            return {
                "pos": round(self.pos or 0.0, 2),
                "speed": round(self.speed, 3),
                "mode": self.mode,
                "manual": self.manual_speed,
                "multiplier": self.multiplier,
                "ts": self.updated,
            }
