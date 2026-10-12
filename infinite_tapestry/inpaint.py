import os
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
    if getattr(config, "backend", "sd15") == "klein":
        try:
            return KleinInpainter(config)
        except Exception:
            logger.exception("klein backend failed to load; falling back to SDXL")
            from .config import SDXL_PRESET
            for k, v in SDXL_PRESET.items():
                setattr(config, k, v)
            config.context_width = config.window_width - config.strip_width
            config.backend = "sdxl"
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
        try:
            pipe = AutoPipelineForInpainting.from_pretrained(config.sdxl_model, torch_dtype=torch.float16, variant="fp16")
        except Exception as e:
            fb = getattr(config, "sdxl_fallback_model", "")
            if not fb or fb == config.sdxl_model:
                raise
            logger.warning("SDXL model %s failed (%s); falling back to %s", config.sdxl_model, str(e)[:160], fb)
            pipe = AutoPipelineForInpainting.from_pretrained(fb, torch_dtype=torch.float16, variant="fp16")
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
        self._ip = False
        self.guidance = config.guidance_scale
        self._ref_id, self._ref_scale, self._ref_embeds = None, 0.0, {}
        if getattr(config, "ip_adapter", True):
            self._load_ip_adapter()
        logger.info("SDXL inpaint ready (styles: %s)", ", ".join(self.loaded) or "none")

    def _load_ip_adapter(self) -> None:
        """IP-Adapter (ViT-H SDXL) for image ideas. Optional: failures leave text-only rendering."""
        try:
            from transformers import CLIPVisionModelWithProjection

            enc = CLIPVisionModelWithProjection.from_pretrained(
                "h94/IP-Adapter", subfolder="models/image_encoder", torch_dtype=self._torch.float16).to(self.config.device)
            self._pipe.image_encoder = enc
            self._pipe.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models",
                                       weight_name="ip-adapter_sdxl_vit-h.safetensors", image_encoder_folder=None)
            from transformers import CLIPImageProcessor
            if getattr(self._pipe, "feature_extractor", None) is None:
                self._pipe.feature_extractor = CLIPImageProcessor()
            self._pipe.set_ip_adapter_scale(0.0)
            self._blank = self._embed(Image.new("RGB", (224, 224), (127, 127, 127)))
            self._ip = True
            logger.info("IP-Adapter ready (image ideas)")
        except Exception as e:
            logger.warning("IP-Adapter unavailable: %s", str(e)[:200])

    def _embed(self, img):
        with self._torch.no_grad():
            return self._pipe.prepare_ip_adapter_image_embeds(
                ip_adapter_image=[img], ip_adapter_image_embeds=None, device=self.config.device,
                num_images_per_prompt=1, do_classifier_free_guidance=True)

    def set_ref(self, ref_id, image, scale: float) -> None:
        if not self._ip:
            return
        if image is None or scale <= 0.01:
            self._ref_id, self._ref_scale = None, 0.0
            return
        if ref_id not in self._ref_embeds:
            if len(self._ref_embeds) > 16:
                self._ref_embeds.clear()
            self._ref_embeds[ref_id] = self._embed(image)
        self._ref_id, self._ref_scale = ref_id, float(scale)

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
        ip_kw = {}
        if self._ip:
            self._pipe.set_ip_adapter_scale(self._ref_scale)
            ip_kw["ip_adapter_image_embeds"] = self._ref_embeds.get(self._ref_id, self._blank) if self._ref_scale > 0 else self._blank
        out = self._pipe(
            prompt_embeds=pe, negative_prompt_embeds=ne, pooled_prompt_embeds=pp, negative_pooled_prompt_embeds=npp,
            image=image.convert("RGB"), mask_image=mask.convert("L"),
            num_inference_steps=self.config.steps, guidance_scale=self.guidance,
            width=image.width, height=image.height, generator=gen, strength=0.999,
            **ip_kw,
        )
        return out.images[0]


class KleinInpainter(Inpainter):
    """FLUX.2 [klein] 4B (Apache-2.0) inpainting: 4-step distilled, bf16, natural-language prompts.

    No negative prompt / CFG (distilled, guidance 1.0); SDXL style LoRAs don't apply (style comes from
    the prompt text). Reference images use klein's native image_reference conditioning.
    Fallback: TAPESTRY_BACKEND=sdxl + restart."""

    MODEL = "black-forest-labs/FLUX.2-klein-4B"

    def __init__(self, config: "Config") -> None:
        import torch
        from diffusers import Flux2KleinInpaintPipeline

        self.config = config
        self._torch = torch
        logger.info("Loading FLUX.2 klein inpaint model %s …", self.MODEL)
        pipe = Flux2KleinInpaintPipeline.from_pretrained(self.MODEL, torch_dtype=torch.bfloat16)
        pipe.to(config.device)  # text encoder stays resident (fits in 24 GB with SDXL unloaded)
        pipe.set_progress_bar_config(disable=True)
        if os.environ.get("TAPESTRY_KLEIN_COMPILE", "1") == "1":
            # ~30% faster per step on a 4090 (bakeoff blend4: 3 steps + compile ~2.1 s/strip vs 3.2 s).
            # First strip (and first strip of a new shape, e.g. an image idea) pays the compile.
            pipe.transformer = torch.compile(pipe.transformer, mode="max-autotune-no-cudagraphs", dynamic=False)
        self._pipe = pipe
        self.guidance = 1.0
        self.loaded: list[str] = []
        self._enc: dict[str, object] = {}
        self._ref_id, self._ref_img, self._ref_scale = None, None, 0.0
        logger.info("klein inpaint ready")

    def set_styles(self, weights) -> None:  # LoRAs are SDXL-only; styles ride in the prompt text
        pass

    def set_ref(self, ref_id, image, scale: float) -> None:
        if image is None or scale <= 0.01:
            self._ref_id, self._ref_img, self._ref_scale = None, None, 0.0
            return
        self._ref_id, self._ref_img, self._ref_scale = ref_id, image.convert("RGB"), float(scale)

    def _embed(self, prompt: str):
        e = self._enc.get(prompt)
        if e is None:
            with self._torch.no_grad():
                out = self._pipe.encode_prompt(prompt, device=self.config.device)
            e = out[0] if isinstance(out, tuple) else out
            if len(self._enc) > 32:
                self._enc.clear()
            self._enc[prompt] = e
        return e

    def generate(self, image, mask, prompt, negative_prompt="", seed=None, prompt_b=None, t=0.0):
        torch = self._torch
        dev = self.config.device
        if negative_prompt and "nude" in negative_prompt and "clothed" not in prompt:
            prompt = prompt + ", everyone fully clothed, safe for work"
        pe = self._embed(prompt)
        if prompt_b and t > 0.0:
            pe_b = self._embed(prompt_b)
            # Averaged text embeddings render as haze (neither world); switch cleanly and let the
            # spatial outpaint carry the transition.
            if getattr(self.config, "klein_blend", "snap") == "slerp" and pe_b.shape == pe.shape:
                pe = slerp(pe, pe_b, float(min(1.0, max(0.0, t))))
            elif t >= 0.5:
                pe = pe_b
        gen = torch.Generator(device=dev).manual_seed(seed) if seed is not None else None
        filled = prefill_masked(image, mask)
        kw = {}
        if self._ref_img is not None and self._ref_scale >= 0.3:
            kw["image_reference"] = self._ref_img
        with torch.no_grad():
            out = self._pipe(prompt_embeds=pe, image=filled.convert("RGB"), mask_image=mask.convert("L"),
                             num_inference_steps=self.config.steps, guidance_scale=1.0, strength=1.0,
                             width=image.width, height=image.height, generator=gen, **kw).images[0]
        return feather_composite(image, out, mask, int(getattr(self.config, "seam_feather", 48)))


def slerp(a, b, t: float):
    """Per-token spherical interpolation that keeps embedding norms (plain lerp washes out)."""
    import torch

    an, bn = a.norm(dim=-1, keepdim=True), b.norm(dim=-1, keepdim=True)
    au, bu = a / an.clamp_min(1e-6), b / bn.clamp_min(1e-6)
    dot = (au * bu).sum(-1, keepdim=True).clamp(-0.9995, 0.9995)
    om = torch.acos(dot)
    so = torch.sin(om)
    u = (torch.sin((1 - t) * om) / so) * au + (torch.sin(t * om) / so) * bu
    return u * (an * (1 - t) + bn * t)


def feather_composite(orig: Image.Image, gen: Image.Image, mask: Image.Image, feather: int) -> Image.Image:
    """Blend the generated image back over the untouched context with a soft ramp that starts at the
    mask edge, so the hand-off from kept pixels to new pixels has no hard line."""
    import numpy as np

    if gen.size != orig.size:
        gen = gen.resize(orig.size, Image.Resampling.LANCZOS)
    m = np.asarray(mask.convert("L")) > 127
    cols = np.where(m.all(axis=0))[0]
    if feather <= 0 or cols.size == 0:
        return gen
    x0 = int(cols.min())
    w = orig.width
    ramp = np.zeros(w, np.float32)
    ramp[x0:] = 1.0
    ramp[x0:min(w, x0 + feather)] = np.linspace(0.0, 1.0, min(w, x0 + feather) - x0, dtype=np.float32)
    a = ramp[None, :, None]
    o = np.asarray(orig.convert("RGB")).astype(np.float32)
    g = np.asarray(gen.convert("RGB")).astype(np.float32)
    return Image.fromarray(np.clip(o * (1 - a) + g * a, 0, 255).astype(np.uint8), mode="RGB")


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
