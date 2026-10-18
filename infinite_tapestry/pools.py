"""Dedicated thread pools so slow work can't starve the control plane.

Auto planning and the crowd idea loop used asyncio.to_thread (the loop's default executor, 32 threads on the pod).
Viewer-driven work (LOD tiles, crops, the /timeline scan, history fetches) shared that executor; when it was full,
Auto and idea pulls queued behind it for minutes (live: 32 executor threads parked in socket polls while the stage
held one scene for 134 strips and a pending idea waited 66 s+). Each lane now has its own pool, and control calls
carry a deadline.
"""

from __future__ import annotations

import asyncio
import faulthandler
import functools
import logging
import signal
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

logger = logging.getLogger(__name__)

CONTROL = ThreadPoolExecutor(max_workers=12, thread_name_prefix="control")   # Auto, crowd ideas, Haiku
HEAVY = ThreadPoolExecutor(max_workers=6, thread_name_prefix="heavy")        # tiles, crops, exports, history


async def _run(pool: ThreadPoolExecutor, fn: Callable[..., Any], *args: Any, timeout: float | None = None, **kw: Any) -> Any:
    loop = asyncio.get_running_loop()
    fut = loop.run_in_executor(pool, functools.partial(fn, *args, **kw))
    if timeout is None:
        return await fut
    return await asyncio.wait_for(fut, timeout)


async def control(fn: Callable[..., Any], *args: Any, timeout: float | None = 30.0, **kw: Any) -> Any:
    """Run a blocking control-plane call (Supabase REST, Haiku) with a deadline (asyncio.TimeoutError past it)."""
    return await _run(CONTROL, fn, *args, timeout=timeout, **kw)


async def heavy(fn: Callable[..., Any], *args: Any, timeout: float | None = None, **kw: Any) -> Any:
    return await _run(HEAVY, fn, *args, timeout=timeout, **kw)


def backlog() -> dict[str, int]:
    """Queued (not yet started) jobs per pool, for /health."""
    out = {}
    for name, p in (("control", CONTROL), ("heavy", HEAVY)):
        try:
            out[name] = p._work_queue.qsize()
        except Exception:
            out[name] = -1
    return out


def install_diagnostics(loop: asyncio.AbstractEventLoop | None = None) -> None:
    """kill -USR1 <pid>: all thread stacks to stderr (server.log); kill -USR2: every asyncio task's stack."""
    try:
        faulthandler.register(signal.SIGUSR1, file=sys.stderr, all_threads=True)
    except Exception:
        pass
    if loop is None:
        return

    def dump_tasks() -> None:
        tasks = asyncio.all_tasks(loop)
        logger.warning("asyncio task dump: %d tasks, pool backlog %s", len(tasks), backlog())
        for t in tasks:
            t.print_stack(limit=6, file=sys.stderr)

    try:
        loop.add_signal_handler(signal.SIGUSR2, dump_tasks)
    except Exception:
        pass
