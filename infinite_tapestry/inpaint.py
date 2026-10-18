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

            # (10ed92a pasted SDXL model-id logging here: it referenced undefined names and swapped the scheduler
            # even with LCM-LoRA, so every SD1.5 load - including the SDXL->SD1.5 fallback - raised NameError.)
            logger.info("No LCM-LoRA: using DPM++ 2M Karras")
            pipe.scheduler = DPMSolverMultistepScheduler.from_config(
                pipe.scheduler.config,
                use_karras_sigmas=True,
                algorithm_type="dpmsolver++",
                solver_type="midpoint",
            )
        self.model_id = self.config.inpaint_model
        logger.info("SD1.5 inpaint model loaded: %s", self.model_id)

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
        strength: float | None = None,
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
            strength=self.config.strength if strength is None else float(strength),
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
            from .config import SDXL_PRESET, Config
            fallback = Config()
            # Undo every SDXL preset key (incl. fresh_anchor, whose partial-strength bridge pass is SDXL-tuned).
            for k in set(SDXL_PRESET) | {"height", "window_width", "strip_width", "overlap", "repaint_band", "steps",
                                         "guidance_scale", "seam_retries", "scroll_speed", "scroll_speed_min"}:
                setattr(config, k, getattr(fallback, k))
            config.context_width = config.window_width - config.strip_width
            config.backend = "sd15"
    return DiffusersInpainter(config)


class SDXLInpainter(Inpainter):
    """SDXL inpainting (fp16, DPM++ 2M Karras, SDPA) with style LoRAs ramped per strip."""

    def __init__(self, config: "Config") -> None:
        import torch
        from diffusers import DPMSolverMultistepScheduler

        from .sdxl_merge import load_pipeline

        self.config = config
        self._torch = torch
        logger.info("Loading SDXL inpaint model %s …", config.sdxl_model)
        self.model_id = config.sdxl_model
        try:
            pipe = load_pipeline(config.sdxl_model, torch.float16)
        except Exception as e:
            fb = getattr(config, "sdxl_fallback_model", "")
            if not fb or fb == config.sdxl_model:
                raise
            logger.warning("SDXL model %s failed (%s); falling back to %s", config.sdxl_model, str(e)[:160], fb)
            pipe = load_pipeline(fb, torch.float16)
            self.model_id = fb
        logger.warning("SDXL inpaint model loaded: %s (unet in_channels=%s)", self.model_id, pipe.unet.config.in_channels)
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
        # CFG truncation drops the unconditional half of the batch mid-run; the IP-Adapter image embeds are built
        # for the doubled batch before the loop, so trim them to the UNet's actual batch.
        pipe.unet.register_forward_pre_hook(ip_embeds_match_batch, with_kwargs=True)
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

    def generate(self, image, mask, prompt, negative_prompt="", seed=None, prompt_b=None, t=0.0, strength=None):
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
        if strength is None or strength >= 0.95:   # partial-strength passes keep the given pixels as the start
            image = prefill_masked(image, mask, mode=getattr(self.config, "prefill_mode", "ramp"),
                                   ramp_px=int(getattr(self.config, "prefill_ramp_px", 96)))
        ip_kw = {}
        if self._ip:
            self._pipe.set_ip_adapter_scale(self._ref_scale)
            ip_kw["ip_adapter_image_embeds"] = self._ref_embeds.get(self._ref_id, self._blank) if self._ref_scale > 0 else self._blank
        cut = float(getattr(self.config, "cfg_cut", 1.0) or 1.0)
        if 0.0 < cut < 1.0 and self.guidance > 1.0:
            ip_kw["callback_on_step_end"] = cfg_cut_callback(cut)
            ip_kw["callback_on_step_end_tensor_inputs"] = list(CFG_BATCHED)
        out = self._pipe(
            prompt_embeds=pe, negative_prompt_embeds=ne, pooled_prompt_embeds=pp, negative_pooled_prompt_embeds=npp,
            image=image.convert("RGB"), mask_image=mask.convert("L"),
            num_inference_steps=self.config.steps, guidance_scale=self.guidance,
            width=image.width, height=image.height, generator=gen, strength=0.999 if strength is None else float(strength),
            **ip_kw,
        )
        return out.images[0]


# Loop tensors the SDXL inpaint pipeline concatenates as [uncond, cond] for classifier-free guidance.
CFG_BATCHED = ("prompt_embeds", "add_text_embeds", "add_time_ids", "mask", "masked_image_latents")


def cfg_cut_callback(cut: float):
    """callback_on_step_end that switches CFG off after round(cut * steps) steps: guidance_scale -> 0 (the pipeline
    then stops doubling the latents) and every [uncond, cond] loop tensor is cut to its cond half."""
    def cb(pipe, i, t, kw):
        n = int(getattr(pipe, "_num_timesteps", 0) or 0)
        stop = max(1, int(round(n * cut)))
        if i + 1 != stop or getattr(pipe, "_guidance_scale", 0) <= 1.0 or stop >= n:
            return {}
        pipe._guidance_scale = 0.0
        out = {}
        for k in CFG_BATCHED:
            v = kw.get(k)
            if v is not None and v.shape[0] >= 2 and v.shape[0] % 2 == 0:
                out[k] = v.chunk(2)[1]
        return out
    return cb


def ip_embeds_match_batch(module, args, kwargs):
    """UNet forward pre-hook: keep only the cond half of IP-Adapter image embeds when the batch is no longer doubled."""
    ack = kwargs.get("added_cond_kwargs")
    if not ack or "image_embeds" not in ack:
        return None
    sample = args[0] if args else kwargs.get("sample")
    emb = ack["image_embeds"]
    if sample is None or not isinstance(emb, (list, tuple)) or not emb:
        return None
    n = sample.shape[0]
    if all(e.shape[0] <= n for e in emb):
        return None
    kwargs["added_cond_kwargs"] = {**ack, "image_embeds": [e[-n:] if e.shape[0] > n else e for e in emb]}
    return args, kwargs


def prefill_masked(image: Image.Image, mask: Image.Image, seed: int = 0, mode: str = "ramp", ramp_px: int = 96) -> Image.Image:
    """SDXL-inpaint keeps some of what's under the mask (strength 0.999), so the fill seeds the composition.

    ROOT CAUSE of the 'stuck in horizontal bands' look (overnight 2026-10-14): the old fill repeated each row's
    seam colour across the whole masked area -- literal horizontal stripes -- so every strip (and a takeover
    repainting ~670 px) started from stripes and painted banners, strata and rows of people into them.
    'ramp' (experimental, not shipped) = 'meannoise' plus a short per-row gradient from the real edge (prefill_ramp_px) for the seam.
    'gray' fills with mid-gray plus isotropic noise: no row structure and no palette inheritance.
    'meannoise' (default, v1.0) uses the context's mean colour + N(0,40) noise: no stripes; fresh anchors at scene
    changes stop the palette locking in.
    'rowmean' keeps the old behaviour (test only)."""
    import numpy as np

    a = np.asarray(image.convert("RGB")).astype(np.float32)
    m = np.asarray(mask.convert("L")) > 127
    cols = np.where(~m.all(axis=0))[0]
    if not m.any():
        return image
    rng = np.random.default_rng(seed)
    if cols.size == 0:   # fully masked (fresh anchor = txt2img): noise, not a flat gray card (flat gray patches)
        out = 128.0 + rng.normal(0, 50, a.shape).astype(np.float32)
        return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), mode="RGB")
    if mode == "rowmean":
        x_edge = int(cols.max()) + 1
        ref = a[:, max(0, x_edge - 48):x_edge].mean(axis=1, keepdims=True)
        fill = np.repeat(ref, a.shape[1], axis=1) + rng.normal(0, 28, a.shape).astype(np.float32)
    elif mode in ("ramp", "meannoise"):
        ref = a[~m].reshape(-1, 3).mean(axis=0)
        fill = ref[None, None, :] + rng.normal(0, 40, a.shape).astype(np.float32)
        if mode == "ramp" and ramp_px > 0:
            # Seam blend: a SHORT per-row gradient from the real edge colours into the noise (ramp_px only),
            # so the new strip grows out of the context without a row pattern spanning the strip.
            xe = int(cols.max()) + 1
            n = min(ramp_px, a.shape[1] - xe)
            if n > 0:
                edge = a[:, max(0, xe - 8):xe].mean(axis=1)
                w = ((1 - np.linspace(0, 1, n, dtype=np.float32)) ** 1.5)[None, :, None]
                fill[:, xe:xe + n] = edge[:, None, :] * w + fill[:, xe:xe + n] * (1 - w)
    else:  # "gray": context-independent mid-gray + isotropic noise (no row structure, no palette lock-in)
        fill = 128.0 + rng.normal(0, 50, a.shape).astype(np.float32)
    out = np.where(m[..., None], fill, a)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), mode="RGB")
