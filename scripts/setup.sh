#!/usr/bin/env bash
# Bootstrap Infinite Tapestry on a fresh Ubuntu GPU box (RunPod / Vast / Lambda).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PYTHON="${PYTHON:-python3}"
VENV="${VENV:-$ROOT/.venv}"

echo "==> Python: $($PYTHON --version)"
echo "==> Creating venv at $VENV"
$PYTHON -m venv "$VENV"
# shellcheck disable=SC1091
source "$VENV/bin/activate"

python -m pip install --upgrade pip wheel

if [[ "${MOCK_ONLY:-0}" == "1" ]]; then
  echo "==> Installing mock/CPU deps only"
  pip install fastapi "uvicorn[standard]" websockets numpy Pillow pytest httpx
else
  echo "==> Installing full requirements (includes torch/diffusers)"
  echo "    Tip: on CUDA boxes, install the matching torch wheel first if needed:"
  echo "    https://pytorch.org/get-started/locally/"
  pip install -r requirements.txt
fi

pip install -e "$ROOT" 2>/dev/null || true

echo
echo "Setup complete."
echo "  source $VENV/bin/activate"
echo "  # Mock / CPU smoke test:"
echo "  python -m infinite_tapestry.main --mock --port 8000"
echo "  # Real GPU:"
echo "  python -m infinite_tapestry.main --port 8000"
echo
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi || true
else
  echo "(nvidia-smi not found — use --mock, or install NVIDIA drivers/CUDA)"
fi
