# Infinite Tapestry: Feasibility Report
*Prepared Oct 11, 2026. "Est." marks my own estimates. Everything else is cited.*

## 1. Verdict
**Yes, this is feasible on one consumer GPU, with plenty of headroom.** A slow scroll only needs one new strip every few seconds. Distilled few-step diffusion models need tens to a few hundred milliseconds per 512px image:
- StreamDiffusion with SD-Turbo, 1 step, TensorRT: **10.65 ms per image, about 94 fps img2img on an RTX 4090** ([repo](https://github.com/cumulo-autumn/StreamDiffusion), [paper](https://arxiv.org/html/2312.12491v2)). The paper also tested an RTX 3060.
- SDXL-Turbo at 512x512 on an A100: **207 ms end to end, 67 ms of which is the UNet** ([Stability](https://stability.ai/news-updates/stability-ai-sdxl-turbo)). With ONNX Runtime it takes 49.5 ms for 1 step ([ORT benchmark](https://huggingface.co/tlwu/sdxl-turbo-onnxruntime/commit/ae6d79df2868cc8aee3e2c0bcfc8654e36d340b7)). With TensorRT, 4 steps take 138.6 ms on an A100 and 83.8 ms on an H100 ([HF](https://huggingface.co/stabilityai/sdxl-turbo-tensorrt)).
- Plain diffusers AutoPipeline img2img: about 634 ms ([paper](https://arxiv.org/html/2312.12491v2)). Even this unoptimized path is fast enough.

**Speed budget (est.):** Say the view is 512px tall and scrolls at 30 px/s, and each step outpaints a 128px strip (inside a 512x512 window that includes context). You need one generation every **~4.3 s**. A 4-step SD1.5 inpaint at 512 takes roughly 0.3–1 s on a 3060-class card (est.), which leaves about 4–10x headroom. Possible scroll speeds (est.):
- 4090: 100+ px/s at 512 tall, or a 1024-tall view at about 30 px/s.
- 3060: about 30–60 px/s at 512.
- Apple M-series (MPS/Core ML): about 10–30 px/s at 512.

The hard part is **coherence and drift over hours**, not speed: repetition, color creep, and the scene collapsing into mush. Section 4 covers how to handle it.

## 2. Candidate models
| Model | Role | Notes |
|---|---|---|
| SD 1.5 inpainting + LCM-LoRA ([LCM-LoRA](https://huggingface.co/latent-consistency/lcm-lora-sdv1-5)) | **MVP core** | Real masked inpainting in 4 steps. StreamDiffusion reports about 37 fps for 4-step LCM-LoRA on a 4090. |
| SD-Turbo / SDXL-Turbo ([sd-turbo](https://huggingface.co/stabilityai/sd-turbo), [sdxl-turbo](https://huggingface.co/stabilityai/sdxl-turbo)) | Fastest, 1–2 steps | No native inpaint checkpoint. Use img2img on a pre-filled strip plus a mask blend. Non-commercial license. |
| SDXL-Lightning / Hyper-SD + an SDXL inpaint checkpoint | Higher quality | 2–8 steps. Slower: est. 0.3–1 s on a 4090. |
| FLUX.1 Fill [dev] / schnell | Best quality outpainting | 12B parameters. Several seconds per image on a 4090 (est.). Usable only for a slow scroll with a deep buffer. Fill-dev has a non-commercial license. |
| LaMa ([repo](https://github.com/advimman/lama)) | Seam cleanup / fallback | Very fast GAN-style inpainting, but it repeats textures and can't invent new content. Use it for seams, not for world-building. |
| TAESD ([repo](https://github.com/madebyollin/taesd)) | Tiny VAE | Removes the VAE decode bottleneck. StreamDiffusion uses it. |
| MultiDiffusion / SyncDiffusion / StreamMultiDiffusion ([repo](https://github.com/ironjr/streammultidiffusion), [paper](https://arxiv.org/html/2403.09055v2)) | Seamless panoramas | Fuses overlapping windows in latent space. StreamMultiDiffusion made 512x4608 panoramas and claims 10x faster panorama generation than MultiDiffusion, at 1.57 fps region-based on a 2080 Ti. A sliding version of this approach is the most principled way to get seams right. |
| Video / world models (e.g. camera-controlled video diffusion, Genie-style or Oasis/DIAMOND-style) | Future option | Natively suited to "keep moving forward", but heavier and lower resolution. Worth watching. |

## 3. Hardware
- **RTX 3060 12GB:** fine for the SD1.5 + LCM MVP at 512.
- **RTX 4090 / 5090:** comfortable even for SDXL-Lightning. Can run TensorRT StreamDiffusion at around 100 fps for a single step.
- **Apple Silicon (M2/M3/M4 Pro/Max):** works through diffusers MPS or Core ML, roughly 3–10x slower than a 4090 (est.). A slow scroll is still fine.
- **Cloud:** an A10G or L4 is fine for SD1.5/SD-Turbo. An A100 or H100 gives the SDXL-Turbo numbers cited above. You could also run generation on the cloud GPU and stream the strips to a browser client.

## 4. Architectures
**A. Strip outpaint with overlap (MVP).** Keep a rolling canvas. To make the next strip, crop a 512x512 window: the left 384px is existing image (context) and the right 128px is masked. Inpaint it, then cross-feather the new strip into the canvas over about 32px. Scroll at a fixed rate and drop pixels that have scrolled off.

**B. Pre-generation buffer.** A generator thread keeps N strips (e.g. 4–8 strips, about 15–30 s) ahead of the viewport. The renderer scrolls smoothly at 60 fps with plain 2D blitting. If the buffer runs low, it slows the scroll, which makes the system stall-proof. Combine this with A.

**C. Sliding MultiDiffusion in latent space.** Keep a latent canvas. Denoise several overlapping windows together and average them where they overlap, so new latents start noisy at the right edge and settle as they move left (a "conveyor belt" of noise levels, similar to StreamDiffusion's Stream Batch). This gives the best seams with no visible strip boundaries. It's more work to build.

**D. 2D free-roaming tile grid.** Use 256px tiles. Generate each tile conditioned on its already-generated neighbors (an inpaint mask on the unknown quadrants), and prefetch the tiles in the direction of travel. Store tiles keyed by coordinate so you can go back and see the same place again. This supports panning in any direction.

**Evolving world (prompt drift):** Interpolate prompt embeddings slowly between scheduled prompts ("meadow → forest → snowy mountains → desert city"), or have a small LLM write the next scene every few minutes. Apply the new prompt only to the newly revealed strip, so changes stay local.

**Consistency tricks:**
- Feathered overlap blending.
- Keep the seed fixed per region.
- Color/histogram match each new strip to its context.
- A low-strength img2img "harmonize" pass across the seam.
- A style LoRA or IP-Adapter on a reference image to stop style drift.
- Mask dilation.
- Occasionally run a seam pass with LaMa.
- Keep the horizon line fixed with a ControlNet (depth or a simple horizon sketch) so the panorama doesn't tilt over time.

## 5. Recommended MVP stack
- Python, diffusers, `runwayml/stable-diffusion-inpainting` (or a community SD1.5 inpaint checkpoint), LCM-LoRA, 4 steps, TAESD, fp16, torch.compile. Move to StreamDiffusion/TensorRT later.
- Architecture A+B: 512px tall view, 128px strips, a 6-strip buffer, and a prompt scheduler.
- Frontend: a pygame or browser canvas that receives strips over a WebSocket.
- Target: about 30 px/s on a 3060, 100+ px/s on a 4090 (est.).
- Next steps: sliding MultiDiffusion (C) for seams, and SDXL-Lightning for quality.
