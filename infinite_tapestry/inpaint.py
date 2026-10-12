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
    if getattr(config, "backend", "sd15") == "sdxl":
        try:
            return SDXLInpainter(config)
        except Exception:
            logger.exception("SDXL backend failed to load; falling back to SD1.5")
            from .config import Config
            fallback = Config()
            for k in ("height", "window_width", "strip_width", "overlap", "repaint_band", "steps", "guidance_scale",
                      "seam_retries", "scroll_speed", "scroll_speed_min"):
                setattr(config, k, getattr(fallback, k))
            config.context_width = config.window_width - config.strip_width
            config.backend = "sd15"
    return DiffusersInpainter(config)


class SDXLInpainter(Inpainter):
    """SDXL inpainting (fp16, DPM++ 2M Karras, SDPA) with style LoRAs ramped per strip."""

    def __init__(self, config: "Config") -> None:
        import torch
        from diffusers import AutoPipelineForInpainting, DPMSolverMultistepScheduler

        self.config = config
        self._torch = torch
        logger.info("Loading SDXL inpaint model %s …", config.sdxl_model)
        pipe = AutoPipelineForInpainting.from_pretrained(config.sdxl_model, torch_dtype=torch.float16, variant="fp16")
        pipe.scheduler = DPMSolverMultistepScheduler.from_config(
            pipe.scheduler.config, use_karras_sigmas=True, algorithm_type="dpmsolver++")
        # The stock SDXL VAE overflows in fp16; use the fp16-fixed one.
        try:
            from diffusers import AutoencoderKL
            pipe.vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
        except Exception:
            logger.warning("fp16-fix VAE unavailable; upcasting VAE")
        pipe.to(config.device)
        try:
            pipe.unet.set_attn_processor(__import__("diffusers.models.attention_processor", fromlist=["AttnProcessor2_0"]).AttnProcessor2_0())
        except Exception:
            pass
        self._pipe = pipe
        self.loaded: list[str] = []
        self._weights: dict[str, float] = {}
        self._active: tuple = ()
        if config.style_loras:
            self._load_styles()
        logger.info("SDXL inpaint ready (styles: %s)", ", ".join(self.loaded) or "none")

    @staticmethod
    def _adapter(name: str) -> str:
        return name.replace(" ", "_")

    def _load_styles(self) -> None:
        from .styles import STYLES

        for name, st in STYLES.items():
            if not st["lora"]:
                continue
            repo, fname = st["lora"]
            try:
                kw = {"weight_name": fname} if fname else {}
                self._pipe.load_lora_weights(repo, adapter_name=self._adapter(name), **kw)
                self.loaded.append(name)
            except Exception as e:  # missing repo/file or incompatible keys
                logger.warning("Style LoRA %s unavailable: %s", name, str(e)[:160])
        if self.loaded:
            self._pipe.disable_lora()

    def set_styles(self, weights: dict[str, float]) -> None:
        self._weights = {k: v for k, v in weights.items() if k in self.loaded}

    def _apply_styles(self) -> None:
        key = tuple(sorted(self._weights.items()))
        if key == self._active:
            return
        self._active = key
        if not self._weights:
            self._pipe.disable_lora()
            return
        self._pipe.enable_lora()
        self._pipe.set_adapters([self._adapter(k) for k in self._weights], list(self._weights.values()))

    def generate(self, image, mask, prompt, negative_prompt="", seed=None, prompt_b=None, t=0.0):
        torch = self._torch
        gen = torch.Generator(device=self.config.device).manual_seed(seed) if seed is not None else None
        self._apply_styles()
        dev = self.config.device
        with torch.no_grad():
            pe, ne, pp, npp = self._pipe.encode_prompt(prompt, device=dev, num_images_per_prompt=1,
                                                       do_classifier_free_guidance=True, negative_prompt=negative_prompt or None)
            if prompt_b and t > 0.0:
                pe_b, _, pp_b, _ = self._pipe.encode_prompt(prompt_b, device=dev, num_images_per_prompt=1,
                                                            do_classifier_free_guidance=True, negative_prompt=negative_prompt or None)
                tt = float(min(1.0, max(0.0, t)))
                tt = tt * tt * (3 - 2 * tt)          # smoothstep: gentle start and landing
                pe = pe * (1 - tt) + pe_b * tt
                pp = pp * (1 - tt) + pp_b * tt
        image = prefill_masked(image, mask)
        out = self._pipe(
            prompt_embeds=pe, negative_prompt_embeds=ne, pooled_prompt_embeds=pp, negative_pooled_prompt_embeds=npp,
            image=image.convert("RGB"), mask_image=mask.convert("L"),
            num_inference_steps=self.config.steps, guidance_scale=self.config.guidance_scale,
            width=image.width, height=image.height, generator=gen, strength=0.999,
        )
        return out.images[0]


def prefill_masked(image: Image.Image, mask: Image.Image, seed: int = 0) -> Image.Image:
    """SDXL-inpaint keeps some of what's under the mask (strength < 1), so a black hole paints dark.
    Fill the masked area with the context's per-row colour plus soft noise instead."""
    import numpy as np

    a = np.asarray(image.convert("RGB")).astype(np.float32)
    m = np.asarray(mask.convert("L")) > 127
    cols = np.where(~m.all(axis=0))[0]
    if not m.any() or cols.size == 0:
        return image
    x_edge = int(cols.max()) + 1                       # first fully-masked column (masks are right-side)
    ref = a[:, max(0, x_edge - 48):x_edge].mean(axis=1, keepdims=True)  # per-row colour
    rng = np.random.default_rng(seed)
    noise = rng.normal(0, 28, a.shape).astype(np.float32)
    fill = np.repeat(ref, a.shape[1], axis=1) + noise
    out = np.where(m[..., None], fill, a)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), mode="RGB")
