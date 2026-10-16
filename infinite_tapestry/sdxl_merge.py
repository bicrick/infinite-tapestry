"""RealVisXL V5.0 inpaint, built on the GPU box from public Hugging Face weights.

No official 9-channel RealVisXL V5.0 inpainting checkpoint exists, so we use the standard "add difference"
recipe:  unet = SDXL-inpainting-0.1 + (RealVisXL V5.0 - SDXL base 1.0).  The extra mask/masked-image input
channels of conv_in keep the inpainting weights. The merge streams tensor by tensor (low RAM), runs once and
caches the result under TAPESTRY_MODEL_DIR (default /root/models); later boots load the cache. Text encoders,
tokenizers and VAE come from SG161222/RealVisXL_V5.0. RealVisXL and SDXL are CreativeML Open RAIL++-M.
Bake-off (2026-10-16, tapestry-bakeoff-refine): same speed as V4, cleaner cross-scene transitions.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

MERGE_PREFIX = "merge:"
V5_INPAINT = "merge:realvisxl-v5-inpaint"
RECIPES = {
    "realvisxl-v5-inpaint": {
        "inpaint": "diffusers/stable-diffusion-xl-1.0-inpainting-0.1",
        "base": "stabilityai/stable-diffusion-xl-base-1.0",
        "tuned": "SG161222/RealVisXL_V5.0",
    },
}
UNET_FILE = "unet/diffusion_pytorch_model.fp16.safetensors"


def is_merge(model_id: str) -> bool:
    return bool(model_id) and model_id.startswith(MERGE_PREFIX)


def recipe(model_id: str) -> dict:
    name = model_id[len(MERGE_PREFIX):]
    if name not in RECIPES:
        raise ValueError(f"unknown merged model {model_id!r}")
    return RECIPES[name]


def merge_tensor(name, w_inp, w_base, w_tuned):
    """inpaint + (tuned - base); conv_in only gets the difference on its 4 latent input channels."""
    d = w_tuned.float() - w_base.float()
    out = w_inp.float().clone()
    if name == "conv_in.weight" and out.shape[1] != d.shape[1]:
        out[:, : d.shape[1]] += d
    else:
        out += d
    return out.to(w_inp.dtype)


def ensure_unet(model_id: str, model_dir: str | None = None) -> Path:
    """Return a diffusers UNet folder for the merged model, building it on first use."""
    from huggingface_hub import hf_hub_download

    r = recipe(model_id)
    root = Path(model_dir or os.environ.get("TAPESTRY_MODEL_DIR", "/root/models")) / model_id[len(MERGE_PREFIX):]
    unet_dir = root / "unet"
    if (root / ".ok").exists():
        return unet_dir
    import torch
    from safetensors import safe_open
    from safetensors.torch import save_file

    logger.info("Building %s (one-time merge) …", model_id)
    paths = {k: hf_hub_download(repo, UNET_FILE) for k, repo in r.items()}
    cfg = hf_hub_download(r["inpaint"], "unet/config.json")
    tmp = root.with_name(root.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    (tmp / "unet").mkdir(parents=True)
    out = {}
    with safe_open(paths["inpaint"], "pt") as fi, safe_open(paths["base"], "pt") as fb, safe_open(paths["tuned"], "pt") as ft:
        for k in fi.keys():
            out[k] = merge_tensor(k, fi.get_tensor(k), fb.get_tensor(k), ft.get_tensor(k)).contiguous()
    save_file(out, str(tmp / UNET_FILE), metadata={"format": "pt"})
    shutil.copy(cfg, tmp / "unet/config.json")
    (tmp / "recipe.json").write_text(json.dumps(r, indent=1))
    (tmp / ".ok").touch()
    del out
    torch.cuda.empty_cache() if torch.cuda.is_available() else None
    shutil.rmtree(root, ignore_errors=True)
    tmp.rename(root)
    logger.info("Merged %s -> %s", model_id, unet_dir)
    return unet_dir


def load_pipeline(model_id: str, torch_dtype):
    """SDXL inpaint pipeline: merged UNet + the tuned model's text encoders/VAE."""
    from diffusers import AutoPipelineForInpainting, UNet2DConditionModel

    if not is_merge(model_id):
        return AutoPipelineForInpainting.from_pretrained(model_id, torch_dtype=torch_dtype, variant="fp16")
    unet = UNet2DConditionModel.from_pretrained(str(ensure_unet(model_id)), torch_dtype=torch_dtype, variant="fp16")
    return AutoPipelineForInpainting.from_pretrained(recipe(model_id)["tuned"], unet=unet, torch_dtype=torch_dtype, variant="fp16")
