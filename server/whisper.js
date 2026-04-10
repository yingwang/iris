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
// Default to tiny (multilingual, 75 MB) for ~0.9 s transcription of a
// short utterance on CPU. Swap in ggml-base.bin for better accuracy
// at ~2 s per turn, or set IRIS_WHISPER_MODEL to an absolute path.
const WHISPER_MODEL =
  process.env.IRIS_WHISPER_MODEL || join(WHISPER_ROOT, "models", "ggml-tiny.bin");

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
 * language ID is happy to return Korean / Japanese / German / etc. on
 * short noisy clips, which then sends garbage to Claude. We post-
 * validate: if the transcription contains characters outside the
 * English or Chinese writing systems, re-run with a forced language.
 */
function classifyScript(text) {
  // CJK unified ideographs + CJK punctuation → Chinese
  if (/[\u4e00-\u9fff\u3000-\u303f]/.test(text)) return "zh";
  // Hangul (Korean) → reject
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(text)) return "other";
  // Hiragana / Katakana (Japanese) → reject
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return "other";
  // Cyrillic (Russian etc.) → reject
  if (/[\u0400-\u04ff]/.test(text)) return "other";
  // Arabic → reject
  if (/[\u0600-\u06ff]/.test(text)) return "other";
  // Default: ASCII/Latin → English (close enough)
  return "en";
}

export async function transcribe(wavBuffer, { language = "auto", threads = 4 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "iris-stt-"));
  const wavPath = join(dir, "in.wav");
  const outBase = join(dir, "out");

  try {
    await writeFile(wavPath, wavBuffer);

    let text = await runWhisper(wavPath, outBase, language, threads);

    // If the caller asked for auto, validate the detected script and
    // force a retry in English when whisper picked a non-en/zh
    // language. Re-running is ~1 s on tiny.bin which is acceptable.
    if ((language === "auto") && text) {
      const kind = classifyScript(text);
      if (kind === "other") {
        text = await runWhisper(wavPath, outBase, "en", threads);
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
