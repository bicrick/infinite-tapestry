# Infinite Tapestry

An endlessly scrolling, low-res panorama that keeps changing as it moves. Open-source inpainting/outpainting models generate each newly revealed strip just ahead of the viewport.

## Plan (MVP)
- Generate in strips: a 512x512 window, 3/4 existing image + 1/4 blank, inpaint the blank part, blend about 32px into the canvas.
- A generator thread stays 4 to 8 strips ahead of the screen. If the buffer runs low, the scroll slows down instead of stalling.
- Change the world over time by shifting between scheduled prompts.
- Stack: SD 1.5 inpainting + LCM-LoRA (4 steps) + TAESD, fp16; pygame or a browser canvas for display.
- Hardware: an RTX 3060 12GB is enough for the MVP.

See [docs/research.md](docs/research.md) for the full feasibility research.
