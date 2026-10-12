"""GPU inpainting backend (SD1.5 inpaint + LCM-LoRA + TAESD)."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from PIL import Image

if TYPE_CHECKING:
    from .config import Config

logger = logging.getLogger(__name__)


class Inpainter:
    """Protocol-ish base for strip generation backends."""

    def generate(
        self,
        image: Image.Image,
        mask: Image.Image,
        prompt: str,
        negative_prompt: str = "",
        seed: int | None = None,
        prompt_b: str | None = None,
        t: float = 0.0,
    ) -> Image.Image:
        raise NotImplementedError


class DiffusersInpainter(Inpainter):
    """Stable Diffusion 1.5 inpainting with LCM-LoRA and TAESD decode."""

    def __init__(self, config: "Config") -> None:
        self.config = config
        self._pipe: Any = None
        self._load()

    def _load(self) -> None:
        import torch
        from diffusers import (
            AutoencoderTiny,
            DiffusionPipeline,
            LCMScheduler,
        )

        dtype = torch.float16 if self.config.dtype == "float16" else torch.float32
        device = self.config.device
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError(
                "CUDA requested but not available. Use --mock for CPU testing, "
                "or pass --device cpu (slow)."
            )

        logger.info("Loading inpaint model %s …", self.config.inpaint_model)
        # StableDiffusionInpaintPipeline is the right class; AutoPipeline also works.
        try:
            from diffusers import StableDiffusionInpaintPipeline

            pipe = StableDiffusionInpaintPipeline.from_pretrained(
                self.config.inpaint_model,
                torch_dtype=dtype,
                safety_checker=None,
                requires_safety_checker=False,
            )
        except Exception:
            logger.warning("Falling back to DiffusionPipeline for inpaint model")
            pipe = DiffusionPipeline.from_pretrained(
                self.config.inpaint_model,
                torch_dtype=dtype,
                safety_checker=None,
            )

        if self.config.lcm_lora:
            logger.info("Loading LCM-LoRA %s …", self.config.lcm_lora)
            pipe.load_lora_weights(self.config.lcm_lora)
            pipe.fuse_lora()
            pipe.scheduler = LCMScheduler.from_config(pipe.scheduler.config)
        else:
            from diffusers import DPMSolverMultistepScheduler

            logger.info("No LCM-LoRA: using DPM++ 2M Karras")
            pipe.scheduler = DPMSolverMultistepScheduler.from_config(
                pipe.scheduler.config,
                use_karras_sigmas=True,
                algorithm_type="dpmsolver++",
                solver_type="midpoint",
            )

        if self.config.taesd_model:
            logger.info("Loading TAESD %s …", self.config.taesd_model)
            pipe.vae = AutoencoderTiny.from_pretrained(
                self.config.taesd_model, torch_dtype=dtype
            )

        pipe.to(device)
        if device == "cuda":
            try:
                pipe.enable_attention_slicing()
            except Exception:
                pass
            try:
                # Helps on 12GB cards when multiple clients connect.
                pipe.enable_vae_slicing()
            except Exception:
                pass

        self._pipe = pipe
        self._torch = torch
        logger.info("Inpaint pipeline ready on %s", device)

    def generate(
        self,
        image: Image.Image,
        mask: Image.Image,
        prompt: str,
        negative_prompt: str = "",
        seed: int | None = None,
        prompt_b: str | None = None,
        t: float = 0.0,
    ) -> Image.Image:
        torch = self._torch
        generator = None
        if seed is not None:
            generator = torch.Generator(device=self.config.device).manual_seed(seed)

        do_cfg = self.config.guidance_scale > 1.0
        dev = self.config.device
        with torch.no_grad():
            pe, ne = self._pipe.encode_prompt(
                prompt, dev, 1, do_cfg, negative_prompt or None
            )
            if prompt_b and t > 0.0:
                pe_b, _ = self._pipe.encode_prompt(
                    prompt_b, dev, 1, do_cfg, negative_prompt or None
                )
                tt = float(min(1.0, max(0.0, t)))
                pe = pe * (1.0 - tt) + pe_b * tt

        result = self._pipe(
            prompt_embeds=pe,
            negative_prompt_embeds=ne if do_cfg else None,
            image=image.convert("RGB"),
            mask_image=mask.convert("L"),
            num_inference_steps=self.config.steps,
            guidance_scale=self.config.guidance_scale,
            width=image.width,
            height=image.height,
            generator=generator,
            strength=self.config.strength,
        )
        return result.images[0]


def create_inpainter(config: "Config") -> Inpainter:
    if config.mock:
        from .mock_inpaint import MockInpainter

        return MockInpainter(config)
    return DiffusersInpainter(config)
