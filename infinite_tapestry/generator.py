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
    make_seed_image,
    stitch_generated_window,
)
from .prompts import PromptScheduler

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
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._canvas: Image.Image = make_seed_image(
            config.height, config.context_width, seed=config.seed
        )
        self._strip_index = 0
        self._match_histogram = True

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

        window, mask, _context_x = build_inpaint_inputs(
            canvas,
            window_width=cfg.window_width,
            strip_width=cfg.strip_width,
            height=cfg.height,
        )
        frame = self.scheduler.frame_for(self._strip_index)
        seed = cfg.seed + self._strip_index

        generated = self.inpainter.generate(
            image=window,
            mask=mask,
            prompt=frame.prompt,
            negative_prompt=frame.negative_prompt,
            seed=seed,
        )

        if generated.size != window.size:
            generated = generated.resize(window.size, Image.Resampling.LANCZOS)

        if self._match_histogram:
            # Match colors to the unmasked context region.
            context = window.crop((0, 0, cfg.context_width, cfg.height))
            # Only adjust the newly painted area's window for stability.
            generated = histogram_match_strip(generated, context)

        new_canvas, emitted, _paste_x = stitch_generated_window(
            canvas,
            generated,
            window_width=cfg.window_width,
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
            prompt=frame.prompt,
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
