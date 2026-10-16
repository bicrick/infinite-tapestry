import pytest

from infinite_tapestry import sdxl_merge as M


def test_default_model_is_v5_merge(monkeypatch):
    monkeypatch.delenv("TAPESTRY_SDXL_MODEL", raising=False)
    monkeypatch.delenv("TAPESTRY_SDXL_FALLBACK_MODEL", raising=False)
    from infinite_tapestry.config import Config
    c = Config()
    assert c.sdxl_model == M.V5_INPAINT
    assert c.sdxl_fallback_model == "OzzyGT/RealVisXL_V4.0_inpainting"


def test_env_rolls_back_to_v4(monkeypatch):
    monkeypatch.setenv("TAPESTRY_SDXL_MODEL", "OzzyGT/RealVisXL_V4.0_inpainting")
    from infinite_tapestry.config import Config
    assert Config().sdxl_model == "OzzyGT/RealVisXL_V4.0_inpainting"
    assert not M.is_merge(Config().sdxl_model)


def test_recipe():
    r = M.recipe(M.V5_INPAINT)
    assert r["tuned"] == "SG161222/RealVisXL_V5.0" and "inpainting" in r["inpaint"]
    with pytest.raises(ValueError):
        M.recipe("merge:nope")


def test_merge_tensor_add_difference():
    torch = pytest.importorskip("torch")
    inp, base, tuned = torch.ones(2, 3), torch.full((2, 3), 2.0), torch.full((2, 3), 5.0)
    assert torch.allclose(M.merge_tensor("x", inp.half(), base.half(), tuned.half()).float(), torch.full((2, 3), 4.0))


def test_conv_in_keeps_mask_channels():
    torch = pytest.importorskip("torch")
    inp = torch.zeros(4, 9, 3, 3); base = torch.zeros(4, 4, 3, 3); tuned = torch.ones(4, 4, 3, 3)
    out = M.merge_tensor("conv_in.weight", inp, base, tuned)
    assert torch.all(out[:, :4] == 1) and torch.all(out[:, 4:] == 0)
