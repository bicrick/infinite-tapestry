"""Crowd director + fuel meter, backed by Supabase (service role, server only).

- Pulls the top pending ideas (boost, votes, age) from the shared pool when the
  director has no audience scenes queued, asks Claude to weave them into one
  continuous journey, and queues the result attributed to the idea authors.
- Burns fuel (GPU $/hr + Claude tokens) into the ledger once a minute and, at
  zero, broadcasts "out of fuel" and asks RunPod to stop this pod.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable

from .prompts import make_scene, soft_title



def direct_plan(bodies: list[str], hold: int = 4) -> dict:
    """One scene per idea, the user's own words verbatim (+ a neutral quality hint; no framing or subject imposed)."""
    scenes = []
    for b in bodies:
        b = " ".join(str(b).split())[:400]
        scenes.append({"title": soft_title(b), "prompt": f"{b}, rich detail",
                       "negative": "", "transition": 1, "hold": hold})
    return {"scenes": scenes, "note": "straight to your idea", "source": "direct", "model": None}

logger = logging.getLogger(__name__)

GPU_CENTS_PER_HOUR = float(os.environ.get("TAPESTRY_GPU_CENTS_PER_HOUR", "90"))
# Haiku pricing used for the fuel meter (input, output) in cents per token.
CLAUDE_CENTS_PER_TOKEN = float(os.environ.get("TAPESTRY_CLAUDE_CENTS_PER_MTOK", "30")) / 1_000_000



VOTE_THRESHOLD = 3  # pending ideas; at or below this, play FIFO and hide voting
BUSY_PENDING = 15   # more than this waiting -> fair queue (Supabase pick_ideas), shorter holds
BUSY_HOLD = 2       # strips held per idea when busy (+1 blend, ~9 s); quiet keeps 4


def queue_mode(pending: int) -> str:
    return "vote" if pending > VOTE_THRESHOLD else "fifo"

class Supa:
    def __init__(self, url: str, key: str) -> None:
        self.url, self.key = url.rstrip("/"), key

    @classmethod
    def from_env(cls) -> "Supa | None":
        url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        return cls(url, key) if url and key else None

    def rest(self, method: str, path: str, body: Any = None, prefer: str = "return=representation") -> Any:
        req = urllib.request.Request(
            f"{self.url}/rest/v1/{path}", method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.key}", "apikey": self.key,
                     "Content-Type": "application/json", "Prefer": prefer},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            t = r.read()
            return json.loads(t) if t else None

    def user_from_token(self, token: str) -> dict | None:
        req = urllib.request.Request(f"{self.url}/auth/v1/user",
                                     headers={"Authorization": f"Bearer {token}", "apikey": self.key})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                user = json.loads(r.read())
        except Exception:
            return None
        prof = self.rest("GET", f"profiles?id=eq.{user['id']}&select=handle,is_admin") or [{}]
        return {"id": user["id"], **prof[0]}

    def audit(self, action: str, target: str = "", detail: dict | None = None, actor_handle: str = "server") -> None:
        try:
            self.rest("POST", "audit_log", {"action": action, "target": target, "detail": detail or {},
                                            "actor_handle": actor_handle}, prefer="return=minimal")
        except Exception:
            logger.warning("audit write failed for %s", action)


class Crowd:
    def __init__(self, supa: Supa, director: Any, interpreter: Any, generator: Any,
                 broadcast: Callable[[dict], None], on_change: Callable[[], None], mock: bool = False) -> None:
        self.supa, self.director, self.interpreter, self.generator = supa, director, interpreter, generator
        self.broadcast, self.on_change, self.mock = broadcast, on_change, mock
        self.fuel_cents: float | None = None
        self.out_of_fuel = False
        self._last_tokens = getattr(interpreter, "tokens_used", 0)
        self._last_burn = time.monotonic()
        self.burn = os.environ.get("TAPESTRY_FUEL_BURN", "0" if mock else "1") == "1"

    queue_mode = "fifo"
    busy = False                         # fair-queue mode (more than BUSY_PENDING waiting)
    pending: list = []
    viewers = staticmethod(lambda: 0)   # set by the server: live viewer count
    _prio_run = 0                        # priority picks since the last free one (fairness interleave)
    _limits: dict = {}
    _limits_at = 0.0

    def _knobs(self) -> dict:
        """Priority-queue knobs from idea_limits (editable without code), cached for a minute."""
        if time.monotonic() - self._limits_at > 60:
            try:
                rows = self.supa.rest("GET", "idea_limits?id=eq.1&select=prio_viewers,prio_pending,prio_ratio,busy_pending")
                self._limits = (rows or [{}])[0] or {}
            except Exception:
                pass
            self._limits_at = time.monotonic()
        return {"viewers": int(self._limits.get("prio_viewers") or 10), "pending": int(self._limits.get("prio_pending") or 6),
                "ratio": max(1, int(self._limits.get("prio_ratio") or 2)),
                "busy": int(self._limits.get("busy_pending") or BUSY_PENDING)}

    def _pick(self, rows: list, n: int, busy: bool, ratio: int) -> list:
        """Busy: donor/boosted ideas jump ahead, interleaved `ratio` priority : 1 free so free ideas still play.
        Rows arrive in the mode's order (FIFO or votes); priority rows keep boost-then-that order."""
        # Everyone waits their turn; no paid or donor priority, no curation. Busy: take turns by
        # submitter (round-robin, one idea per person per round, arrival/vote order within each).
        # Quiet: plain order, so one person may queue as much as they like.
        if not busy:
            return rows[:n]
        lanes: dict = {}
        for r in rows:
            if r.get("user_id"):
                own = "u:" + str(r["user_id"])
            elif r.get("guest_id"):
                own = "g:" + str(r["guest_id"])
            else:
                own = "id:" + str(r.get("id"))
            lanes.setdefault(own, []).append(r)
        out, k = [], 0
        while len(out) < n and any(len(v) > k for v in lanes.values()):
            for v in lanes.values():
                if len(v) > k and len(out) < n:
                    out.append(v[k])
            k += 1
        return out
        prio = sorted([r for r in rows if r.get("_prio")], key=lambda r: -(r.get("boost_cents") or 0))
        free = [r for r in rows if not r.get("_prio")]
        out = []
        while len(out) < n and (prio or free):
            if prio and (self._prio_run < ratio or not free):
                out.append(prio.pop(0)); self._prio_run += 1
            else:
                out.append(free.pop(0)); self._prio_run = 0
        return out  # cached pool ideas still waiting (for the canonical upcoming list)

    def state(self) -> dict:
        hours = None
        if self.fuel_cents is not None:
            hours = max(0.0, self.fuel_cents / GPU_CENTS_PER_HOUR)
        return {"cents": None if self.fuel_cents is None else round(self.fuel_cents, 2),
                "hours": None if hours is None else round(hours, 2), "out": self.out_of_fuel,
                "gpu_cents_per_hour": GPU_CENTS_PER_HOUR, "queue_mode": self.queue_mode}

    def _audience_pending(self) -> bool:
        st = self.director.state()
        items = st["items"] + ([st["target_scene"]] if st.get("target_scene") else [])
        return any(i.get("origin") == "user" for i in items)

    async def refresh_pending(self) -> None:
        """Cache the waiting pool (canonical play order, with place + honest ETA) for the Next sheet."""
        try:
            rows = await asyncio.to_thread(self.supa.rest, "POST", "rpc/fair_line", {"p_limit": 20})
            rows = [{"id": r["id"], "handle": r.get("handle"), "body": (r.get("body") or "")[:200],
                     "image": bool(r.get("image_path")), "votes": r.get("votes") or 0,
                     "place": r.get("place"), "eta": r.get("eta_s")} for r in (rows or [])]
        except Exception:
            order = "created_at.asc" if self.queue_mode == "fifo" else "votes.desc,created_at.asc"
            rows = await asyncio.to_thread(
                self.supa.rest, "GET", f"ideas?status=eq.pending&order={order}&limit=20&select=id,handle,body,image_path,votes")
            rows = [{"id": r["id"], "handle": r.get("handle"), "body": (r.get("body") or "")[:200],
                     "image": bool(r.get("image_path")), "votes": r.get("votes") or 0} for r in (rows or [])]
        if rows != self.pending:
            self.pending = rows
            self.on_change()

    async def pull_ideas(self) -> None:
        if self._audience_pending():
            return
        rows = await asyncio.to_thread(
            self.supa.rest, "GET",
            "ideas?status=eq.pending&order=created_at.asc&limit=40&select=id")
        n_pending = len(rows or [])
        mode = queue_mode(n_pending)
        knobs = await asyncio.to_thread(self._knobs)
        busy = self.viewers() >= knobs["viewers"] or n_pending >= knobs["pending"]
        if mode != self.queue_mode:
            self.queue_mode = mode
            self.broadcast({"type": "fuel", "fuel": self.state()})
        order = "created_at.asc" if mode == "fifo" else "votes.desc,created_at.asc"
        # FIFO: weave one idea at a time, in arrival order, so each starts right away.
        want = 1 if mode == 'fifo' else 3
        self.busy = n_pending > knobs.get("busy", BUSY_PENDING)
        if self.busy:
            # Fair queue: one idea per person per round, votes + waiting-time score, pick cooldown and
            # expiry, chosen atomically in Supabase (already marked playing). No LLM involved.
            rows = await asyncio.to_thread(self.supa.rest, "POST", "rpc/pick_ideas", {"p_n": want})
        else:
            rows = await asyncio.to_thread(
                self.supa.rest, "GET",
                f"ideas?status=eq.pending&order={order}&limit={40 if busy else want}"
                "&select=id,handle,body,votes,boost_cents,image_path,user_id,guest_id")
        if not rows:
            return
        rows = self._pick(rows, want, busy, knobs["ratio"])
        images: list[tuple[bytes, str]] = []
        kept = []
        from .guard import hard_block_reason
        for r in rows:
            why = hard_block_reason(r.get("body") or "")
            if why:
                await asyncio.to_thread(self.supa.rest, "PATCH", f"ideas?id=eq.{r['id']}", {"status": "rejected"}, "return=minimal")
                await asyncio.to_thread(self.supa.audit, "idea_hard_block", str(r["id"]), {"reason": why})
                continue
            if r.get("image_path"):
                img = await asyncio.to_thread(self._load_ref, r["image_path"])
                if img is None:
                    await asyncio.to_thread(self.supa.rest, "PATCH", f"ideas?id=eq.{r['id']}", {"status": "rejected"}, "return=minimal")
                    await asyncio.to_thread(self.supa.audit, "nsfw_ref_block", str(r["id"]), {"path": r["image_path"]})
                    continue
                images.append(img)
            kept.append(r)
        rows = kept
        if not rows:
            return
        ids = ",".join(str(r["id"]) for r in rows)
        await asyncio.to_thread(self.supa.rest, "PATCH", f"ideas?id=in.({ids})&status=eq.pending",
                                {"status": "playing", "picked_at": datetime.now(timezone.utc).isoformat()}, "return=minimal")
        if len(rows) == 1:
            intent = rows[0]["body"]
            if intent.strip().lower() == "inspired by this image" and images:
                intent = ("Take the journey into the attached reference image: describe and match its subject, setting, "
                          "palette, light and mood as one continuous scene.")
        else:
            intent = "Weave these audience ideas into one continuous journey, in this order: " + \
                     " ; ".join(f"{i + 1}) {r['body']}" for i, r in enumerate(rows))
        st = self.director.state()
        if images:  # image ideas still need vision moderation + description
            plan = await asyncio.to_thread(self.interpreter.plan, intent, st["target"] or st["current"], None, images or None)
        else:
            # Text ideas go straight to the screen: one prompt per idea, no LLM planning, beats or bridges.
            plan = direct_plan([r["body"] for r in rows], hold=BUSY_HOLD if self.busy else 4)
        if self.busy:
            for s_ in plan.get("scenes") or []:
                s_["hold"] = min(int(s_.get("hold") or BUSY_HOLD), BUSY_HOLD + 1)
        from . import refs as _refs

        if images and (_refs.blocked(plan.get("image_flags")) or plan.get("source") != "haiku"):
            # Vision moderation flagged (or couldn't check) the reference image: reject, never render it.
            await asyncio.to_thread(self.supa.rest, "PATCH", f"ideas?id=in.({ids})", {"status": "rejected"}, "return=minimal")
            await asyncio.to_thread(self.supa.audit, "ref_block", ids, {"flags": plan.get("image_flags"), "source": plan.get("source")})
            return
        by = ", ".join(dict.fromkeys("@" + r["handle"] for r in rows))
        from .guard import is_disallowed

        scenes = [make_scene(s["prompt"], s.get("negative", ""), s.get("title", ""), s.get("transition"), s.get("hold"),
                             source=" · ".join(r["body"] for r in rows)[:200], origin="user", style=s.get("style"), beats=s.get("beats"),
                             lora=__import__("infinite_tapestry.styles", fromlist=["x"]).explicit_lora(" ".join(r["body"] for r in rows)))
                  for s in plan["scenes"] if not is_disallowed(s["prompt"])]
        if not scenes:
            # Nothing survived the guard — don't leave ideas stuck as playing.
            await asyncio.to_thread(self.supa.rest, "PATCH", f"ideas?id=in.({ids})",
                                    {"status": "rejected"}, "return=minimal")
            await asyncio.to_thread(self.supa.audit, "director_reject", ids, {"reason": "all_scenes_disallowed"})
            return
        for sc in scenes:
            sc["by"] = by
            sc["idea_ids"] = [r["id"] for r in rows]
        if images:
            # Steer the idea's own scene(s) with the (first) reference image via IP-Adapter.
            for sc in scenes[-2:]:
                _refs.put(sc["id"], images[0][0])
                sc["ref"] = "style"
        self.director.add_user(scenes)
        # Stay `playing` until track_landing sees the idea leave the stage; only
        # store the plan here so a restart before landing can recover (see recover_interrupted).
        await asyncio.to_thread(self.supa.rest, "PATCH", f"ideas?id=in.({ids})",
                                {"plan": {"titles": [s["title"] for s in scenes], "source": plan.get("source")}},
                                "return=minimal")
        await asyncio.to_thread(self.supa.audit, "director_merge", ids, {"titles": [s["title"] for s in scenes], "by": by})
        self.broadcast({"type": "activity", "text": intent[:200], "titles": [s["title"] for s in scenes], "by": by})
        self.on_change()

    async def meter(self) -> None:
        now = time.monotonic()
        minutes = (now - self._last_burn) / 60.0
        self._last_burn = now
        tokens = getattr(self.interpreter, "tokens_used", 0)
        claude_cents = (tokens - self._last_tokens) * CLAUDE_CENTS_PER_TOKEN
        self._last_tokens = tokens
        if self.burn:
            gpu = GPU_CENTS_PER_HOUR / 60.0 * minutes
            rows = [{"delta_cents": -round(gpu, 4), "reason": "gpu_burn", "ref": os.environ.get("RUNPOD_POD_ID", "")}]
            if claude_cents > 0:
                rows.append({"delta_cents": -round(claude_cents, 4), "reason": "claude_burn", "ref": str(tokens)})
            await asyncio.to_thread(self.supa.rest, "POST", "fuel_ledger", rows, "return=minimal")
        st = await asyncio.to_thread(self.supa.rest, "GET", "fuel_status?select=balance_cents")
        self.fuel_cents = float(st[0]["balance_cents"]) if st else 0.0
        was = self.out_of_fuel
        self.out_of_fuel = self.fuel_cents <= 0
        self.broadcast({"type": "fuel", "fuel": self.state()})
        # Fuel is display-only: the GPU runs 24/7. The only stop is the RunPod credit guard ($0.50).
        if self.out_of_fuel and not was and self.burn:
            await asyncio.to_thread(self.supa.audit, "out_of_fuel", os.environ.get("RUNPOD_POD_ID", ""), {"cents": self.fuel_cents})

    def _load_ref(self, path: str) -> tuple[bytes, str] | None:
        """Fetch a reference image (<=2 MB), screen it with the NSFW classifier. None = blocked/unusable."""
        import io
        from PIL import Image
        try:
            url = f"{self.supa.url}/storage/v1/object/public/idea-refs/{urllib.parse.quote(path)}"
            data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "tapestry"}), timeout=15).read(2_100_000)
            im = Image.open(io.BytesIO(data)).convert("RGB")
            im.thumbnail((768, 768))
            nsfw = getattr(self.generator, "nsfw", None)
            if nsfw is not None and nsfw(im) >= getattr(self.generator.config, "nsfw_threshold", 0.6):
                return None
            buf = io.BytesIO(); im.save(buf, "JPEG", quality=85)
            return buf.getvalue(), "image/jpeg"
        except Exception:
            logger.exception("reference image failed: %s", path)
            return None

    async def track_landing(self) -> None:
        """Record where each idea landed on the tapestry (strip range) for permalinks.

        Marks status=played + played_at when the idea leaves the stage (end_strip
        is written). Ideas stay `playing` from pull_ideas until then so a restart
        before landing can re-queue them.
        """
        st = self.director.state()
        idx = int(getattr(self.director, "_last_index", 0))
        live = set()
        for sc in (st.get("current_scene"), st.get("target_scene")):
            for i in (sc or {}).get("idea_ids") or []:
                live.add(i)
        started = getattr(self, "_landing", {})
        for i in live - set(started):
            started[i] = idx
            await asyncio.to_thread(self.supa.rest, "PATCH", f"ideas?id=eq.{i}&start_strip=is.null", {"start_strip": idx}, "return=minimal")
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for i in set(started) - live:
            started.pop(i)
            await asyncio.to_thread(
                self.supa.rest, "PATCH", f"ideas?id=eq.{i}",
                {"end_strip": idx, "status": "played", "played_at": now}, "return=minimal")
        self._landing = started

    # Fallback span when an idea reached the stage (has start_strip) but the server
    # restarted before end_strip was written. Matches the frontend share/profile
    # fallback of start_strip + 12.
    _ORPHAN_SPAN = 12

    def _director_idea_ids(self) -> set:
        """idea_ids still on the restored director (current + target + queue)."""
        st = self.director.state()
        ids: set = set()
        scenes = list(st.get("items") or [])
        for sc in (st.get("current_scene"), st.get("target_scene")):
            if sc:
                scenes.append(sc)
        for sc in scenes:
            for i in (sc or {}).get("idea_ids") or []:
                ids.add(i)
        return ids

    async def recover_interrupted(self) -> None:
        """On Crowd startup: fix ideas left mid-flight by a previous process.

        Skip any idea whose id is still on the restored director (state.json
        persists queue/current/target with idea_ids) — those will keep playing
        and track_landing will finish them.

        - playing + start_strip IS NULL → pending (was queued, never reached stage)
        - playing + start_strip set + end_strip IS NULL → played with
          end_strip = start_strip + 12 (reached the stage; close the range)
        """
        live = self._director_idea_ids()
        never_landed = await asyncio.to_thread(
            self.supa.rest, "GET",
            "ideas?status=eq.playing&start_strip=is.null&select=id") or []
        for r in never_landed:
            if r["id"] in live:
                continue
            await asyncio.to_thread(
                self.supa.rest, "PATCH", f"ideas?id=eq.{r['id']}",
                {"status": "pending"}, "return=minimal")
        orphaned = await asyncio.to_thread(
            self.supa.rest, "GET",
            "ideas?status=eq.playing&start_strip=not.is.null&end_strip=is.null&select=id,start_strip") or []
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for r in orphaned:
            if r["id"] in live:
                continue
            start = int(r["start_strip"])
            await asyncio.to_thread(
                self.supa.rest, "PATCH", f"ideas?id=eq.{r['id']}",
                {"status": "played", "played_at": now, "end_strip": start + self._ORPHAN_SPAN},
                "return=minimal")

    async def run(self) -> None:
        last_meter = 0.0
        try:
            await self.recover_interrupted()
        except Exception:
            logger.exception("crowd recover failed")
        while True:
            try:
                if time.monotonic() - last_meter >= 60 or self.fuel_cents is None:
                    last_meter = time.monotonic()
                    await self.meter()
                await self.refresh_pending()
                await self.pull_ideas()
                await self.track_landing()
            except Exception:
                logger.exception("crowd tick failed")
            await asyncio.sleep(3)
