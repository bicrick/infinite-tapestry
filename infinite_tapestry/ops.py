"""Durable reliability log for the pod: heartbeat + events in Supabase (ops_heartbeat / ops_events).

Events (source='pod'):
  restart         app came back up; started_at = last heartbeat before the gap, duration_ms = downtime
  stall           no new strip for > STALL_S while running; logged when strips resume (or at shutdown)
  error           ERROR log records from the app (generation failures, upstream/Supabase/R2/Claude errors), rate-limited
  stop            clean shutdown (SIGTERM), with uptime

Everything is fire-and-forget on one daemon thread; it never blocks the painter.
"""
from __future__ import annotations

import calendar
import json
import logging
import os
import queue
import threading
import time
import urllib.request

log = logging.getLogger(__name__)
STALL_S = float(os.environ.get("TAPESTRY_STALL_S", "20"))
HEARTBEAT_S = 30.0


def _iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int((t % 1) * 1000):03d}Z"


class OpsLog:
    def __init__(self, generator=None) -> None:
        self.url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
        self.key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
        self.enabled = bool(self.url and self.key) and os.environ.get("TAPESTRY_OPS_LOG", "1") != "0"
        self.gen = generator
        self.t0 = time.time()
        self.release = os.path.basename(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))[:12]
        self._q: "queue.Queue[tuple]" = queue.Queue(maxsize=500)
        self._stop = threading.Event()
        self._err_times: list[float] = []
        self.viewers = lambda: None

    # ---- REST ----
    def _rest(self, method: str, path: str, body=None, prefer: str = "return=minimal"):
        req = urllib.request.Request(f"{self.url}/rest/v1/{path}", method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {self.key}", "apikey": self.key,
                                              "Content-Type": "application/json", "Prefer": prefer})
        with urllib.request.urlopen(req, timeout=10) as r:
            t = r.read()
            return json.loads(t) if t else None

    def event(self, type: str, started_at: float | None = None, duration_ms: int | None = None, **detail) -> None:
        if not self.enabled:
            return
        row = {"source": "pod", "type": type, "started_at": _iso(started_at or time.time()),
               "duration_ms": None if duration_ms is None else int(duration_ms),
               "detail": {"release": self.release, **detail}}
        try:
            self._q.put_nowait(("POST", "ops_events", row))
        except queue.Full:
            pass

    def _beat(self) -> None:
        g = self.gen
        st = g.stats() if g is not None else {}
        self._q.put_nowait(("POST", "ops_heartbeat?on_conflict=id", {
            "id": "pod", "at": _iso(time.time()), "started_at": _iso(self.t0), "strip_index": st.get("strip_index"),
            "detail": {"release": self.release, "strip_s": st.get("strip_seconds"), "viewers": self.viewers(),
                       "r2": self._r2()}}))

    def _r2(self):
        """R2 write health for the admin panel: True ok, False degraded (Supabase-only), None unknown."""
        m = getattr(getattr(self.gen, "store", None), "mirror", None)
        try:
            return None if m is None else bool(m.r2_ok() and m.r2_write_ok)
        except Exception:
            return None

    # ---- lifecycle ----
    def start(self) -> "OpsLog":
        if not self.enabled:
            return self
        try:   # downtime since the previous process's last heartbeat = this restart's gap
            rows = self._rest("GET", "ops_heartbeat?id=eq.pod&select=at", prefer="") or []
            if rows:
                last = calendar.timegm(time.strptime(rows[0]["at"][:19], "%Y-%m-%dT%H:%M:%S"))
                self.event("restart", started_at=last, duration_ms=(time.time() - last) * 1000,
                           pod=os.environ.get("RUNPOD_POD_ID"))
            else:
                self.event("restart", pod=os.environ.get("RUNPOD_POD_ID"))
        except Exception:
            self.event("restart", pod=os.environ.get("RUNPOD_POD_ID"))
        logging.getLogger().addHandler(_ErrorHandler(self))
        threading.Thread(target=self._send_loop, name="ops-send", daemon=True).start()
        threading.Thread(target=self._watch_loop, name="ops-watch", daemon=True).start()
        return self

    def stop(self) -> None:
        if not self.enabled:
            return
        self._flush_stall(time.time())
        self.event("stop", started_at=self.t0, duration_ms=(time.time() - self.t0) * 1000)
        self._stop.set()
        deadline = time.time() + 3
        while not self._q.empty() and time.time() < deadline:
            self._send_one(timeout=0.2)

    # ---- loops ----
    _stall_since: float | None = None
    _last_idx = None
    _last_new = 0.0

    def _flush_stall(self, now: float) -> None:
        if self._stall_since is not None:
            self.event("stall", started_at=self._stall_since, duration_ms=(now - self._stall_since) * 1000,
                       strip_index=self._last_idx)
            self._stall_since = None

    def _watch_loop(self) -> None:
        self._last_new = time.time()
        next_beat = 0.0
        while not self._stop.wait(2.0):
            now = time.time()
            try:
                idx = self.gen.stats().get("strip_index") if self.gen is not None else None
            except Exception:
                idx = None
            if idx != self._last_idx:
                if self._last_idx is not None:
                    self._flush_stall(now)
                self._last_idx, self._last_new = idx, now
            elif self._stall_since is None and self._last_idx is not None and now - self._last_new > STALL_S:
                self._stall_since = self._last_new
            if now >= next_beat:
                next_beat = now + HEARTBEAT_S
                try:
                    self._beat()
                except Exception:
                    pass

    def _send_one(self, timeout: float) -> None:
        try:
            m, p, b = self._q.get(timeout=timeout)
        except queue.Empty:
            return
        for attempt in range(3):
            try:
                self._rest(m, p, b, "resolution=merge-duplicates,return=minimal" if "on_conflict" in p else "return=minimal")
                return
            except Exception as e:  # never log at ERROR here (would feed back into the handler)
                if attempt == 2:
                    log.warning("ops log write failed: %s", type(e).__name__)
                time.sleep(1 + attempt * 2)

    def _send_loop(self) -> None:
        while not self._stop.is_set():
            self._send_one(timeout=1.0)

    def on_error(self, rec: logging.LogRecord) -> None:
        now = time.time()
        self._err_times = [t for t in self._err_times if now - t < 600]
        if len(self._err_times) >= 20:   # max 20 error events per 10 min
            return
        self._err_times.append(now)
        msg = rec.getMessage()[:300]
        exc = rec.exc_info[0].__name__ if rec.exc_info and rec.exc_info[0] else None
        self.event("error", logger=rec.name, msg=msg, exc=exc)


class _ErrorHandler(logging.Handler):
    def __init__(self, ops: OpsLog) -> None:
        super().__init__(level=logging.ERROR)
        self.ops = ops

    def emit(self, rec: logging.LogRecord) -> None:
        if rec.name.startswith(__name__):
            return
        try:
            self.ops.on_error(rec)
        except Exception:
            pass
