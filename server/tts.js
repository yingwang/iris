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

/**
 * Voice presets — the public vocabulary of picks the UI exposes.
 * Each preset pairs an English voice with a Chinese voice and carries
 * a gender tag so the browser can decide which Live2D avatar to load.
 *
 * The Chinese voices are the interesting axis — English stays on a
 * single "natural conversational" neural voice per gender because
 * varying it adds noise without meaningfully changing the character.
 *
 * IDs are stable, so they're safe to persist in localStorage.
 */
export const VOICE_PRESETS = {
  // Female presets — all use Ava (en-US, most natural conversational
  // female) and rotate through four Chinese voices with distinct
  // personalities.
  "female-xiaoxiao": {
    gender: "female",
    label: "她 · 温柔",
    en: "en-US-AvaNeural",
    zh: "zh-CN-XiaoxiaoNeural",
  },
  "female-xiaoyi": {
    gender: "female",
    label: "她 · 甜美",
    en: "en-US-AvaNeural",
    zh: "zh-CN-XiaoyiNeural",
  },
  "female-xiaohan": {
    gender: "female",
    label: "她 · 知性",
    en: "en-US-AvaNeural",
    zh: "zh-CN-XiaohanNeural",
  },
  "female-xiaomo": {
    gender: "female",
    label: "她 · 亲切",
    en: "en-US-AvaNeural",
    zh: "zh-CN-XiaomoNeural",
  },

  // Male presets — all use Andrew (en-US) and rotate Chinese voices.
  // "少年" uses the Taiwan zh-TW-ZhiweiNeural voice, which has a
  // softer and more literary quality than the mainland zh-CN male
  // voices — closest thing edge-tts has to a 古风 young-scholar feel.
  "male-yunxi": {
    gender: "male",
    label: "他 · 温柔",
    en: "en-US-AndrewNeural",
    zh: "zh-CN-YunxiNeural",
  },
  "male-yunze": {
    gender: "male",
    label: "他 · 沉稳",
    en: "en-US-AndrewNeural",
    zh: "zh-CN-YunzeNeural",
  },
  "male-zhiwei": {
    gender: "male",
    label: "他 · 少年 (台)",
    en: "en-US-AndrewNeural",
    zh: "zh-TW-ZhiweiNeural",
  },
  "male-yunyang": {
    gender: "male",
    label: "他 · 正式",
    en: "en-US-AndrewNeural",
    zh: "zh-CN-YunyangNeural",
  },
  // 古风书生 preset — pairs the warm Yunxi voice with a static
  // photographic portrait rendered via PortraitStage (canvas 2D
  // with mouth + blink + breathing overlays). avatarUrl points at
  // an image file instead of a .model3.json; main.js picks the
  // renderer based on the extension.
  "male-scholar": {
    gender: "male",
    label: "他 · 古风书生",
    en: "en-US-AndrewNeural",
    zh: "zh-CN-YunxiNeural",
    avatarUrl: "/avatars/hanfu-scholar.png",
  },
};

export const DEFAULT_PRESET = process.env.IRIS_VOICE_PRESET || "female-xiaoxiao";

// Speaking speed in percent relative to the voice's natural pace.
// edge-tts accepts -50..+50. 0 is the voice's natural "1x" pace;
// +50 is the max before tones start to distort on Chinese voices.
const DEFAULT_RATE = Number(process.env.IRIS_TTS_RATE ?? 0);

/**
 * Resolve a preset id to the edge-tts voice name for the given
 * language. Falls back to the default preset if the id is unknown.
 */
export function voiceFor(language, preset = DEFAULT_PRESET) {
  const cfg = VOICE_PRESETS[preset] || VOICE_PRESETS[DEFAULT_PRESET];
  const lang = (language || "en").toLowerCase();
  const isZh = lang === "zh" || lang === "zh-cn" || lang === "zh-tw";
  return isZh ? cfg.zh : cfg.en;
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
  { language, voice, preset = DEFAULT_PRESET, rate = DEFAULT_RATE } = {}
) {
  if (!text || !text.trim()) return Buffer.alloc(0);

  const bin = await findEdgeTtsBin();
  const dir = await mkdtemp(join(tmpdir(), "iris-tts-"));
  const mp3Path = join(dir, "out.mp3");
  const v = voice || voiceFor(language, preset);

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
