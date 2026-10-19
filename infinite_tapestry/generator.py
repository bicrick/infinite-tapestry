"""Background strip generator with rolling canvas and prompt drift."""

from __future__ import annotations

import io
import logging
import threading
import time
from typing import TYPE_CHECKING

from PIL import Image

from .buffer import Strip, StripBuffer
from .canvas import (
    build_inpaint_inputs,
    histogram_match_strip,
    correct_drift,
    harmonize_seam,
    make_seed_image,
    stitch_generated_window,
)
from .prompts import LiveDirector, PromptScheduler

if TYPE_CHECKING:
    from .config import Config
    from .inpaint import Inpainter

logger = logging.getLogger(__name__)


def seam_score(img: Image.Image, x0: int, x1: int) -> float:
    """How much [x0, x1) looks like an inpainting seam (a dead-straight cut).

    A seam is a jump between two adjacent columns that is strong in nearly
    EVERY row. Real vertical content (pillars, building edges, shelves) is
    usually interrupted somewhere (floors, ceilings, overlaps, shading), so we
    weight the column's mean jump by the fraction of rows where the jump is
    strong, then divide by the region's median gradient."""
    import numpy as np

    a = np.asarray(img.convert("RGB"), dtype=np.float32)[:, max(0, x0 - 8):x1]
    if a.shape[1] < 3:
        return 0.0
    d = np.abs(np.diff(a, axis=1)).mean(axis=2)  # (H, W-1)
    row_med = np.median(d, axis=1, keepdims=True) + 2.0
    coverage = (d > 4.0 * row_med).mean(axis=0)  # fraction of rows with a strong jump
    g = d.mean(axis=0)
    # Sharpness: inpainting seams change in ONE column; painted edges (even
    # crisp pillars) are anti-aliased over 2-4 px after the VAE decode.
    gray = a.mean(axis=2)
    wide = np.zeros_like(g)
    wide[1:-1] = np.abs(gray[:, 3:] - gray[:, :-3]).mean(axis=0)
    sharp = g / (wide + 1.0)
    score = (
        g / (np.median(g) + 1.0)
        * np.clip((coverage - 0.5) / 0.4, 0.0, 1.0)
        * np.clip((sharp - 0.6) / 0.3, 0.0, 1.0)
    )
    return float(score.max())


class StripGenerator:
    """Produces strips on a worker thread into a StripBuffer."""

    def __init__(
        self,
        config: "Config",
        inpainter: "Inpainter",
        buffer: StripBuffer,
    ) -> None:
        self.config = config
        self.inpainter = inpainter
        self.buffer = buffer
        self.scheduler = PromptScheduler(config.prompts, config.negative_prompt)
        self.director = LiveDirector.from_schedule(
            config.prompts, config.negative_prompt, blend=config.blend_strips
        )
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._canvas: Image.Image = make_seed_image(
            config.height, config.context_width, seed=config.seed
        )
        self._strip_index = 0
        # EMA of seconds spent generating one strip = the GPU's raw capacity
        # (independent of buffer gating), used by the client's auto speed.
        self.gen_seconds_ema: float | None = None
        # No checks on the live canvas: generated strips are never scored, repainted, dropped or blurred,
        # and no classifier is loaded on the GPU. (Uploaded reference images are still screened in crowd.py.)
        self.nsfw_hits = 0
        self.on_flag = None
        self._ema_alpha = 0.2
        # Global mean/std matching compounded strip-over-strip and blew out
        # saturation on GPU; off by default.
        self._match_histogram = bool(config.mock)
        if not config.mock:
            self._canvas = self._paint_seed_canvas(self._canvas)

    def _paint_seed_canvas(self, seed: Image.Image) -> Image.Image:
        """Repaint the procedural seed with the model so strips don't inherit
        its synthetic stripes (GPU mode only)."""
        cfg = self.config
        frame = self.scheduler.frame_for(0)
        window = seed.resize((cfg.window_width, cfg.height))
        mask = Image.new("L", window.size, 255)
        try:
            painted = self.inpainter.generate(
                image=window,
                mask=mask,
                prompt=frame.prompt,
                negative_prompt=frame.negative_prompt,
                seed=cfg.seed,
            ).resize(window.size)
        except Exception:  # pragma: no cover - fall back to procedural seed
            logger.exception("Seed repaint failed; using procedural seed")
            return seed
        return painted.crop((0, 0, cfg.context_width, cfg.height))

    @property
    def canvas(self) -> Image.Image:
        with self._lock:
            return self._canvas.copy()

    @property
    def strip_index(self) -> int:
        return self._strip_index

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="strip-generator", daemon=True
        )
        self._thread.start()
        logger.info("Generator thread started")

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        self.buffer.close()
        if self._thread:
            self._thread.join(timeout=timeout)
            self._thread = None
        try:
            self.flush_persist()   # last strips/state land before a restart
        except Exception:
            logger.warning("persist flush on stop timed out")
        logger.info("Generator thread stopped")

    def _encode_jpeg(self, image: Image.Image) -> bytes:
        """Encode a strip for CDN/disk. Default WebP q65 ≈ half the JPEG q85 bytes."""
        buf = io.BytesIO()
        if (self.config.strip_format or "").lower() == "webp":
            image.save(buf, format="WEBP", quality=self.config.webp_quality, method=4)
        else:
            image.save(buf, format="JPEG", quality=self.config.jpeg_quality, optimize=True)
        return buf.getvalue()

    def generate_one(self) -> Strip:
        """Generate a single strip (also used by tests)."""
        cfg = self.config
        pending = getattr(self, "_anchor_pending", None)
        if pending:
            return self._emit_pending()
        with self._lock:
            canvas = self._canvas

        # GPU models tend to paint a frame/border at the image's right edge,
        # so paint `margin` extra px past the strip and throw them away.
        margin = 0 if cfg.mock else 32
        ctx_w = cfg.window_width - cfg.strip_width - margin
        window, mask, _context_x = build_inpaint_inputs(
            canvas,
            window_width=cfg.window_width,
            strip_width=cfg.strip_width + margin,
            height=cfg.height,
        )
        # Let the model repaint a band of the existing context too, so the new
        # content grows out of it instead of meeting it at a hard mask edge.
        prompt_a, prompt_b, blend_t = self.director.frame_for(self._strip_index)
        try:
            scene_meta = self.director.caption() if hasattr(self.director, "caption") else None
        except Exception:
            scene_meta = None
        band = min(cfg.repaint_band, ctx_w // 2) if self._strip_index > 0 else 0
        # Strips since the scene on stage changed (user ideas take over decisively for the first few).
        sk = ((scene_meta or {}).get("title"), (scene_meta or {}).get("by"), (scene_meta or {}).get("origin"))
        if sk != getattr(self, "_scene_key", None):
            self._scene_key, self._scene_strips = sk, 0
        else:
            self._scene_strips = getattr(self, "_scene_strips", 0) + 1
        user_takeover = (scene_meta or {}).get("origin") == "user" and \
            self._scene_strips < int(getattr(cfg, "takeover_strips", 2))
        self.last_takeover = bool(user_takeover)
        # Scene change: repaint most of the visible context (keep only a narrow seam
        # band) so the new idea isn't trapped inside the old composition.
        if band and prompt_b and not cfg.mock:
            band = max(band, int(ctx_w * getattr(cfg, "scene_change_repaint", 0.7)))
        # User idea taking over: repaint nearly all visible context for its first strips (only a thin seam
        # of the old scene stays), so the old composition can't re-propagate into the new idea.
        if band and user_takeover and not cfg.mock:
            band = max(band, ctx_w - int(getattr(cfg, "takeover_seam_px", 96)))
        self.last_band = band
        if band:
            import numpy as np

            m = np.asarray(mask).copy()
            m[:, ctx_w - band:] = 255
            mask = Image.fromarray(m, mode="L")
        # User ideas steer harder than Auto filler.
        if hasattr(self.inpainter, "guidance"):
            user_scene = (scene_meta or {}).get("origin") == "user"
            boost = getattr(cfg, "user_cfg_boost", 1.5) if user_scene else 0.0
            if user_takeover and cfg.guidance_scale > 1.5:
                boost = max(boost, getattr(cfg, "takeover_cfg_boost", 3.0))
            self.inpainter.guidance = cfg.guidance_scale + boost
        from .guard import is_disallowed

        # Last-line prompt guard for Auto/LLM-written prompts only. User ideas are the user's own words,
        # already moderated at submit (hard lines), so they are never swapped here.
        if (scene_meta or {}).get("origin") != "user":
            if is_disallowed(prompt_a):
                prompt_a = "abstract soft colored mist"
            if prompt_b and is_disallowed(prompt_b):
                prompt_b = None
        shown_prompt = prompt_b if (prompt_b and blend_t >= 0.5) else prompt_a
        from .styles import ramp, with_trigger

        style_a, style_b = self.director.styles_for(blend_t) if hasattr(self.director, "styles_for") else ("none", None)
        user_scene = (scene_meta or {}).get("origin") == "user"
        if not user_scene:  # user prompts stay verbatim (a LoRA the user named still applies by weight)
            prompt_a = with_trigger(prompt_a, style_a)
            if prompt_b:
                prompt_b = with_trigger(prompt_b, style_b or style_a)
        if hasattr(self.inpainter, "set_styles"):
            self.inpainter.set_styles(ramp(style_a, style_b, blend_t if prompt_b else 0.0))
        seed = cfg.seed + self._strip_index
        if hasattr(self.inpainter, "set_ref") and hasattr(self.director, "ref_ids"):
            from . import refs as _refs

            rid, rscale = _refs.schedule(*self.director.ref_ids(), blend_t if prompt_b else 0.0)
            self.inpainter.set_ref(rid, _refs.get(rid), rscale)

        # Fresh anchor on a scene change: paint the new scene from scratch (no tapestry context, so the
        # old horizon / bands / rows can't carry over), then join it to the tapestry with a bridge inpaint
        # over the seam only. The next strips are already painted and are emitted without GPU work.
        if (getattr(cfg, "fresh_anchor", False) and not cfg.mock and self._strip_index > 0
                and getattr(self, "_scene_strips", 1) == 0):
            try:
                return self._anchor(prompt_b or prompt_a, self.director.negative_for(1.0), seed, shown_prompt, scene_meta)
            except Exception:
                logger.exception("fresh anchor failed; continuing by outpainting")

        # SD sometimes paints a hard vertical "panel" edge instead of growing
        # out of the context (most often mid-transition). Score each attempt by
        # its worst column discontinuity in the repainted region and retry with
        # a new seed if it looks like a cut; keep the best attempt.
        attempts = 1 if cfg.mock else max(1, cfg.seam_retries + 1)
        best, best_score = None, None
        for k in range(attempts):
            cand = self.inpainter.generate(
                image=window,
                mask=mask,
                prompt=prompt_a,
                negative_prompt=self.director.negative_for(blend_t),
                seed=seed + 7919 * k,
                prompt_b=prompt_b,
                t=blend_t,
            )
            if attempts == 1:
                best = cand
                break
            score = seam_score(cand, ctx_w - band, cfg.window_width - margin)
            if best is None or score < best_score:
                best, best_score = cand, score
            if score < cfg.seam_threshold:
                break
            logger.info("Strip %d attempt %d looks seamed (score %.1f); retrying", self._strip_index, k, score)
        self.last_seam_score = best_score
        generated = best
        if generated.size != window.size:
            generated = generated.resize(window.size, Image.Resampling.LANCZOS)

        if not cfg.mock:
            generated = correct_drift(generated, window, ctx_w)
            if cfg.harmonize_seams and band:
                generated = harmonize_seam(generated, ctx_w - band, cfg.strip_width)

        if self._match_histogram:
            # Match colors to the unmasked context region.
            context = window.crop((0, 0, ctx_w, cfg.height))
            # Only adjust the newly painted area's window for stability.
            generated = histogram_match_strip(generated, context)

        if margin:
            generated = generated.crop((0, 0, cfg.window_width - margin, cfg.height))
        new_canvas, emitted, _paste_x = stitch_generated_window(
            canvas,
            generated,
            window_width=cfg.window_width - margin,
            strip_width=cfg.strip_width,
            overlap=cfg.overlap,
        )

        # First strip has no prior client pixels to feather over — send only
        # the newly painted region. Later strips include `overlap` px so the
        # browser can soft-cover the seam (server already blended the canvas).
        if self._strip_index == 0:
            left = max(0, emitted.width - cfg.strip_width)
            emitted = emitted.crop((left, 0, emitted.width, emitted.height))
            overlap_meta = 0
        else:
            overlap_meta = cfg.overlap

        # Keep a bounded rolling canvas so memory stays flat over hours.
        max_keep = cfg.window_width * 4
        if new_canvas.width > max_keep:
            new_canvas = new_canvas.crop(
                (new_canvas.width - max_keep, 0, new_canvas.width, new_canvas.height)
            )

        jpeg = self._encode_jpeg(emitted)
        strip = Strip(
            index=self._strip_index,
            width=emitted.width,
            height=emitted.height,
            overlap=overlap_meta,
            jpeg=jpeg,
            prompt=shown_prompt,
            scene=scene_meta,
        )

        with self._lock:
            self._canvas = new_canvas
            self._strip_index += 1

        return strip

    # ---- fresh-anchor scene changes ----
    def _anchor(self, prompt, negative, seed, shown_prompt, scene_meta) -> Strip:
        """Scene change by fresh anchor (see docs/BANDING.md):
        1) paint the new scene alone (fully masked inpaint == txt2img): the old horizon/bands/rows can't leak in;
        2) bridge: lay the new scene's left edge over the old right edge (crossfade over `overlap` px, the part
           clients already hold), then a partial-strength inpaint of the zone around it fuses the two;
        3) emit the result as normal strips (no extra GPU work for them); outpainting continues from the new scene."""
        import numpy as np

        cfg = self.config
        H, Wn, S, ov = cfg.height, cfg.window_width, cfg.strip_width, cfg.overlap
        with self._lock:
            old = self._canvas
        new = self.inpainter.generate(image=Image.new("RGB", (Wn, H), (128, 128, 128)), mask=Image.new("L", (Wn, H), 255),
                                      prompt=prompt, negative_prompt=negative, seed=seed + 4242)
        if new.size != (Wn, H):
            new = new.resize((Wn, H), Image.Resampling.LANCZOS)
        L = Wn - S * 3 // 2                       # old px in the bridge window (640 at 1024/256)
        win = np.zeros((H, Wn, 3), np.float32)
        win[:, :L] = np.asarray(old.crop((old.width - L, 0, old.width, H))).astype(np.float32)
        nw = np.asarray(new).astype(np.float32)
        # seam (crossfade) width: live admin setting, at most `overlap` (only pixels clients already hold get blended)
        sx = int(max(32, min(ov, int(getattr(cfg, "anchor_seam_px", ov) or ov))))
        w = np.linspace(0, 1, sx, dtype=np.float32)
        w = (w * w * (3 - 2 * w))[None, :, None]
        win[:, L - sx:L] = win[:, L - sx:L] * (1 - w) + nw[:, :sx] * w
        win[:, L:] = nw[:, sx:sx + Wn - L]
        z0, z1 = L - sx, min(Wn, L + int(getattr(cfg, "anchor_bridge_px", 128)))
        m = np.zeros((H, Wn), np.float32)
        m[:, z0:z1] = 1.0
        f = 24                                    # soft mask edges
        m[:, z0:z0 + f] *= np.linspace(0, 1, f)[None, :]
        m[:, z1 - f:z1] *= np.linspace(1, 0, f)[None, :]
        strength = float(getattr(cfg, "anchor_bridge_strength", 0.85))
        bridged = self.inpainter.generate(image=Image.fromarray(win.clip(0, 255).astype(np.uint8)),
                                          mask=Image.fromarray((m * 255).astype(np.uint8), mode="L"),
                                          prompt=prompt, negative_prompt=negative, seed=seed + 4243, strength=strength)
        if bridged.size != (Wn, H):
            bridged = bridged.resize((Wn, H), Image.Resampling.LANCZOS)
        bw = np.asarray(bridged).astype(np.float32)
        # keep the unmasked context pixels exact (the model round-trips them through the VAE)
        out = win * (1 - m[..., None]) + bw * m[..., None]
        added = S * 3                             # 3 strips: bridge window tail + more of the new scene
        tail = added - (Wn - L) - 0
        full = Image.new("RGB", (old.width + added, H))
        full.paste(old, (0, 0))
        full.paste(Image.fromarray(out[:, L - ov:].clip(0, 255).astype(np.uint8)), (old.width - ov, 0))
        x = old.width + (Wn - L)
        full.paste(new.crop((sx + Wn - L, 0, sx + Wn - L + tail, H)), (x, 0))
        n = added // S
        self._anchor_pending = [(full, old.width + S * (j + 1)) for j in range(n)]
        self._anchor_meta = (shown_prompt, scene_meta)
        self.last_band = 0
        return self._emit_pending()

    def _emit_pending(self) -> Strip:
        cfg = self.config
        full, right = self._anchor_pending.pop(0)
        shown_prompt, scene_meta = getattr(self, "_anchor_meta", (None, None))
        if self._strip_index > 0 and self._anchor_pending is not None:
            # keep the director's clock moving (holds/transitions count strips)
            try:
                self.director.frame_for(self._strip_index)
            except Exception:
                pass
        S, ov = cfg.strip_width, cfg.overlap
        emitted = full.crop((right - S - ov, 0, right, cfg.height))
        canvas = full.crop((0, 0, right, cfg.height))
        max_keep = cfg.window_width * 4
        if canvas.width > max_keep:
            canvas = canvas.crop((canvas.width - max_keep, 0, canvas.width, canvas.height))
        strip = Strip(index=self._strip_index, width=emitted.width, height=emitted.height, overlap=ov,
                      jpeg=self._encode_jpeg(emitted), prompt=shown_prompt, scene=scene_meta)
        with self._lock:
            self._canvas = canvas
            self._strip_index += 1
        self._scene_strips = getattr(self, "_scene_strips", 0) + 1
        return strip

    # ---- persistence ----
    def attach_store(self, store) -> None:
        """Restore from `store` if it has state, then save every new strip."""
        self.store = store
        from .lod import LodBuilder

        store.lod = LodBuilder(store, self.config.strip_width, self.config.height)
        state, canvas = store.load_state()
        if state:
            try:
                self.director.load_dict(state.get("director", {}))
                idx = int(state.get("strip_index", 0))
                # Viewers may have seen strips past the saved state (state is mirrored every ~30 s):
                # continue after the newest published strip, never re-emit or overwrite one.
                try:
                    top = store.mirror.latest_idx() if getattr(store, "mirror", None) else None
                    if top is not None and top + 1 > idx:
                        logger.info("Published strips reach %d; resuming at %d (state said %d)", top, top + 1, idx)
                        idx = top + 1
                except Exception:
                    logger.warning("latest strip lookup failed; using saved index")
                try:   # strip rows are batched (ROW_FLUSH_S): strips already on the local disk count as published too
                    local = max(store.load_meta(), default=None)
                    if local is not None and local + 1 > idx:
                        logger.info("Local strips reach %d; resuming at %d", local, local + 1)
                        idx = local + 1
                except Exception:
                    logger.warning("local strip index lookup failed")
                warm = min(self.buffer.history_limit, 64)  # older strips load lazily on pan
                keep = list(range(max(0, idx - warm), idx))
                meta = store.load_meta()
                if getattr(store, "mirror", None) and keep:
                    try:
                        meta.update(store.mirror.load_strip_rows(keep[0], keep[-1]))
                    except Exception:
                        pass
                strips = [st for st in (store.load_strip(i, meta.get(i)) for i in keep) if st]
                # Outpaint from the right edge of what was actually published, never a stale or
                # fresh canvas (that is a hard seam on every restart).
                rebuilt = rebuild_canvas(strips[-8:], self.config.overlap) if strips else None
                if rebuilt is not None and rebuilt.height == self.config.height and rebuilt.width >= self.config.context_width:
                    canvas = rebuilt

                with self._lock:
                    if canvas is not None:
                        self._canvas = canvas
                    self._strip_index = idx
                self.buffer.restore(strips, idx)
                self.restored_pos = state.get("timeline_pos")
                logger.info("Restored %d strips (index %d) from %s", len(strips), idx, store.dir)
            except Exception:
                logger.exception("State restore failed; starting fresh")

    def snapshot_state(self) -> dict:
        cfg = self.config
        return {"version": 1, "strip_index": self._strip_index, "director": self.director.to_dict(),
                "strip_width": cfg.strip_width, "overlap": cfg.overlap, "height": cfg.height,
                "timeline_pos": getattr(self, "timeline_pos", None), "saved_at": time.time()}

    def _persist(self, strip: Strip) -> None:
        store = getattr(self, "store", None)
        if store is None:
            return
        try:
            store.save_strip(strip)
            store.save_state(self.snapshot_state(), self.canvas, force=strip.index % 60 == 0)
        except Exception:
            logger.exception("Persisting strip %s failed", strip.index)

    def _persist_async(self, strip: Strip) -> None:
        """Upload/save on one ordered background worker so the next denoise starts immediately.
        State + canvas are snapshotted now so the saved state matches this strip."""
        store = getattr(self, "store", None)
        if store is None:
            return
        if getattr(self, "_persist_pool", None) is None:
            from concurrent.futures import ThreadPoolExecutor
            self._persist_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="persist")
            self._persist_backlog = 0
        state, canvas, force = self.snapshot_state(), self.canvas, strip.index % 60 == 0
        def job() -> None:
            try:
                store.save_strip(strip)
                store.save_state(state, canvas, force=force)
            except Exception:
                logger.exception("Persisting strip %s failed", strip.index)
            finally:
                self._persist_backlog -= 1
        self._persist_backlog += 1
        fut = self._persist_pool.submit(job)
        if self._persist_backlog > 6:   # uploads badly behind: wait, so memory can't grow unbounded
            logger.warning("persist backlog %s; waiting for uploads", self._persist_backlog)
            fut.result()

    def flush_persist(self, timeout: float = 30.0) -> None:
        pool = getattr(self, "_persist_pool", None)
        if pool is not None:
            pool.submit(lambda: None).result(timeout=timeout)
        mirror = getattr(getattr(self, "store", None), "mirror", None)
        if mirror is not None and hasattr(mirror, "flush_rows"):
            try:
                mirror.flush_rows()   # batched strip rows land before a restart
            except Exception:
                pass

    def _record_time(self, dt: float, pipe_s: float | None = None) -> None:
        a = self._ema_alpha
        self.gen_seconds_ema = dt if self.gen_seconds_ema is None else (1 - a) * self.gen_seconds_ema + a * dt
        if pipe_s is not None:   # time inside the diffusers pipeline (the rest is prompt/canvas/encode overhead)
            p = getattr(self, "pipe_seconds_ema", None)
            self.pipe_seconds_ema = pipe_s if p is None else (1 - a) * p + a * pipe_s

    def stats(self) -> dict:
        ema = self.gen_seconds_ema
        ema = max(ema, 1e-3) if ema is not None else None
        return {
            "strip_seconds": round(ema, 3) if ema else None,
            "pipe_seconds": round(self.pipe_seconds_ema, 3) if getattr(self, "pipe_seconds_ema", None) else None,
            "strips_per_sec": round(1.0 / ema, 3) if ema else None,
            "px_per_sec": round(self.config.strip_width / ema, 2) if ema else None,
            "strip_index": self._strip_index,
        }

    def _run(self) -> None:
        logger.info("Seeding buffer with initial strips…")
        try:
            while not self._stop.is_set():
                if not self.buffer.wait_until_needs_fill(timeout=0.5):
                    if self.buffer.closed or self._stop.is_set():
                        break
                    continue
                try:
                    t0 = time.monotonic()
                    if hasattr(self.inpainter, "pipe_seconds"):
                        self.inpainter.pipe_seconds = 0.0
                    strip = self.generate_one()
                    self._record_time(time.monotonic() - t0, getattr(self.inpainter, "pipe_seconds", None))
                except Exception:
                    logger.exception("Strip generation failed; retrying shortly")
                    if self._stop.wait(1.0):
                        break
                    continue
                ok = self.buffer.put(strip, block=True, timeout=2.0)
                if ok:
                    self._persist_async(strip)
                if not ok:
                    if self.buffer.closed or self._stop.is_set():
                        break
                    logger.warning("Buffer rejected strip %s", strip.index)
                else:
                    logger.debug(
                        "Produced strip %s (%dx%d), buffer=%s",
                        strip.index,
                        strip.width,
                        strip.height,
                        self.buffer.depth(),
                    )
        finally:
            logger.info("Generator loop exiting")


def rebuild_canvas(strips: list, overlap: int) -> Image.Image | None:
    """Reassemble the rolling canvas from consecutive published strips (each emitted strip
    repaints the previous canvas's last `overlap` px, then adds new pixels)."""
    import io as _io

    imgs = []
    prev = None
    for st in strips:
        if prev is not None and st.index != prev + 1:
            imgs = []  # gap: start again from here
        prev = st.index
        try:
            imgs.append((Image.open(_io.BytesIO(st.jpeg)).convert("RGB"), st.overlap))
        except Exception:
            imgs = []
    if not imgs:
        return None
    h = imgs[0][0].height
    out = imgs[0][0]
    for im, ov in imgs[1:]:
        if im.height != h:
            return None
        ov = ov or 0
        nw = out.width - ov + im.width
        c = Image.new("RGB", (nw, h))
        c.paste(out, (0, 0))
        c.paste(im, (out.width - ov, 0))
        out = c
    return out
