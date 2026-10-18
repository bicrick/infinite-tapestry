"""Crowd director + fuel meter, backed by Supabase (service role, server only).

- Pulls the top pending ideas (boost, votes, age) from the shared pool when the
  director has no audience scenes queued, has Claude tidy each idea into its own
  scene (faithful cleanup, never blended), and queues them in order, attributed.
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

from . import pools
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

GPU_CENTS_PER_HOUR = float(os.environ.get("TAPESTRY_GPU_CENTS_PER_HOUR", "89"))
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

    _title_tasks: set = set()

    async def _retitle(self, scene_id: int, body: str, cur: str) -> None:
        """Haiku's short title for a text idea, applied once it arrives (the scene already started with a local one)."""
        try:
            plan = await pools.control(self.interpreter.plan, body, cur, None, None, timeout=30)
            title = ((plan.get("scenes") or [{}])[0] or {}).get("title")
            if plan.get("source") == "haiku" and title and hasattr(self.director, "retitle"):
                self.director.retitle(scene_id, title)
                self.on_change()
        except Exception:
            pass

    def state(self) -> dict:
        hours = None
        if self.fuel_cents is not None:
            hours = max(0.0, self.fuel_cents / GPU_CENTS_PER_HOUR)
        return {"cents": None if self.fuel_cents is None else round(self.fuel_cents, 2),
                "hours": None if hours is None else round(hours, 2), "out": self.out_of_fuel,
                "gpu_cents_per_hour": GPU_CENTS_PER_HOUR, "queue_mode": self.queue_mode}

    MAX_QUEUED_IDEAS = 3   # user scenes queued ahead (FIFO); more wait in the pool so the line/ETA stays honest

    def _audience_pending(self) -> bool:
        return self._queued_ideas() >= self.MAX_QUEUED_IDEAS

    def _queued_ideas(self) -> int:
        st = self.director.state()
        items = st["items"] + ([st["target_scene"]] if st.get("target_scene") else [])
        return sum(1 for i in items if i.get("origin") == "user")

    def _on_stage_bodies(self) -> set:
        """Normalized bodies of user scenes queued or on stage (duplicate-idea guard)."""
        st = self.director.state()
        items = st["items"] + [x for x in (st.get("target_scene"), st.get("current_scene")) if x]
        return {" ".join(str(i.get("source") or "").lower().split()) for i in items if i.get("origin") == "user"}

    async def refresh_pending(self) -> None:
        """Cache the waiting pool (canonical play order, with place + honest ETA) for the Next sheet."""
        try:
            rows = await pools.control(self.supa.rest, "POST", "rpc/fair_line", {"p_limit": 20})
            rows = [{"id": r["id"], "handle": r.get("handle"), "body": (r.get("body") or "")[:200],
                     "image": bool(r.get("image_path")), "votes": r.get("votes") or 0,
                     "place": r.get("place"), "eta": r.get("eta_s")} for r in (rows or [])]
        except Exception:
            order = "created_at.asc" if self.queue_mode == "fifo" else "votes.desc,created_at.asc"
            rows = await pools.control(
                self.supa.rest, "GET", f"ideas?status=eq.pending&order={order}&limit=20&select=id,handle,body,image_path,votes")
            rows = [{"id": r["id"], "handle": r.get("handle"), "body": (r.get("body") or "")[:200],
                     "image": bool(r.get("image_path")), "votes": r.get("votes") or 0} for r in (rows or [])]
        if rows != self.pending:
            self.pending = rows
            self.on_change()

    async def pull_ideas(self) -> None:
        if self._audience_pending():
            return
        rows = await pools.control(
            self.supa.rest, "GET",
            "ideas?status=eq.pending&order=created_at.asc&limit=40&select=id")
        n_pending = len(rows or [])
        mode = queue_mode(n_pending)
        knobs = await pools.control(self._knobs)
        busy = self.viewers() >= knobs["viewers"] or n_pending >= knobs["pending"]
        if mode != self.queue_mode:
            self.queue_mode = mode
            self.broadcast({"type": "fuel", "fuel": self.state()})
        order = "created_at.asc" if mode == "fifo" else "votes.desc,created_at.asc"
        # FIFO: weave one idea at a time, in arrival order, so each starts right away.
        want = max(1, self.MAX_QUEUED_IDEAS - self._queued_ideas()) if mode == "fifo" else 3
        self.busy = n_pending > knobs.get("busy", BUSY_PENDING)
        if self.busy:
            # Fair queue: one idea per person per round, votes + waiting-time score, pick cooldown and
            # expiry, chosen atomically in Supabase (already marked playing). No LLM involved.
            rows = await pools.control(self.supa.rest, "POST", "rpc/pick_ideas", {"p_n": want})
        else:
            rows = await pools.control(
                self.supa.rest, "GET",
                f"ideas?status=eq.pending&order={order}&limit={40 if busy else want}"
                "&select=id,handle,body,votes,boost_cents,image_path,user_id,guest_id,created_at")
        if not rows:
            return
        rows = self._pick(rows, want, busy, knobs["ratio"])
        kept: list[tuple[dict, tuple[bytes, str] | None]] = []
        from .guard import hard_block_reason
        for r in rows:
            why = hard_block_reason(r.get("body") or "")
            if why:
                await pools.control(self.supa.rest, "PATCH", f"ideas?id=eq.{r['id']}", {"status": "rejected"}, "return=minimal")
                await pools.control(self.supa.audit, "idea_hard_block", str(r["id"]), {"reason": why})
                continue
            img = None
            if r.get("image_path"):
                img = await pools.control(self._load_ref, r["image_path"])
                if img is None:
                    await pools.control(self.supa.rest, "PATCH", f"ideas?id=eq.{r['id']}", {"status": "rejected"}, "return=minimal")
                    await pools.control(self.supa.audit, "nsfw_ref_block", str(r["id"]), {"path": r["image_path"]})
                    continue
            kept.append((r, img))
        if not kept:
            return
        ids = ",".join(str(r["id"]) for r, _ in kept)
        if not self.busy:   # pick_ideas (busy mode) already claimed atomically in Supabase
            claimed = await pools.control(self.supa.rest, "PATCH", f"ideas?id=in.({ids})&status=eq.pending",
                                          {"status": "playing", "picked_at": datetime.now(timezone.utc).isoformat()},
                                          "return=representation")
            if isinstance(claimed, list):   # another pod (or a withdraw) took the rest
                got = {str(c.get("id")) for c in claimed if isinstance(c, dict)}
                kept = [(r, img) for r, img in kept if str(r["id"]) in got]
            if not kept:
                return
        # Duplicate guard: the same words already queued/on stage are merged into that scene, not played twice.
        stage = self._on_stage_bodies()
        dups = [r for r, _ in kept if " ".join(str(r.get("body") or "").lower().split())[:200] in stage]
        for r in dups:
            await pools.control(self.supa.rest, "PATCH", f"ideas?id=eq.{r['id']}",
                                {"status": "played", "played_at": datetime.now(timezone.utc).isoformat(),
                                 "plan": {"duplicate": True}}, "return=minimal")
        kept = [(r, img) for r, img in kept if r not in dups]
        if not kept:
            return
        st = self.director.state()
        cur = st["target"] or st["current"]
        # Each idea is its own scene, planned independently (never woven together), queued in order.
        from .interpreter import assemble_plan

        async def plan_for(r, img):
            if img is None:   # text: the prompt is the user's words verbatim; the Haiku title follows asynchronously
                core = " ".join(str(r.get("body") or "").split())[:500]
                return {**assemble_plan(core, None), "note": "your words, verbatim", "image_flags": [], "source": "local"}
            try:   # image ideas still need Haiku's vision moderation before anything is painted
                return await pools.control(self.interpreter.plan, r.get("body") or "", cur, None, [img], timeout=60)
            except Exception:
                return {"scenes": [], "source": "error", "image_flags": []}
        plans = await asyncio.gather(*[plan_for(r, img) for r, img in kept])
        from . import refs as _refs
        from .guard import is_disallowed
        from .styles import explicit_lora
        queued: list = []
        for (r, img), plan in zip(kept, plans):
            rid = str(r["id"])
            if img and (_refs.blocked(plan.get("image_flags")) or plan.get("source") != "haiku"):
                # Vision moderation flagged (or couldn't check) the reference image: reject, never render it.
                await pools.control(self.supa.rest, "PATCH", f"ideas?id=eq.{rid}", {"status": "rejected"}, "return=minimal")
                await pools.control(self.supa.audit, "ref_block", rid, {"flags": plan.get("image_flags"), "source": plan.get("source")})
                continue
            body = r.get("body") or ""
            scenes = [make_scene(s["prompt"], s.get("negative", ""), s.get("title", ""), 1,   # 1-strip takeover
                                 BUSY_HOLD if self.busy else 4, source=body[:200], origin="user",
                                 style=s.get("style"), beats=s.get("beats"), lora=explicit_lora(body))
                      for s in (plan.get("scenes") or [])[:1]
                      if (body and s["prompt"].startswith(" ".join(body.split()))) or not is_disallowed(s["prompt"])]
            if not scenes:
                # Nothing survived the guard: don't leave the idea stuck as playing.
                await pools.control(self.supa.rest, "PATCH", f"ideas?id=eq.{rid}", {"status": "rejected"}, "return=minimal")
                await pools.control(self.supa.audit, "director_reject", rid, {"reason": "all_scenes_disallowed"})
                continue
            sc = scenes[0]
            sc["by"] = "@" + str(r.get("handle") or "someone")
            sc["idea_ids"] = [r["id"]]
            if img:
                _refs.put(sc["id"], img[0])  # steer this idea's scene with its own reference image
                sc["ref"] = "style"
            queued.append((r, sc, plan))
        if not queued:
            return
        self.director.add_user([sc for _, sc, _ in queued])
        for r, sc, plan in queued:
            try:
                age = time.time() - datetime.fromisoformat(str(r.get("created_at")).replace("Z", "+00:00")).timestamp()
            except Exception:
                age = -1.0
            logger.info("idea %s queued (%s) %.1fs after submit: %s", r["id"], plan.get("source"), age, sc["title"])
            if plan.get("source") == "local" and getattr(self.interpreter, "enabled", False):
                t = asyncio.get_running_loop().create_task(self._retitle(sc["id"], r.get("body") or "", cur))
                self._title_tasks.add(t)
                t.add_done_callback(self._title_tasks.discard)
        for r, sc, plan in queued:
            # Stay `playing` until track_landing sees the idea leave the stage; store the plan so a
            # restart before landing can recover (see recover_interrupted).
            await pools.control(self.supa.rest, "PATCH", f"ideas?id=eq.{r['id']}",
                                    {"plan": {"titles": [sc["title"]], "source": plan.get("source")}}, "return=minimal")
            await pools.control(self.supa.audit, "director_merge", str(r["id"]), {"titles": [sc["title"]], "by": sc["by"]})
            self.broadcast({"type": "activity", "text": (r.get("body") or "")[:200], "titles": [sc["title"]], "by": sc["by"]})
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
            await pools.control(self.supa.rest, "POST", "fuel_ledger", rows, "return=minimal")
        st = await pools.control(self.supa.rest, "GET", "fuel_status?select=balance_cents")
        self.fuel_cents = float(st[0]["balance_cents"]) if st else 0.0
        was = self.out_of_fuel
        self.out_of_fuel = self.fuel_cents <= 0
        self.broadcast({"type": "fuel", "fuel": self.state()})
        # Fuel is display-only: the GPU runs 24/7. The only stop is the RunPod credit guard ($0.50).
        if self.out_of_fuel and not was and self.burn:
            await pools.control(self.supa.audit, "out_of_fuel", os.environ.get("RUNPOD_POD_ID", ""), {"cents": self.fuel_cents})

    on_event = None   # set by main: OpsLog.event
    _ref_clf: Any = False

    def _ref_classifier(self):
        """Uploaded-image NSFW screen (input only), CPU, loaded on first use. Tests may inject generator.nsfw."""
        inj = getattr(self.generator, "nsfw", None)
        if inj is not None:
            return inj
        if self._ref_clf is False:
            cfg = getattr(self.generator, "config", None)
            model = "" if cfg is None or getattr(cfg, "mock", False) else getattr(cfg, "ref_nsfw_model", "")
            from .nsfw import load_classifier
            self._ref_clf = load_classifier(model, "cpu") if model else None
        return self._ref_clf

    def _load_ref(self, path: str) -> tuple[bytes, str] | None:
        """Fetch a reference image (<=2 MB), screen it with the NSFW classifier. None = blocked/unusable."""
        import io
        from PIL import Image
        try:
            url = f"{self.supa.url}/storage/v1/object/public/idea-refs/{urllib.parse.quote(path)}"
            data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "tapestry"}), timeout=15).read(2_100_000)
            im = Image.open(io.BytesIO(data)).convert("RGB")
            im.thumbnail((768, 768))
            nsfw = self._ref_classifier()
            if nsfw is not None:
                cfg = self.generator.config
                p = nsfw(im)
                if getattr(cfg, "nsfw_log_min", 1.0) <= p < getattr(cfg, "nsfw_threshold", 0.8) and self.on_event:
                    self.on_event("nsfw_near", kind="ref", score=round(float(p), 3), threshold=cfg.nsfw_threshold)
                if p >= getattr(cfg, "nsfw_threshold", 0.8):
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
            await pools.control(self.supa.rest, "PATCH", f"ideas?id=eq.{i}&start_strip=is.null", {"start_strip": idx}, "return=minimal")
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for i in set(started) - live:
            started.pop(i)
            await pools.control(
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
        never_landed = await pools.control(
            self.supa.rest, "GET",
            "ideas?status=eq.playing&start_strip=is.null&select=id") or []
        for r in never_landed:
            if r["id"] in live:
                continue
            await pools.control(
                self.supa.rest, "PATCH", f"ideas?id=eq.{r['id']}",
                {"status": "pending"}, "return=minimal")
        orphaned = await pools.control(
            self.supa.rest, "GET",
            "ideas?status=eq.playing&start_strip=not.is.null&end_strip=is.null&select=id,start_strip") or []
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for r in orphaned:
            if r["id"] in live:
                continue
            start = int(r["start_strip"])
            await pools.control(
                self.supa.rest, "PATCH", f"ideas?id=eq.{r['id']}",
                {"status": "played", "played_at": now, "end_strip": start + self._ORPHAN_SPAN},
                "return=minimal")

    async def run(self) -> None:
        last_meter = 0.0
        try:
            await self.recover_interrupted()
        except Exception:
            logger.exception("crowd recover failed")
        ideas = asyncio.get_running_loop().create_task(self._idea_loop())
        try:
            while True:
                try:
                    if time.monotonic() - last_meter >= 60 or self.fuel_cents is None:
                        last_meter = time.monotonic()
                        await self.meter()
                    await self.refresh_pending()
                    await self.track_landing()
                except Exception:
                    logger.exception("crowd tick failed")
                await asyncio.sleep(3)
        finally:
            ideas.cancel()

    IDEA_POLL_S = 1.0

    async def _idea_loop(self) -> None:
        """New ideas are picked up within ~1 s (was every 3 s, behind the meter/pending/landing calls)."""
        while True:
            try:
                await self.pull_ideas()
            except Exception:
                logger.exception("idea pull failed")
            await asyncio.sleep(self.IDEA_POLL_S)
