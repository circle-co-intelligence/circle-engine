#!/usr/bin/env bash
# Fetch on-device model packs declared in models/manifest.json.
# Model weights are downloaded per-machine (not committed — see .gitignore).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p static/models

fetch_pack() { # url dest file?
  local url="$1" dest="$2" file="${3:-}"
  mkdir -p "static/$dest"
  if [[ "$url" == *.tar.bz2 ]]; then
    curl -sL "$url" | tar -xj -C "static/$dest" --strip-components=0
  else
    curl -sL -o "static/$dest/$file" "$url"
  fi
  echo "ok: $dest"
}

fetch_pack "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-wasm-simd-v1.13.8-vad.tar.bz2" "models/vad"
fetch_pack "https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf" "models/llm" "SmolLM2-360M-Instruct-Q4_K_M.gguf"

# heavy packs — opt-in via FETCH_HEAVY=1 (ASR ~175MB, TTS ~85MB)
if [[ "${FETCH_HEAVY:-0}" == "1" ]]; then
  fetch_pack "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-wasm-simd-v1.13.7-en-asr-zipformer.tar.bz2" "models/asr-en"
  fetch_pack "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-wasm-simd-1.13.8-vits-piper-en_US-libritts_r-medium.tar.bz2" "models/tts-en"
fi
