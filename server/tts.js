/**
 * Text-to-speech wrapper.
 *
 * Uses macOS `say` because the Piper x64 macOS binary ships without its
 * required dylibs (broken release), and macOS has perfectly usable
 * built-in neural voices — including Tingting (zh_CN) and premium
 * English voices — that are good enough for iris to feel alive.
 *
 * Outputs 16 kHz mono LEI16 WAV, which we stream straight to the
 * browser for Web Audio playback.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Voice defaults per language. English uses Daniel (British male) to match
// the male Mark avatar. For Chinese macOS ships Tingting (female) by
// default and no male voice is installed out of the box — the user can
// download a male zh_CN voice from System Settings → Accessibility →
// Spoken Content → System Voice → Manage Voices (e.g. "Linghui Premium"
// if available) and set IRIS_VOICE_ZH to it.
const VOICE_BY_LANG = {
  zh: process.env.IRIS_VOICE_ZH || "Tingting",
  "zh-cn": process.env.IRIS_VOICE_ZH || "Tingting",
  "zh-tw": process.env.IRIS_VOICE_ZH || "Meijia",
  en: process.env.IRIS_VOICE_EN || "Daniel",
  "en-us": process.env.IRIS_VOICE_EN || "Daniel",
  "en-gb": process.env.IRIS_VOICE_EN || "Daniel",
  ja: "Kyoko",
  ko: "Yuna",
};

/**
 * Synthesize `text` as a WAV buffer.
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.language]  "zh" / "en" / etc. Used to pick a default voice.
 * @param {string} [opts.voice]     Explicit `say -v` voice name. Overrides language.
 * @param {number} [opts.rate]      Words per minute (say default is 175).
 * @returns {Promise<Buffer>}       16 kHz mono PCM16 WAV bytes
 */
export async function synthesize(text, { language, voice, rate } = {}) {
  if (!text || !text.trim()) return Buffer.alloc(0);

  const dir = await mkdtemp(join(tmpdir(), "iris-tts-"));
  const wavPath = join(dir, "out.wav");

  const args = ["-o", wavPath, "--data-format=LEI16@16000"];
  const v = voice || VOICE_BY_LANG[(language || "").toLowerCase()] || "Samantha";
  args.push("-v", v);
  if (rate) args.push("-r", String(Math.round(rate)));
  args.push(text);

  try {
    await new Promise((resolve, reject) => {
      const child = spawn("say", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`say exited ${code}: ${stderr.slice(-500)}`));
      });
    });
    return await readFile(wavPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Rough language hint from text: pick Chinese voice if there are any CJK ideographs. */
export function guessLanguage(text) {
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
}
