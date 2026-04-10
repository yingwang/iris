/**
 * Speech-to-text dispatcher.
 *
 * iris uses two ASR engines depending on what the UI asked for:
 *
 *   - whisper (whisper.cpp, multilingual, ~2-3 s/turn on CPU):
 *     used for English, auto-detect, and the fallback path when
 *     paraformer isn't installed. Good at bilingual routing and
 *     handles language ID reasonably for short clips.
 *
 *   - paraformer (Alibaba, via sherpa-onnx-node, ~300 ms/turn):
 *     the Chinese-preferred path. State-of-the-art on Mandarin
 *     benchmarks and much faster than whisper-small. Gracefully
 *     degrades to whisper if the model files aren't present.
 *
 * Routing policy:
 *   language = "zh"   → paraformer if available, else whisper -l zh
 *   language = "en"   → whisper -l en
 *   language = "auto" → whisper auto + en/zh script validation
 *
 * The dispatcher intentionally never sends "auto" to paraformer —
 * the multilingual-ID story belongs to whisper, and paraformer-zh
 * occasionally hallucinates Chinese tokens on very noisy or silent
 * clips.
 */

import { transcribe as whisperTranscribe } from "./whisper.js";
import {
  transcribe as paraformerTranscribe,
  paraformerAvailable,
} from "./paraformer.js";

/**
 * Transcribe a WAV buffer using the engine appropriate for the
 * requested language. Returns `{ text, engine }` so the caller can
 * log which backend handled the turn.
 *
 * @param {Buffer} wavBuffer  16 kHz mono PCM16 WAV
 * @param {object} [opts]
 * @param {"auto"|"en"|"zh"} [opts.language="auto"]
 */
export async function transcribe(wavBuffer, { language = "auto" } = {}) {
  if (language === "zh" && (await paraformerAvailable())) {
    try {
      const text = await paraformerTranscribe(wavBuffer);
      return { text, engine: "paraformer" };
    } catch (err) {
      // Paraformer errors shouldn't kill the turn — fall through
      // to whisper and log. This covers native-binary loading
      // issues, corrupted model files, etc.
      console.warn("paraformer failed, falling back to whisper:", err.message);
    }
  }
  const text = await whisperTranscribe(wavBuffer, { language });
  return { text, engine: "whisper" };
}

export { whisperAvailable } from "./whisper.js";
export { paraformerAvailable };
