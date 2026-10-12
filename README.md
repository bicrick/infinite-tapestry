# Infinite Tapestry

An endlessly scrolling, low-res panorama that keeps changing as it moves. An open-source inpainting model generates each newly revealed strip just ahead of the viewport, so the scroll never ends.

## How it works

1. A background generator keeps a rolling canvas and outpaints the next strip: a 512×512 window (¾ context + ¼ masked), SD1.5 inpaint + LCM-LoRA (~4 steps) + TAESD, fp16.
2. New strips are feather-blended (~32px) into the canvas and pushed to the browser over a WebSocket.
3. The client draws a smooth horizontal scroll and **slows down** if the buffer runs low.
4. Prompts drift on a schedule (meadow → forest → mountains → desert → city) so the world keeps changing.

See [docs/research.md](docs/research.md) for feasibility notes and alternatives.

## Quick start (mock / CPU)

No GPU or model downloads required — fakes generation so you can verify the pipeline and UI:

```bash
git clone <this-repo> && cd infinite-tapestry
python3 -m venv .venv && source .venv/bin/activate
pip install fastapi 'uvicorn[standard]' websockets numpy Pillow pytest httpx
pip install -e .

python -m infinite_tapestry.main --mock --port 8000
```

Open http://127.0.0.1:8000/ — you should see a scrolling mock panorama.

```bash
pytest -q
```

## GPU setup (fresh rented box)

Target: one NVIDIA GPU with ~12–24GB VRAM (RTX 3060 / A10G / L4 / similar).

```bash
# On the pod / VM
git clone <this-repo> && cd infinite-tapestry
chmod +x scripts/setup.sh
./scripts/setup.sh          # creates .venv and installs requirements.txt
source .venv/bin/activate

# First run downloads the inpaint checkpoint, LCM-LoRA, and TAESD from Hugging Face
python -m infinite_tapestry.main --port 8000
```

Default models (overridable):

| Role | Hugging Face id |
|---|---|
| SD1.5 inpaint (community mirror; original `runwayml/…` is gone) | `botp/stable-diffusion-v1-5-inpainting` |
| LCM-LoRA | `latent-consistency/lcm-lora-sdv1-5` |
| Tiny VAE | `madebyollin/taesd` |

If `torch` doesn’t see the GPU, install the matching CUDA wheel from [pytorch.org](https://pytorch.org/get-started/locally/) before `requirements.txt`, then re-run setup.

### Reach the UI from your laptop

**SSH port-forward** (works everywhere):

```bash
ssh -L 8000:127.0.0.1:8000 root@<box>
# then open http://127.0.0.1:8000/
```

**Public port:** bind is already `0.0.0.0:8000`. Open the provider’s firewall / HTTP port mapping and visit the printed URL. The browser client derives `ws://` or `wss://` from the page origin, so it works behind HTTPS reverse proxies without hard-coded hosts.

WebSocket **keep-alive pings** run every ~20s (server JSON ping + uvicorn protocol ping + client ping) so idle proxies (e.g. RunPod’s ~100s timeout) do not drop the stream.

## RunPod Community quickstart

1. Deploy a **Community** GPU pod (12GB+ VRAM, template with PyTorch/CUDA is fine).
2. Expose **TCP port 8000** (or your chosen `--port`) in the pod ports settings.
3. SSH in (or use Jupyter terminal), clone the repo, run `./scripts/setup.sh`, then:

   ```bash
   source .venv/bin/activate
   python -m infinite_tapestry.main --host 0.0.0.0 --port 8000
   ```

4. Open the proxy URL RunPod shows for that port:

   `https://<pod-id>-8000.proxy.runpod.net/`

   The page loads over HTTPS; the client connects to `wss://<pod-id>-8000.proxy.runpod.net/ws` automatically. Keep-alives prevent the proxy idle cut (~100s).

5. Optional: use SSH forward instead of the proxy if you prefer local `http://127.0.0.1:8000/`.

## Vast.ai quickstart

1. Rent an instance with an NVIDIA GPU (12GB+), Ubuntu + CUDA/PyTorch image.
2. Map host port **8000** → container port **8000** (or set `--port` to match your mapping).
3. From the Vast SSH command:

   ```bash
   git clone <this-repo> && cd infinite-tapestry
   ./scripts/setup.sh && source .venv/bin/activate
   python -m infinite_tapestry.main --host 0.0.0.0 --port 8000
   ```

4. Open `http://<instance-ip>:8000/` (or Vast’s provided HTTP link). WebSocket URL is derived from the page origin (`ws` or `wss` as appropriate).

5. If the instance is HTTP-only on a public IP, no extra proxy config is needed; for SSH-only access, use `-L 8000:127.0.0.1:8000`.

## Configuration

All of these are CLI flags (and live in `infinite_tapestry/config.py`):

| Flag | Default | Meaning |
|---|---|---|
| `--mock` | off | CPU fake generator |
| `--height` | 512 | Panorama height (px) |
| `--window-width` | 512 | Inpaint window width |
| `--strip-width` | 128 | Newly revealed width per step |
| `--overlap` | 32 | Seam feather (px) |
| `--buffer-target` | 6 | Strips to keep ahead of the viewport |
| `--buffer-min` | 2 | Below this, client slows scroll |
| `--scroll-speed` | 30 | Nominal px/s |
| `--scroll-speed-min` | 8 | Slow px/s when buffer is low |
| `--steps` | 4 | Diffusion steps (LCM) |
| `--guidance-scale` | 1.0 | CFG (LCM likes ~1–2) |
| `--prompt` | schedule | Single prompt (disables drift schedule) |
| `--inpaint-model` | `botp/…` | HF inpaint checkpoint |
| `--seed` | 42 | Base seed (per-strip offset applied) |
| `--device` | `cuda` | Torch device (ignored with `--mock`) |
| `--host` / `--port` | `0.0.0.0` / `8000` | Bind address |

Example — slower, taller, custom prompt:

```bash
python -m infinite_tapestry.main \
  --height 512 --strip-width 96 --scroll-speed 20 \
  --prompt "endless coastal cliffs at dusk, volumetric fog"
```

## Project layout

```
infinite_tapestry/
  config.py       # tunables
  canvas.py       # seed image, mask window, feather stitch
  buffer.py       # ahead-of-viewport strip buffer + pub/sub
  prompts.py      # scheduled prompt drift
  inpaint.py      # SD1.5 + LCM-LoRA + TAESD
  mock_inpaint.py # CPU fake generator
  generator.py    # worker thread
  server.py       # FastAPI + WebSocket (/ws)
  main.py         # CLI
static/           # canvas client (origin-relative ws/wss)
tests/            # stitching + buffer tests
scripts/setup.sh  # GPU box bootstrap
```

## Plan (MVP checklist)

- [x] Strip outpaint with overlap blend
- [x] Generator thread with 4–8 strip buffer; client slows when low
- [x] Scheduled prompt drift
- [x] Browser canvas + WebSocket (keep-alive for RunPod/Vast proxies)
- [x] `--mock` CPU mode, setup script, GPU README
- [x] Tests for stitch/buffer logic
- [ ] Later: sliding MultiDiffusion seams, SDXL-Lightning, ControlNet horizon lock

## Live controls (v0.2)

The browser UI (bottom-left **Controls** panel) talks to the server over the same WebSocket:

| Control | WS message | Effect |
|---|---|---|
| Prompt box + Blend slider | `{"type":"set_prompt","prompt":"…","blend":8}` | Next strips interpolate text embeddings from the current scene to the new one over N strips |
| Playlist | `{"type":"queue","prompts":[…],"hold":16,"blend":8,"loop":true}` | After `hold` strips on a scene, blend to the next playlist entry |
| Next ⏭ | `{"type":"skip"}` | Advance the playlist now |
| 1x/2x/4x/8x | `{"type":"speed","multiplier":4}` | View scrolls faster; server lets the generator run further ahead (buffer target × multiplier). Scrolling eases off at the generated edge |
| Drag / wheel | `{"type":"history","start":i,"end":j}` | Pan back through stored strips (server keeps `history_limit`=5000 in memory); **Return to live** snaps back |

Prompt changes apply to the next *generated* strip, which is a few strips ahead of the view (buffer depth).

## Hosting the frontend separately (Vercel etc.)

`static/` is a self-contained static site (`index.html`, `client.js`, `config.js`, `style.css`).
Point it at a backend either with a query param, `https://your-site.vercel.app/?ws=wss://<podid>-8000.proxy.runpod.net/ws`,
or by editing `static/config.js` (`window.TAPESTRY_CONFIG = { wsUrl: "wss://…/ws" }`). On Vercel, set the project root to `static/`
(no build step). The server enables CORS for `/config` and `/health`.

## Generation quality notes

Default is now **DreamShaper-8 inpainting + DPM++ 2M Karras, 20 steps, CFG 6, full VAE** (~1 s/strip on an RTX A4000).
The original LCM-LoRA + TAESD 4-step path is ~3x faster but produced smeared, oversaturated strips with visible seams;
opt back in with `--steps 4 --guidance-scale 1.0 --lcm-lora latent-consistency/lcm-lora-sdv1-5 --taesd-model madebyollin/taesd`.
Other fixes: `strength=1.0` (0.99 left the masked strip black with LCM), color-drift correction fitted on the regenerated context,
a 32px throwaway margin at the window's right edge (models paint a frame there), and the procedural seed is repainted by the model first.
Pinned `diffusers<0.32` etc. because newer diffusers needs `torch.accelerator` (torch ≥ 2.6) and RunPod's PyTorch 2.4 image fails on import.
