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
    overlap: int = 32  # feather blend into prior context
    context_width: int = 384  # window_width - strip_width

    # Buffer / scroll
    buffer_target: int = 6  # strips to keep ahead
    buffer_min: int = 2  # below this, client should slow down
    scroll_speed: float = 30.0  # px/s (nominal)
    scroll_speed_min: float = 8.0  # when buffer is low

    # Generation
    mock: bool = False
    seed: int = 42
    steps: int = 4
    guidance_scale: float = 1.0  # LCM prefers ~1.0–2.0
    strength: float = 0.99

    # Model IDs (community mirrors; runwayml inpaint repo is gone)
    inpaint_model: str = "botp/stable-diffusion-v1-5-inpainting"
    lcm_lora: str = "latent-consistency/lcm-lora-sdv1-5"
    taesd_model: str = "madebyollin/taesd"
    dtype: str = "float16"
    device: str = "cuda"

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    jpeg_quality: int = 85

    # Prompt schedule: (cumulative_strips_at_which_prompt_starts, prompt)
    # Prompt drifts between consecutive entries based on strip index.
    prompts: list[tuple[int, str]] = field(
        default_factory=lambda: [
            (0, "a sunlit meadow with wildflowers, distant rolling hills, soft clouds, panoramic landscape"),
            (24, "a dense misty forest with tall pines, mossy ground, dappled light, panoramic landscape"),
            (48, "snowy mountain peaks above a frozen lake, cold blue sky, panoramic landscape"),
            (72, "a desert canyon at golden hour, red rock formations, panoramic landscape"),
            (96, "a futuristic desert city on the horizon, neon glow at dusk, panoramic landscape"),
        ]
    )
    negative_prompt: str = (
        "blurry, low quality, distorted, watermark, text, frame, border, "
        "ugly, duplicate, mutant"
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

    return Config(
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
        host=args.host,
        port=args.port,
        prompts=prompts,
        device="cpu" if args.mock else args.device,
    )
