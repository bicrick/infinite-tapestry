"""SD1.5 backend + SDXL->SD1.5 fallback load and generate (fake torch/diffusers, no GPU)."""
import sys
import types

from PIL import Image

from infinite_tapestry import inpaint
from infinite_tapestry.config import SDXL_PRESET, Config


class _Sched:
    config = {}

    @classmethod
    def from_config(cls, cfg, **kw):
        s = cls()
        s.kw = kw
        return s


class _DPM(_Sched):
    pass


class _LCM(_Sched):
    pass


class _Pipe:
    calls = []

    def __init__(self):
        self.scheduler = _Sched()
        self.unet = types.SimpleNamespace(config=types.SimpleNamespace(in_channels=9))

    @classmethod
    def from_pretrained(cls, *a, **k):
        return cls()

    def load_lora_weights(self, *a):
        pass

    def fuse_lora(self):
        pass

    def to(self, d):
        return self

    def encode_prompt(self, *a):
        return 1.0, 0.0

    def __call__(self, **kw):
        _Pipe.calls.append(kw)
        return types.SimpleNamespace(images=[Image.new("RGB", (kw["width"], kw["height"]))])


def _fakes(monkeypatch):
    torch = types.ModuleType("torch")
    torch.float16, torch.float32 = "f16", "f32"
    torch.cuda = types.SimpleNamespace(is_available=lambda: True)
    torch.no_grad = lambda: types.SimpleNamespace(__enter__=lambda s: None, __exit__=lambda s, *a: None)

    class _NG:
        def __enter__(self):
            return None

        def __exit__(self, *a):
            return False
    torch.no_grad = _NG
    torch.Generator = lambda device=None: types.SimpleNamespace(manual_seed=lambda s: None)
    d = types.ModuleType("diffusers")
    d.StableDiffusionInpaintPipeline = _Pipe
    d.DiffusionPipeline = _Pipe
    d.AutoencoderTiny = _Pipe
    d.LCMScheduler = _LCM
    d.DPMSolverMultistepScheduler = _DPM
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "diffusers", d)


def test_sd15_loads_with_dpm_and_generates(monkeypatch):
    _fakes(monkeypatch)
    cfg = Config(device="cuda", lcm_lora="", taesd_model="")
    inp = inpaint.create_inpainter(cfg)
    assert isinstance(inp, inpaint.DiffusersInpainter)
    assert isinstance(inp._pipe.scheduler, _DPM) and inp.model_id == cfg.inpaint_model
    out = inp.generate(Image.new("RGB", (64, 32)), Image.new("L", (64, 32)), "a valley", strength=0.6)
    assert out.size == (64, 32) and _Pipe.calls[-1]["strength"] == 0.6


def test_lcm_lora_keeps_the_lcm_scheduler(monkeypatch):
    _fakes(monkeypatch)
    inp = inpaint.DiffusersInpainter(Config(device="cuda", lcm_lora="lcm", taesd_model=""))
    assert isinstance(inp._pipe.scheduler, _LCM)


def test_sdxl_failure_falls_back_to_sd15_geometry(monkeypatch):
    _fakes(monkeypatch)

    def boom(cfg):
        raise RuntimeError("no sdxl")
    monkeypatch.setattr(inpaint, "SDXLInpainter", boom)
    cfg = Config(device="cuda", lcm_lora="", taesd_model="")
    for k, v in SDXL_PRESET.items():
        setattr(cfg, k, v)
    cfg.backend = "sdxl"
    inp = inpaint.create_inpainter(cfg)
    base = Config()
    assert isinstance(inp, inpaint.DiffusersInpainter) and cfg.backend == "sd15"
    assert (cfg.height, cfg.strip_width, cfg.steps, cfg.fresh_anchor) == (base.height, base.strip_width, base.steps, False)
    assert cfg.context_width == cfg.window_width - cfg.strip_width
