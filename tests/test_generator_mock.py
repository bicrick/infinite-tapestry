"""Integration-ish tests for mock generation + stitching."""

from __future__ import annotations

from infinite_tapestry.buffer import StripBuffer
from infinite_tapestry.config import Config
from infinite_tapestry.generator import StripGenerator
from infinite_tapestry.mock_inpaint import MockInpainter
from infinite_tapestry.server import MAGIC, HEADER_SIZE, encode_strip_message
import struct


def test_mock_generate_one_strip():
    cfg = Config(mock=True, height=64, window_width=64, strip_width=16, overlap=4, buffer_target=3)
    buf = StripBuffer(target=3, minimum=1)
    gen = StripGenerator(cfg, MockInpainter(cfg), buf)
    strip = gen.generate_one()
    assert strip.index == 0
    assert strip.height == 64
    assert strip.width == 16  # first strip: new pixels only
    assert strip.overlap == 0
    assert strip.jpeg[:2] == b"\xff\xd8"
    assert gen.strip_index == 1

    strip2 = gen.generate_one()
    assert strip2.index == 1
    assert strip2.overlap == 4
    assert strip2.width == 16 + 4


def test_encode_strip_roundtrip_header():
    cfg = Config(mock=True, height=32, window_width=64, strip_width=16, overlap=4)
    buf = StripBuffer(target=2, minimum=1)
    gen = StripGenerator(cfg, MockInpainter(cfg), buf)
    strip = gen.generate_one()
    raw = encode_strip_message(strip)
    assert raw[:4] == MAGIC
    magic, index, width, height, overlap, prompt_len = struct.unpack_from(
        "!4sIHHHH", raw, 0
    )
    assert magic == MAGIC
    assert index == 0
    assert width == strip.width
    assert height == strip.height
    assert HEADER_SIZE == 16
    prompt = raw[HEADER_SIZE : HEADER_SIZE + prompt_len].decode("utf-8")
    assert prompt == strip.prompt
    assert raw[HEADER_SIZE + prompt_len :] == strip.jpeg


def test_generator_fills_buffer():
    cfg = Config(
        mock=True,
        height=32,
        window_width=64,
        strip_width=16,
        overlap=4,
        buffer_target=3,
        buffer_min=1,
    )
    buf = StripBuffer(target=3, minimum=1)
    gen = StripGenerator(cfg, MockInpainter(cfg), buf)
    gen.start()
    try:
        # Wait until buffer has target depth.
        for _ in range(100):
            if buf.depth() >= 3:
                break
            import time

            time.sleep(0.05)
        assert buf.depth() >= 3
        assert buf.produced >= 3
    finally:
        gen.stop()
