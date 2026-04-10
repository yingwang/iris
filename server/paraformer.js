/**
 * Paraformer (Alibaba DAMO) wrapper via sherpa-onnx-node.
 *
 * This is iris's Chinese-preferred ASR path. Paraformer-zh beats
 * whisper on Mandarin benchmarks and is considerably faster —
 * short-utterance latency is roughly 200-500 ms on CPU vs. whisper
 * small's ~3 s. The same model also transcribes English reasonably
 * well on clean audio, so we use it for any turn the client pins to
 * "zh" and leave "en" / "auto" on whisper where multilingual
 * heuristics work better.
 *
 * Runs entirely in-process as a C++ native addon (no sidecar, no
 * HTTP, no Python). The model files live under models/paraformer-zh
 * and are downloaded by scripts/install-paraformer.sh.
 */

import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = join(__dirname, "..", "models", "paraformer-zh");
const MODEL_PATH =
  process.env.IRIS_PARAFORMER_MODEL || join(MODEL_DIR, "model.int8.onnx");
const TOKENS_PATH =
  process.env.IRIS_PARAFORMER_TOKENS || join(MODEL_DIR, "tokens.txt");

let recognizerPromise = null;

/**
 * Lazily load the native module and construct the recognizer on
 * first use. We don't do this at import time because:
 *   - Users without the model files should still be able to boot
 *     iris and use whisper.
 *   - The native .node binary can cost ~100 ms of startup that we
 *     don't want on paths that never call paraformer.
 */
function getRecognizer() {
  if (recognizerPromise) return recognizerPromise;
  recognizerPromise = (async () => {
    // Fail fast with a helpful message if the model files aren't
    // installed. The caller (stt dispatcher) falls back to whisper.
    await stat(MODEL_PATH);
    await stat(TOKENS_PATH);
    const sherpa = require("sherpa-onnx-node");
    const rec = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        paraformer: { model: MODEL_PATH },
        tokens: TOKENS_PATH,
        numThreads: 2,
        debug: 0,
        provider: "cpu",
      },
      decodingMethod: "greedy_search",
    });
    return { sherpa, rec };
  })();
  return recognizerPromise;
}

/**
 * Transcribe a 16 kHz mono PCM16 WAV buffer and return the text.
 * Throws if the paraformer model isn't installed — the stt dispatcher
 * uses that to fall back to whisper rather than crashing the turn.
 */
export async function transcribe(wavBuffer) {
  const { sherpa, rec } = await getRecognizer();

  // sherpa-onnx's readWave takes a path, so we spill the buffer to a
  // temp file. This is slightly wasteful compared to handing it a
  // Float32Array directly; if profiling shows it matters, we can
  // decode the WAV header in JS and skip the file hop.
  const dir = await mkdtemp(join(tmpdir(), "iris-paraformer-"));
  const wavPath = join(dir, "in.wav");
  try {
    await writeFile(wavPath, wavBuffer);
    const { samples, sampleRate } = sherpa.readWave(wavPath);
    const stream = rec.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    await rec.decodeAsync(stream);
    const result = rec.getResult(stream);
    return (result.text || "").trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Health check: are the model files present? */
export async function paraformerAvailable() {
  try {
    await stat(MODEL_PATH);
    await stat(TOKENS_PATH);
    return true;
  } catch {
    return false;
  }
}
