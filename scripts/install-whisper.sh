#!/bin/sh
# Build whisper.cpp and download the base model for iris.
#
# On this hardware (Intel iMac 2019) the Metal backend produces garbled
# transcriptions, so we force CPU + BLAS. Apple Silicon users should
# remove -DGGML_METAL=OFF to get GPU acceleration.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WHISPER_DIR="$SCRIPT_DIR/whisper.cpp"

if [ ! -d "$WHISPER_DIR" ]; then
  echo "==> cloning whisper.cpp"
  git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
fi

cd "$WHISPER_DIR"

echo "==> configuring (CPU + BLAS, no Metal)"
cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=OFF -DGGML_BLAS=ON

echo "==> building"
cmake --build build -j 4 --config Release

if [ ! -f "models/ggml-base.bin" ]; then
  echo "==> downloading ggml-base model (~142 MB)"
  sh ./models/download-ggml-model.sh base
fi

echo
echo "whisper.cpp ready."
echo "  binary: $WHISPER_DIR/build/bin/whisper-cli"
echo "  model:  $WHISPER_DIR/models/ggml-base.bin"
