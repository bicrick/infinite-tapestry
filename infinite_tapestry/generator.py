"""Background strip generator with rolling canvas and prompt drift."""

from __future__ import annotations

import io
import logging
import threading
from typing import TYPE_CHECKING

from PIL import Image

from .buffer import Strip, StripBuffer
from .canvas import (
    build_inpaint_inputs,
    histogram_match_strip,
    correct_drift,
    make_seed_image,
    stitch_generated_window,
)
from .prompts import LiveDirector, PromptScheduler

if TYPE_CHECKING:
    from .config import Config
    from .inpaint import Inpainter

logger = logging.getLogger(__name__)


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
        logger.info("Generator thread stopped")

    def _encode_jpeg(self, image: Image.Image) -> bytes:
        buf = io.BytesIO()
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
        prompt_a, prompt_b, blend_t = self.director.frame_for(self._strip_index)
        shown_prompt = prompt_b if (prompt_b and blend_t >= 0.5) else prompt_a
        seed = cfg.seed + self._strip_index

        generated = self.inpainter.generate(
            image=window,
            mask=mask,
            prompt=prompt_a,
            negative_prompt=self.director.negative_prompt,
            seed=seed,
            prompt_b=prompt_b,
            t=blend_t,
        )

        if generated.size != window.size:
            generated = generated.resize(window.size, Image.Resampling.LANCZOS)

        if not cfg.mock:
            generated = correct_drift(generated, window, ctx_w)

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
        )

        with self._lock:
            self._canvas = new_canvas
            self._strip_index += 1

        return strip

    def _run(self) -> None:
        logger.info("Seeding buffer with initial strips…")
        try:
            while not self._stop.is_set():
                if not self.buffer.wait_until_needs_fill(timeout=0.5):
                    if self.buffer.closed or self._stop.is_set():
                        break
                    continue
                try:
                    strip = self.generate_one()
                except Exception:
                    logger.exception("Strip generation failed; retrying shortly")
                    if self._stop.wait(1.0):
                        break
                    continue
                ok = self.buffer.put(strip, block=True, timeout=2.0)
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
