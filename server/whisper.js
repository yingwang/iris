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
export async function transcribe(wavBuffer, { language = "auto", threads = 4 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "iris-stt-"));
  const wavPath = join(dir, "in.wav");
  const outBase = join(dir, "out");

  try {
    await writeFile(wavPath, wavBuffer);

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

    // Bias the output toward Simplified Chinese. whisper.cpp's base
    // model otherwise likes to spit out Traditional characters
    // ("嗎" instead of "吗"), which then makes Claude reply in
    // Traditional too. An initial prompt that's pure simplified
    // nudges the decoder.
    if (language === "zh" || language === "zh-cn" || language === "auto") {
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
