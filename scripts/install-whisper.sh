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

if [ ! -f "models/ggml-small-q5_1.bin" ]; then
  echo "==> downloading ggml-small-q5_1 model (~181 MB)"
  sh ./models/download-ggml-model.sh small-q5_1
fi

echo
echo "whisper.cpp ready."
echo "  binary: $WHISPER_DIR/build/bin/whisper-cli"
echo "  model:  $WHISPER_DIR/models/ggml-small-q5_1.bin"
echo
echo "iris uses small-q5_1 by default (~3s per turn on CPU, strong"
echo "Mandarin + English accuracy). For lower latency, also run one"
echo "of the smaller models:"
echo "  sh $WHISPER_DIR/models/download-ggml-model.sh base   # ~2s"
echo "  sh $WHISPER_DIR/models/download-ggml-model.sh tiny   # ~0.9s"
echo "and set IRIS_WHISPER_MODEL to the chosen path."
