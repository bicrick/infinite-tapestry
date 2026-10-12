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
from typing import Any, Callable

from .prompts import make_scene

logger = logging.getLogger(__name__)

GPU_CENTS_PER_HOUR = float(os.environ.get("TAPESTRY_GPU_CENTS_PER_HOUR", "17"))
# Haiku pricing used for the fuel meter (input, output) in cents per token.
CLAUDE_CENTS_PER_TOKEN = float(os.environ.get("TAPESTRY_CLAUDE_CENTS_PER_MTOK", "30")) / 1_000_000


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

    def state(self) -> dict:
        hours = None
        if self.fuel_cents is not None:
            hours = max(0.0, self.fuel_cents / GPU_CENTS_PER_HOUR)
        return {"cents": None if self.fuel_cents is None else round(self.fuel_cents, 2),
                "hours": None if hours is None else round(hours, 2), "out": self.out_of_fuel}

    def _audience_pending(self) -> bool:
        st = self.director.state()
        items = st["items"] + ([st["target_scene"]] if st.get("target_scene") else [])
        return any(i.get("origin") == "user" for i in items)

    async def pull_ideas(self) -> None:
        if self._audience_pending():
            return
        rows = await asyncio.to_thread(
            self.supa.rest, "GET",
            "ideas?status=eq.pending&order=boost_cents.desc,votes.desc,created_at.asc&limit=3&select=id,handle,body,votes,boost_cents,image_path")
        if not rows:
            return
        images: list[tuple[bytes, str]] = []
        kept = []
        for r in rows:
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
        await asyncio.to_thread(self.supa.rest, "PATCH", f"ideas?id=in.({ids})&status=eq.pending", {"status": "playing"}, "return=minimal")
        if len(rows) == 1:
            intent = rows[0]["body"]
        else:
            intent = "Weave these audience ideas into one continuous journey, in this order: " + \
                     " ; ".join(f"{i + 1}) {r['body']}" for i, r in enumerate(rows))
        st = self.director.state()
        plan = await asyncio.to_thread(self.interpreter.plan, intent, st["target"] or st["current"], None, images or None)
        by = ", ".join(dict.fromkeys("@" + r["handle"] for r in rows))
        from .guard import is_disallowed

        scenes = [make_scene(s["prompt"], s.get("negative", ""), s.get("title", ""), s.get("transition"), s.get("hold"),
                             source=" · ".join(r["body"] for r in rows)[:200], origin="user", style=s.get("style"))
                  for s in plan["scenes"] if not is_disallowed(s["prompt"])]
        for sc in scenes:
            sc["by"] = by
            sc["idea_ids"] = [r["id"] for r in rows]
        if scenes:
            self.director.add_user(scenes)
        await asyncio.to_thread(self.supa.rest, "PATCH", f"ideas?id=in.({ids})",
                                {"status": "played", "played_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                 "plan": {"titles": [s["title"] for s in scenes], "source": plan.get("source")}}, "return=minimal")
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
        if self.out_of_fuel and not was and self.burn:
            await asyncio.to_thread(self.supa.audit, "out_of_fuel", os.environ.get("RUNPOD_POD_ID", ""), {"cents": self.fuel_cents})
            await asyncio.to_thread(self._stop_self)

    def _stop_self(self) -> None:
        """Ask RunPod to stop this pod (state is already durable in Supabase)."""
        pod, key = os.environ.get("RUNPOD_POD_ID"), os.environ.get("RUNPOD_API_KEY")
        if not (pod and key) or self.mock:
            return
        try:
            self.supa.rest("PATCH", "pod_state?id=eq.1", {"status": "sleeping", "note": "out of fuel"}, "return=minimal")
            if self.generator is not None and getattr(self.generator, "store", None):
                st = self.generator.store
                st.save_state(self.generator.snapshot_state(), self.generator.canvas, force=True)
                time.sleep(5)  # let the uploader flush
            body = json.dumps({"query": f'mutation {{ podStop(input: {{podId: "{pod}"}}) {{ id desiredStatus }} }}'}).encode()
            req = urllib.request.Request("https://api.runpod.io/graphql", data=body,
                                         headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
            urllib.request.urlopen(req, timeout=20).read()
            self.supa.audit("pod_stop", pod, {"by": "server", "reason": "out of fuel"})
        except Exception:
            logger.exception("self-stop failed")

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
        """Record where each idea landed on the tapestry (strip range) for permalinks."""
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
        for i in set(started) - live:
            started.pop(i)
            await asyncio.to_thread(self.supa.rest, "PATCH", f"ideas?id=eq.{i}", {"end_strip": idx}, "return=minimal")
        self._landing = started

    async def run(self) -> None:
        last_meter = 0.0
        while True:
            try:
                if time.monotonic() - last_meter >= 60 or self.fuel_cents is None:
                    last_meter = time.monotonic()
                    await self.meter()
                await self.pull_ideas()
                await self.track_landing()
            except Exception:
                logger.exception("crowd tick failed")
            await asyncio.sleep(8)
