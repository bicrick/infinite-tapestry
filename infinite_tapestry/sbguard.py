"""Process-wide circuit breaker for the pod's Supabase REST calls.

On 2026-10-19 the NANO Supabase VM stalled for ~25 min; the pod kept firing every poll (each one waiting out a
10-20 s timeout), which piles connections onto a box that is already drowning. After a few consecutive
timeouts / 5xx the breaker opens and calls fail fast (no network) for a cooldown that doubles up to 5 min; then a
single probe goes through and one success closes it. 4xx answers mean the DB is reachable and never trip it.
Callers already treat any exception as "Supabase unavailable", so behaviour while healthy is unchanged.
"""
from __future__ import annotations

import logging
import threading
import time
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)


class SupabaseUnavailable(urllib.error.URLError):
    def __init__(self, retry_in: float) -> None:
        super().__init__(f"supabase breaker open; retry in {retry_in:.0f}s")


class Breaker:
    TRIP_AFTER = 3
    BASE_S = 15.0
    MAX_S = 300.0

    def __init__(self, clock=time.monotonic) -> None:
        self._clock, self._lock = clock, threading.Lock()
        self.fails, self.trips, self.open_until, self._probing = 0, 0, 0.0, False

    @property
    def is_open(self) -> bool:
        return self.fails >= self.TRIP_AFTER

    def before(self) -> None:
        with self._lock:
            if not self.is_open:
                return
            now = self._clock()
            if now < self.open_until or self._probing:
                raise SupabaseUnavailable(max(0.0, self.open_until - now))
            self._probing = True  # half-open: this one call is the probe

    def ok(self) -> None:
        with self._lock:
            if self.is_open:
                logger.warning("Supabase reachable again; breaker closed after %d trip(s)", self.trips)
            self.fails, self.trips, self._probing = 0, 0, False

    def fail(self) -> None:
        with self._lock:
            self.fails += 1
            self._probing = False
            if self.fails >= self.TRIP_AFTER:
                cool = min(self.MAX_S, self.BASE_S * (2 ** self.trips))
                self.trips += 1
                self.open_until = self._clock() + cool
                if self.fails == self.TRIP_AFTER or self.trips > 1:
                    logger.warning("Supabase slow/unreachable; pausing REST calls for %.0fs", cool)


BREAKER = Breaker()


def _is_outage(e: BaseException) -> bool:
    if isinstance(e, urllib.error.HTTPError):
        return e.code >= 500
    return isinstance(e, (urllib.error.URLError, TimeoutError, ConnectionError, OSError))


def urlopen_read(req: urllib.request.Request, timeout: float, breaker: Breaker = BREAKER) -> bytes:
    """urlopen(req).read() guarded by the breaker."""
    breaker.before()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    except SupabaseUnavailable:
        raise
    except Exception as e:
        if _is_outage(e):
            breaker.fail()
        else:
            breaker.ok()
        raise
    breaker.ok()
    return data
