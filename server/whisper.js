/**
 * Whisper.cpp wrapper.
 *
 * Takes a WAV buffer (16 kHz mono PCM16 from the browser), writes it to a
 * temp file, runs `whisper-cli`, and returns the transcribed text.
 *
 * The browser is responsible for resampling and WAV encoding — see
 * web/public/audio.js. That keeps the server free of ffmpeg/opus deps.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WHISPER_ROOT = join(__dirname, "..", "scripts", "whisper.cpp");
const WHISPER_BIN = join(WHISPER_ROOT, "build", "bin", "whisper-cli");
// Default to small-q5_1 (multilingual, ~181 MB, quantized from the
// 466 MB small fp16 model with negligible quality loss). Roughly
// ~3 s per short utterance on CPU and meaningfully better on
// Mandarin than base.bin — base tends to confuse similar-sounding
// characters and occasionally mis-ID short CJK clips as Thai or
// Arabic. Set IRIS_WHISPER_MODEL to ggml-base.bin (~2 s) or
// ggml-tiny.bin (~0.9 s) for lower latency, or point it at an
// absolute path for a bigger model.
const WHISPER_MODEL =
  process.env.IRIS_WHISPER_MODEL ||
  join(WHISPER_ROOT, "models", "ggml-small-q5_1.bin");

/**
 * Transcribe a WAV buffer. Returns the transcription as a single string,
 * or throws if whisper fails.
 *
 * @param {Buffer} wavBuffer  16 kHz mono PCM16 WAV
 * @param {object} [opts]
 * @param {string} [opts.language="auto"]  whisper language code or "auto"
 * @param {number} [opts.threads=4]
 */
async function runWhisper(wavPath, outBase, language, threads) {
  const args = [
    "-m",
    WHISPER_MODEL,
    "-f",
    wavPath,
    "-l",
    language,
    "-t",
    String(threads),
    "--no-timestamps",
    "--output-txt",
    "--output-file",
    outBase,
  ];
  if (language === "zh") {
    args.push("--prompt", "以下是普通话的句子，请使用简体中文。");
  }
  await new Promise((resolve, reject) => {
    const child = spawn(WHISPER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`whisper exited ${code}: ${stderr.slice(-500)}`));
    });
  });
  const text = await readFile(`${outBase}.txt`, "utf8");
  return text.trim();
}

/**
 * iris only supports English and Simplified Chinese. Whisper's auto
 * language ID is happy to return Korean / Japanese / Thai / Arabic /
 * German / etc. on short noisy clips, which then sends garbage to
 * Claude. We post-validate with a strict allowlist: only CJK-present
 * text counts as zh, only pure Latin/ASCII counts as en, and anything
 * else (Thai, Hangul, Kana, Cyrillic, Arabic, Hebrew, Devanagari…)
 * falls through to "other" and triggers a forced-language retry.
 */
function classifyScript(text) {
  // CJK unified ideographs → Chinese
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  // Any character outside the allowed Latin ranges + common
  // punctuation → reject. u0000-u024f covers ASCII + Latin-1
  // Supplement + Latin Extended-A/B; u1e00-u1eff is Latin Extended
  // Additional; u2000-u206f is general punctuation (en/em dashes,
  // curly quotes, etc.). Anything else means a non-Latin script
  // leaked in.
  if (/[^\s\u0000-\u024f\u1e00-\u1eff\u2000-\u206f]/.test(text)) return "other";
  return "en";
}

export async function transcribe(wavBuffer, { language = "auto", threads = 4 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "iris-stt-"));
  const wavPath = join(dir, "in.wav");
  const outBase = join(dir, "out");

  try {
    await writeFile(wavPath, wavBuffer);

    let text = await runWhisper(wavPath, outBase, language, threads);

    // If the caller asked for auto, validate the detected script.
    // Whisper auto-detect frequently mis-IDs short Chinese clips as
    // Arabic / Korean / Japanese. Since iris only supports en and
    // zh, we force-retry in the supported languages and pick the
    // output whose script actually matches. Two runs of tiny.bin is
    // ~1.8 s which is acceptable for the rare fallback path.
    if (language === "auto" && text) {
      const kind = classifyScript(text);
      if (kind === "other") {
        // Try Chinese first — that's the common failure mode (short
        // Mandarin clip → Arabic transliteration).
        const zhText = await runWhisper(wavPath, outBase, "zh", threads);
        if (classifyScript(zhText) === "zh") {
          text = zhText;
        } else {
          // Not Chinese either → force English.
          text = await runWhisper(wavPath, outBase, "en", threads);
        }
      }
    }

    return text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Quick health check: does the binary and model exist? */
export async function whisperAvailable() {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(WHISPER_BIN);
    await stat(WHISPER_MODEL);
    return true;
  } catch {
    return false;
  }
}
