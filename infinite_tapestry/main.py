"""CLI entry point for Infinite Tapestry."""

from __future__ import annotations

import argparse
import logging
import sys

import uvicorn

from .buffer import StripBuffer
from .config import Config, config_from_args
from .generator import StripGenerator
from .inpaint import create_inpainter
from .server import create_app


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Infinite Tapestry — endlessly scrolling AI panorama"
    )
    p.add_argument(
        "--mock",
        action="store_true",
        help="CPU mock generator (no GPU / no model download)",
    )
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--height", type=int, default=512)
    p.add_argument("--window-width", type=int, default=512)
    p.add_argument("--strip-width", type=int, default=128)
    p.add_argument("--overlap", type=int, default=32)
    p.add_argument("--buffer-target", type=int, default=6)
    p.add_argument("--buffer-min", type=int, default=2)
    p.add_argument("--scroll-speed", type=float, default=30.0, help="px/s")
    p.add_argument("--scroll-speed-min", type=float, default=8.0, help="px/s when low")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--steps", type=int, default=Config.steps)
    p.add_argument("--guidance-scale", type=float, default=Config.guidance_scale)
    p.add_argument(
        "--prompt",
        default=None,
        help="Single prompt (replaces the default drift schedule)",
    )
    p.add_argument(
        "--inpaint-model",
        default=Config.inpaint_model,
        help="HF id for SD1.5 inpainting checkpoint (community mirror)",
    )
    p.add_argument("--lcm-lora", default=Config.lcm_lora, help="empty = off (DPM++)")
    p.add_argument("--taesd-model", default=Config.taesd_model, help="empty = full VAE")
    p.add_argument(
        "--device",
        default="cuda",
        help="torch device for real generation (ignored with --mock)",
    )
    p.add_argument(
        "--haiku-model",
        default=None,
        help="Anthropic model id for the prompt interpreter "
        "(default: $TAPESTRY_HAIKU_MODEL or claude-haiku-5-5)",
    )
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    config = config_from_args(args)
    logging.info(
        "Starting Infinite Tapestry (mock=%s, %dx strips, buffer=%d)",
        config.mock,
        config.strip_width,
        config.buffer_target,
    )

    buffer = StripBuffer(
        target=config.buffer_target,
        minimum=config.buffer_min,
        history_limit=config.history_limit,
    )
    inpainter = create_inpainter(config)
    generator = StripGenerator(config, inpainter, buffer)
    generator.start()

    from .interpreter import PromptInterpreter

    interpreter = PromptInterpreter(model=args.haiku_model)
    logging.info(
        "Prompt interpreter: %s",
        f"Claude {interpreter.model}" if interpreter.enabled else "off (no ANTHROPIC_API_KEY)",
    )
    app = create_app(config, buffer, generator, interpreter=interpreter)

    # ws_ping_interval: uvicorn/websockets protocol ping (in addition to our JSON pings).
    try:
        uvicorn.run(
            app,
            host=config.host,
            port=config.port,
            log_level="debug" if args.verbose else "info",
            ws_ping_interval=20.0,
            ws_ping_timeout=60.0,
        )
    finally:
        generator.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
