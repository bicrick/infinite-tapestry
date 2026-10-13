#!/bin/bash
# Pod container start: deps, newest CI release (falls back to the code already on disk), then the supervisor.
pip install -q "diffusers>=0.30,<0.32" "transformers>=4.44,<4.47" "accelerate>=0.33,<1.2" safetensors sentencepiece "peft>=0.12,<0.14" "huggingface_hub<0.26" fastapi "uvicorn[standard]" websockets > /root/pip.log 2>&1
bash /root/it/scripts/pod/fetch_release.sh >> /root/supervise.log 2>&1 || true
exec /root/it/scripts/pod/supervise.sh >> /root/supervise.log 2>&1
