#!/bin/sh
# Download the Paraformer-zh ONNX model for iris.
#
# Paraformer is Alibaba DAMO Academy's Chinese ASR. State of the art
# on Mandarin benchmarks, runs locally via sherpa-onnx-node (in-process
# C++ addon, no Python sidecar). The model file is ~232 MB.
#
# After running this script you can start iris normally; the server
# auto-detects the installed model and routes Chinese-language turns
# to paraformer while leaving English + auto-detect on whisper.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
MODEL_DIR="$REPO_ROOT/models/paraformer-zh"

mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_DIR/model.int8.onnx" ] && [ -f "$MODEL_DIR/tokens.txt" ]; then
  echo "paraformer-zh already installed at $MODEL_DIR"
  exit 0
fi

ARCHIVE_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2"
TMP_ARCHIVE="$MODEL_DIR/model.tar.bz2"

echo "==> downloading paraformer-zh (~223 MB)"
curl -L -o "$TMP_ARCHIVE" "$ARCHIVE_URL"

echo "==> extracting"
tar -xjf "$TMP_ARCHIVE" -C "$MODEL_DIR"

mv "$MODEL_DIR/sherpa-onnx-paraformer-zh-2023-09-14/model.int8.onnx" "$MODEL_DIR/"
mv "$MODEL_DIR/sherpa-onnx-paraformer-zh-2023-09-14/tokens.txt" "$MODEL_DIR/"
rm -rf "$MODEL_DIR/sherpa-onnx-paraformer-zh-2023-09-14"
rm -f "$TMP_ARCHIVE"

echo
echo "paraformer ready."
echo "  model:  $MODEL_DIR/model.int8.onnx"
echo "  tokens: $MODEL_DIR/tokens.txt"
echo
echo "Chinese turns (language=zh in the UI) will now route through"
echo "paraformer instead of whisper. English + auto stay on whisper."
