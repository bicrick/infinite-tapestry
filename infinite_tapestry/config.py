"""Runtime configuration for Infinite Tapestry."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Config:
    """All tunables for generation, buffering, and the client."""

    # Canvas / strip geometry
    height: int = 512
    window_width: int = 512
    strip_width: int = 128
    overlap: int = 96  # feather blend into prior context (smoothstep)
    seam_retries: int = 2  # regenerate a strip that shows a hard vertical cut
    seam_threshold: float = 12.0  # real cuts score 20+; shelves/pillars stay below ~10
    repaint_band: int = 64  # px of context the model repaints at the seam
    context_width: int = 384  # window_width - strip_width

    # Buffer / scroll
    buffer_target: int = 6  # strips to keep ahead
    buffer_min: int = 2  # below this, client should slow down
    blend_strips: int = 8  # strips to interpolate between prompts
    history_limit: int = 600  # strips kept in memory; older ones are read from disk
    scroll_speed: float = 30.0  # px/s (nominal)
    scroll_speed_min: float = 8.0  # when buffer is low

    # Generation
    mock: bool = False
    seed: int = 42
    steps: int = 20
    guidance_scale: float = 5.0  # DPM++ default; use ~1.0-1.5 with LCM-LoRA
    strength: float = 1.0  # <1.0 truncates the LCM schedule; masked area stays black

    # Model IDs (community mirrors; runwayml inpaint repo is gone)
    inpaint_model: str = "Lykon/dreamshaper-8-inpainting"  # base SD1.5-inpaint + LCM blew out colors
    # LCM-LoRA + TAESD is ~3x faster but smeared/seamed badly in testing;
    # opt in with --lcm-lora latent-consistency/lcm-lora-sdv1-5 --taesd-model madebyollin/taesd
    lcm_lora: str = ""
    # Backend: "sd15" (default, cheap GPUs) or "sdxl" (24 GB-class GPUs; see SDXL_PRESET)
    backend: str = "sd15"
    sdxl_model: str = "OzzyGT/RealVisXL_V4.0_inpainting"  # photoreal SDXL inpaint (9-ch UNet, fp16)
    sdxl_fallback_model: str = "diffusers/stable-diffusion-xl-1.0-inpainting-0.1"
    style_loras: bool = True  # SDXL only: load style LoRAs (styles.py) and ramp them across transitions
    harmonize_seams: bool = True  # remove colour steps at the mask edge
    taesd_model: str = ""
    dtype: str = "float16"
    device: str = "cuda"

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    jpeg_quality: int = 85

    # Prompt schedule: (cumulative_strips_at_which_prompt_starts, prompt)
    # Prompt drifts between consecutive entries based on strip index.
    # One generic seed scene; Claude's autopilot takes it from there.
    prompts: list[tuple[int, str]] = field(
        default_factory=lambda: [
            (0, "a strange softly lit dreamlike place, drifting shapes and quiet colors, highly detailed painting"),
        ]
    )
    autopilot: bool = True
    nsfw_model: str = "Falconsai/nsfw_image_detection"  # empty = off
    nsfw_threshold: float = 0.6
    negative_prompt: str = (
        "blurry, low quality, distorted, watermark, text, frame, border, "
        "ugly, duplicate, collage, split screen, diptych, panel, seam, "
        "multiple horizons, stacked landscapes, layered strata, split levels, "
        "horizontal bands, stripes, panorama panels, comic strip panels, "
        "triptych, multi-panel, stacked scenes, cutaway layers, "
        "nsfw, nude, naked, nudity, sexual, nipples, cleavage, erotic"
    )

    def __post_init__(self) -> None:
        self.context_width = self.window_width - self.strip_width
        if self.overlap > self.strip_width:
            raise ValueError("overlap must be <= strip_width")
        if self.context_width <= 0:
            raise ValueError("window_width must be > strip_width")
        if self.buffer_min < 1:
            raise ValueError("buffer_min must be >= 1")
        if self.buffer_target < self.buffer_min:
            raise ValueError("buffer_target must be >= buffer_min")

    def client_dict(self) -> dict[str, Any]:
        """Subset of config the browser needs."""
        return {
            "height": self.height,
            "strip_width": self.strip_width,
            "overlap": self.overlap,
            "scroll_speed": self.scroll_speed,
            "scroll_speed_min": self.scroll_speed_min,
            "buffer_target": self.buffer_target,
            "buffer_min": self.buffer_min,
        }

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def config_from_args(args: Any) -> Config:
    """Build Config from an argparse Namespace."""
    prompts = list(Config().prompts)
    if getattr(args, "prompt", None):
        prompts = [(0, args.prompt)]

    kw = dict(
        height=args.height,
        window_width=args.window_width,
        strip_width=args.strip_width,
        overlap=args.overlap,
        buffer_target=args.buffer_target,
        buffer_min=args.buffer_min,
        scroll_speed=args.scroll_speed,
        scroll_speed_min=args.scroll_speed_min,
        mock=args.mock,
        seed=args.seed,
        steps=args.steps,
        guidance_scale=args.guidance_scale,
        inpaint_model=args.inpaint_model,
        lcm_lora=args.lcm_lora,
        taesd_model=args.taesd_model,
        host=args.host,
        port=args.port,
        prompts=prompts,
        device="cpu" if args.mock else args.device,
        backend=getattr(args, "backend", None) or "sd15",
    )
    if kw["backend"] == "sdxl":
        base = Config()
        for k, v in SDXL_PRESET.items():
            if k in kw and kw[k] == getattr(base, k):
                kw[k] = v
            elif k not in kw:
                kw[k] = v
    return Config(**kw)


# 1024-class geometry for SDXL: same proportions as SD1.5 (window 1:1, strip 1/4, overlap 3/4 strip).
SDXL_PRESET: dict[str, Any] = {
    "height": 1024, "window_width": 1024, "strip_width": 256, "overlap": 192, "repaint_band": 128,
    "steps": 18, "guidance_scale": 6.0, "seam_retries": 1, "scroll_speed": 60.0, "scroll_speed_min": 16.0,
}
