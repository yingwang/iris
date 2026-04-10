/**
 * Text-to-speech via Microsoft Edge's neural voices (edge-tts).
 *
 * edge-tts is a Python CLI (`pip install edge-tts`) that talks to the
 * same Azure TTS backend Microsoft Edge uses for Read Aloud. It's free
 * (no API key), needs a network connection, and the voices are an
 * order of magnitude more natural than macOS `say` — especially for
 * Chinese, where it replaces Tingting with XiaoxiaoNeural.
 *
 * Install:
 *   pip install edge-tts
 *
 * Override defaults via env vars:
 *   IRIS_VOICE_EN  (default en-US-AvaNeural)
 *   IRIS_VOICE_ZH  (default zh-CN-XiaoxiaoNeural)
 *   IRIS_TTS_BIN   (default resolved from ~/Library/Python or PATH)
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// Female voice set — the default "Iris" persona. Ava + Xiaoxiao are
// the most natural edge-tts neural voices for en/zh.
const FEMALE_VOICE_EN = process.env.IRIS_VOICE_EN || "en-US-AvaNeural";
const FEMALE_VOICE_ZH = process.env.IRIS_VOICE_ZH || "zh-CN-XiaoxiaoNeural";

// Male voice set — used when the UI asks for a male companion. Andrew
// is the most natural en-US male in edge-tts; Yunxi is the warm /
// friendly Chinese male voice (Yunyang is more newsreader-y).
const MALE_VOICE_EN = process.env.IRIS_VOICE_EN_M || "en-US-AndrewNeural";
const MALE_VOICE_ZH = process.env.IRIS_VOICE_ZH_M || "zh-CN-YunxiNeural";

// Speaking speed in percent relative to the voice's natural pace.
// edge-tts accepts -50..+50. 0 is the voice's natural "1x" pace;
// +50 is the max before tones start to distort on Chinese voices.
// The default is the voice's natural rate — the UI dropdown lets
// the user push it up to Fast (+25) or Turbo (+50) per taste.
const DEFAULT_RATE = Number(process.env.IRIS_TTS_RATE ?? 0);

/**
 * Pick the right edge-tts voice name for a (language, gender) pair.
 * Defaults to the female set since that's iris's original persona.
 */
export function voiceFor(language, gender = "female") {
  const lang = (language || "en").toLowerCase();
  const isZh = lang === "zh" || lang === "zh-cn" || lang === "zh-tw";
  if (gender === "male") {
    return isZh ? MALE_VOICE_ZH : MALE_VOICE_EN;
  }
  return isZh ? FEMALE_VOICE_ZH : FEMALE_VOICE_EN;
}

let cachedBin = null;

/** Find the edge-tts binary. pip installs it outside PATH on macOS. */
async function findEdgeTtsBin() {
  if (cachedBin) return cachedBin;
  if (process.env.IRIS_TTS_BIN) {
    cachedBin = process.env.IRIS_TTS_BIN;
    return cachedBin;
  }
  const candidates = [
    join(homedir(), "Library", "Python", "3.9", "bin", "edge-tts"),
    join(homedir(), "Library", "Python", "3.10", "bin", "edge-tts"),
    join(homedir(), "Library", "Python", "3.11", "bin", "edge-tts"),
    join(homedir(), "Library", "Python", "3.12", "bin", "edge-tts"),
    "/opt/homebrew/bin/edge-tts",
    "/usr/local/bin/edge-tts",
    "edge-tts",
  ];
  for (const p of candidates) {
    try {
      await stat(p);
      cachedBin = p;
      return p;
    } catch {}
  }
  cachedBin = "edge-tts"; // last resort: hope it's on PATH
  return cachedBin;
}

/**
 * Synthesize `text` and return an MP3 Buffer. The browser's
 * decodeAudioData handles MP3 natively, so no extra conversion.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.language]  "zh" / "en" / etc.
 * @param {string} [opts.voice]     explicit edge-tts voice name
 * @param {number} [opts.rate]      -50 .. +50 percent
 * @returns {Promise<Buffer>}
 */
export async function synthesize(
  text,
  { language, voice, gender = "female", rate = DEFAULT_RATE } = {}
) {
  if (!text || !text.trim()) return Buffer.alloc(0);

  const bin = await findEdgeTtsBin();
  const dir = await mkdtemp(join(tmpdir(), "iris-tts-"));
  const mp3Path = join(dir, "out.mp3");
  const v = voice || voiceFor(language, gender);

  const args = [
    "--voice",
    v,
    "--text",
    text,
    "--write-media",
    mp3Path,
  ];
  if (rate) {
    const pct = Math.max(-50, Math.min(50, Math.round(rate)));
    args.push("--rate", `${pct >= 0 ? "+" : ""}${pct}%`);
  }

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`edge-tts exited ${code}: ${stderr.slice(-500)}`));
      });
    });
    return await readFile(mp3Path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Rough language hint — any CJK ideograph → zh. */
export function guessLanguage(text) {
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
}
