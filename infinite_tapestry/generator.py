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


# The panorama travels through one world: each strip gets a different framing so the
# model doesn't redraw the same focal subject (farmhouse, dog crowd) side by side.
PAN_CUES = [
    "The camera pans right to a different part of the same place, new foreground details, varied composition",
    "Further along: open space and depth, a different landmark of this world, the main subject smaller in the distance",
    "Panning on: close foreground elements of this world on the right, different arrangement, no repeated objects",
    "Continuing the journey: a new area of this world with different scale and layout, fresh details",
]


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
        # P(nsfw) classifier for generated pixels (GPU only; tests may inject one).
        self.nsfw = None
        self.nsfw_hits = 0
        self.on_flag = None  # callback(scene) when a scene's strip stays explicit after one repaint
        if not config.mock and getattr(config, "nsfw_model", ""):
            from .nsfw import load_classifier

            self.nsfw = load_classifier(config.nsfw_model, config.device)
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
        # Scene change: repaint most of the visible context (keep only a narrow seam
        # band) so the new idea isn't trapped inside the old composition.
        if band and prompt_b and not cfg.mock:
            band = max(band, int(ctx_w * getattr(cfg, "scene_change_repaint", 0.7)))
        self.last_band = band
        hide = int(getattr(cfg, "context_mask_px", 0) or 0)
        if hide and self._strip_index > 0 and not cfg.mock:
            # Show the model only the context next to the seam; masking the far-left context
            # stops it from copying whole objects it can see (klein in-context repetition).
            band = max(band, 0)
            import numpy as np

            m = np.asarray(mask).copy()
            m[:, :min(hide, ctx_w - band - 32)] = 255
            mask = Image.fromarray(m, mode="L")
        if band:
            import numpy as np

            m = np.asarray(mask).copy()
            m[:, ctx_w - band:] = 255
            mask = Image.fromarray(m, mode="L")
        # User ideas steer harder than Auto filler.
        if hasattr(self.inpainter, "guidance"):
            user_scene = (scene_meta or {}).get("origin") == "user"
            self.inpainter.guidance = cfg.guidance_scale + (getattr(cfg, "user_cfg_boost", 1.5) if user_scene else 0.0)
        from .guard import is_disallowed

        if is_disallowed(prompt_a):
            prompt_a = "abstract soft colored mist"
        if prompt_b and is_disallowed(prompt_b):
            prompt_b = None
        shown_prompt = prompt_b if (prompt_b and blend_t >= 0.5) else prompt_a
        from .styles import ramp, with_trigger

        style_a, style_b = self.director.styles_for(blend_t) if hasattr(self.director, "styles_for") else ("none", None)
        prompt_a = with_trigger(prompt_a, style_a)
        if prompt_b:
            prompt_b = with_trigger(prompt_b, style_b or style_a)
        if hasattr(self.inpainter, "set_styles"):
            self.inpainter.set_styles(ramp(style_a, style_b, blend_t if prompt_b else 0.0))
        seed = cfg.seed + self._strip_index
        if getattr(cfg, "pan_variations", False) and not cfg.mock:
            cue = PAN_CUES[self._strip_index % len(PAN_CUES)]
            prompt_a = f"{prompt_a}. {cue}"
            if prompt_b:
                prompt_b = f"{prompt_b}. {cue}"
        if hasattr(self.inpainter, "set_ref") and hasattr(self.director, "ref_ids"):
            from . import refs as _refs

            rid, rscale = _refs.schedule(*self.director.ref_ids(), blend_t if prompt_b else 0.0)
            self.inpainter.set_ref(rid, _refs.get(rid), rscale)
            if rid is None and getattr(cfg, "context_ref", False) and not cfg.mock and self._strip_index > 0:
                # Full-composition awareness: a downscaled view of what's on screen (last ~8 strips)
                # rides along as a klein reference image; the thin band still pins the seam.
                cw = min(canvas.width, cfg.strip_width * 8)
                view = canvas.crop((canvas.width - cw, 0, canvas.width, canvas.height))
                view = view.resize((max(64, cw * 384 // canvas.height // 16 * 16), 384), Image.Resampling.BILINEAR)
                self.inpainter.set_ref("ctx", view, 1.0)

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
        # Near-duplicate guard: the new strip must not be a copy of something already visible in
        # the context (klein can clone the crowd/objects it sees). Regenerate with a fresh seed.
        self.last_dup_score = 0.0
        if getattr(cfg, "dup_check", False) and self._strip_index > 0 and not cfg.mock:
            for k in range(int(getattr(cfg, "dup_retries", 2))):
                d = dup_score(generated, window, ctx_w, cfg.window_width - margin)
                self.last_dup_score = d
                if d < cfg.dup_threshold:
                    break
                logger.info("Strip %d repeats its context (dup %.2f); regenerating", self._strip_index, d)
                generated = self.inpainter.generate(
                    image=window, mask=mask, prompt=prompt_a, negative_prompt=self.director.negative_for(blend_t),
                    seed=seed + 31337 * (k + 1), prompt_b=prompt_b, t=blend_t)
        if self.nsfw is not None:
            new_region = generated.crop((max(0, ctx_w - band), 0, cfg.window_width - margin, cfg.height))
            p = self.nsfw(new_region)
            if getattr(cfg, "nsfw_log_min", 1.0) <= p < cfg.nsfw_threshold:
                self._nsfw_near(p, scene_meta)
            if p >= cfg.nsfw_threshold:
                self.nsfw_hits += 1
                logger.warning("Strip %d flagged NSFW (p=%.2f); regenerating", self._strip_index, p)
                retry = self.inpainter.generate(
                    image=window, mask=mask, prompt=prompt_a + ", everyone fully clothed",
                    negative_prompt=self.director.negative_for(blend_t) + ", nude, naked, sexual, nsfw, cleavage, bare skin",
                    seed=seed + 104729, prompt_b=prompt_b, t=blend_t,
                )
                if retry.size != window.size:
                    retry = retry.resize(window.size, Image.Resampling.LANCZOS)
                r_region = retry.crop((max(0, ctx_w - band), 0, cfg.window_width - margin, cfg.height))
                if self.nsfw(r_region) < cfg.nsfw_threshold:
                    generated = retry
                else:
                    # Still flagged: the flagged pixels never leave this function (no broadcast,
                    # no storage). Drop the scene, strike its source idea, repaint as Auto filler.
                    logger.warning("Strip %d still NSFW after retry; falling back to Auto", self._strip_index)
                    try:
                        if self.on_flag:
                            self.on_flag(self.director.flagged_scene() if hasattr(self.director, "flagged_scene") else scene_meta)
                    except Exception:
                        logger.exception("on_flag failed")
                    if hasattr(self.director, "drop_flagged"):
                        self.director.drop_flagged(self._strip_index)
                    safe = self.director.safe_prompt() if hasattr(self.director, "safe_prompt") else "cinematic photo, empty misty landscape"
                    generated = self.inpainter.generate(
                        image=window, mask=mask, prompt=safe,
                        negative_prompt=self.director.negative_for(0.0) + ", nude, naked, sexual, nsfw, people",
                        seed=seed + 7, prompt_b=None, t=0.0)
                    if generated.size != window.size:
                        generated = generated.resize(window.size, Image.Resampling.LANCZOS)
                    g_region = generated.crop((max(0, ctx_w - band), 0, cfg.window_width - margin, cfg.height))
                    if self.nsfw(g_region) >= cfg.nsfw_threshold:  # last resort: plain blur of the fallback
                        from .nsfw import obscure

                        generated = generated.copy()
                        generated.paste(obscure(g_region), (max(0, ctx_w - band), 0))
                    shown_prompt, scene_meta = safe, {"title": "Auto", "origin": "auto"}

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
            store.save_state(self.snapshot_state(), self.canvas, force=strip.index % 10 == 0)
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
        state, canvas, force = self.snapshot_state(), self.canvas, strip.index % 10 == 0
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

    def _record_time(self, dt: float) -> None:
        a = self._ema_alpha
        self.gen_seconds_ema = dt if self.gen_seconds_ema is None else (1 - a) * self.gen_seconds_ema + a * dt

    on_event = None  # set by main: OpsLog.event(type, **detail)

    def _nsfw_near(self, p: float, meta: object = None, kind: str = "strip") -> None:
        """Near-miss NSFW score (below the threshold, so the strip ships): log for threshold tuning."""
        try:
            if self.on_event:
                m = meta if isinstance(meta, dict) else {}
                self.on_event("nsfw_near", kind=kind, score=round(float(p), 3), threshold=self.config.nsfw_threshold,
                              strip=self._strip_index, title=str(m.get("title") or "")[:80], origin=m.get("origin"))
        except Exception:
            pass

    def stats(self) -> dict:
        ema = self.gen_seconds_ema
        ema = max(ema, 1e-3) if ema is not None else None
        return {
            "strip_seconds": round(ema, 3) if ema else None,
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
                    strip = self.generate_one()
                    self._record_time(time.monotonic() - t0)
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


def dup_score(generated: Image.Image, window: Image.Image, ctx_w: int, right: int) -> float:
    """Max normalised correlation between the newly painted strip and any same-width slice of the
    visible context (64 px steps), on small high-passed grayscale thumbnails. ~1.0 = cloned content."""
    import numpy as np

    def thumb(img):
        g = np.asarray(img.convert("L").resize((max(1, img.width // 16), max(1, img.height // 16)),
                                                Image.Resampling.BILINEAR), dtype=np.float32)
        return g
    w = right - ctx_w
    if w <= 0:
        return 0.0
    new = thumb(generated.crop((ctx_w, 0, right, generated.height)))
    new = new - new.mean(); nn = float(np.sqrt((new * new).sum())) or 1.0
    best = 0.0
    for x in range(0, ctx_w - w + 1, 64):
        old = thumb(window.crop((x, 0, x + w, window.height)))
        if old.shape != new.shape:
            continue
        old = old - old.mean(); on = float(np.sqrt((old * old).sum())) or 1.0
        best = max(best, float((new * old).sum() / (nn * on)))
    return best
