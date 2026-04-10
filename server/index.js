/**
 * Iris server — Fastify + WebSocket.
 *
 * One WebSocket per connected browser. Messages:
 *
 *   client → server
 *     { type: "user_text", text: "hello" }
 *     { type: "user_audio", audio: "<base64 wav>" }   // future: Whisper STT
 *
 *   server → client
 *     { type: "assistant_chunk", text: "..." }        // streaming text
 *     { type: "assistant_end" }
 *     { type: "tts_audio", audio: "<base64 wav>" }    // future: Piper TTS
 *     { type: "error", message: "..." }
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";

import { ClaudeSession } from "./claude.js";
import { transcribe, whisperAvailable } from "./whisper.js";
import { synthesize, guessLanguage } from "./tts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

/**
 * Strip characters that sound broken when piped through TTS. Even
 * though the system prompt forbids emoji / markdown / code, Claude
 * sometimes drops them in anyway — especially emoji after lists. We
 * scrub them server-side so the TTS voice never reads "dog face emoji"
 * out loud. The original text still goes into the transcript bubble,
 * so the user sees exactly what Claude wrote.
 */
function stripForSpeech(text) {
  return text
    // Extended_Pictographic covers emoji, dingbats, pictographs.
    .replace(/\p{Extended_Pictographic}/gu, "")
    // Variation selectors and zero-width joiners that follow emoji.
    .replace(/[\u200d\ufe0f]/g, "")
    // Inline code and bold/italic markdown markers.
    .replace(/[`*_~]/g, "")
    // Headers and bullet prefixes at line starts.
    .replace(/^\s*[#>\-*+]+\s*/gm, "")
    // Collapse whitespace runs introduced by stripping.
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Prepend a vision-style note describing the user's current facial
 * expression so Claude can react to it. Always emit *something* when we
 * get any snapshot — even if the tracker says the user is looking away,
 * that itself is useful information. The only case we drop is when the
 * client didn't send an expression field at all (face tracker failed
 * to initialize).
 */
function withExpression(userText, expression) {
  if (!expression) return userText;
  const parts = [];
  if (expression.looking === false) {
    parts.push("The user isn't visible on camera right now");
  } else {
    parts.push(`The user looks ${expression.label || "neutral"}`);
    if (expression.smile > 0.6) parts.push("grinning broadly");
    if (expression.browUp > 0.6) parts.push("eyebrows raised");
    if (expression.browDown > 0.5) parts.push("brow furrowed");
    if (expression.eyesClosed > 0.7) parts.push("eyes closed");
    if (expression.mouthOpen > 0.5 && expression.smile < 0.4) parts.push("mouth open");
  }
  return `[${parts.join(", ")}.] ${userText}`;
}

const app = Fastify({ logger: true });

await app.register(fastifyWebsocket);
await app.register(fastifyStatic, {
  root: join(__dirname, "..", "web", "public"),
  prefix: "/",
});

app.get("/ws", { websocket: true }, (socket, req) => {
  const session = new ClaudeSession();
  app.log.info({ sessionId: session.sessionId }, "client connected");

  const send = (obj) => socket.send(JSON.stringify(obj));

  /**
   * Stream an assistant turn: forward text chunks as they arrive, and when
   * a sentence-ending punctuation appears, flush the buffered text through
   * `say` and ship the resulting WAV to the browser. The client plays WAV
   * blobs in order, so iris starts speaking before Claude finishes writing.
   */
  const streamAssistantTurn = async (userText) => {
    app.log.info({ prompt: userText.slice(0, 200) }, "→ claude");
    let buffer = "";
    let full = "";

    const flush = async (force = false) => {
      if (!buffer.trim()) return;
      // Sentence-ish boundary: prefer breaking on punctuation, but if
      // `force`, flush whatever is left.
      let cut = buffer.length;
      if (!force) {
        const m = buffer.match(/[。！？!?.;:]\s*/g);
        if (!m) return; // no sentence boundary yet, wait for more
        const last = buffer.lastIndexOf(m[m.length - 1]);
        cut = last + m[m.length - 1].length;
      }
      const piece = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut);
      const speakable = stripForSpeech(piece);
      if (!speakable) return;
      try {
        const wav = await synthesize(speakable, { language: guessLanguage(speakable) });
        if (wav.length > 0) {
          send({ type: "tts_audio", data: wav.toString("base64") });
        }
      } catch (err) {
        app.log.warn({ err: err.message }, "tts failed");
      }
    };

    for await (const chunk of session.send(userText)) {
      send({ type: "assistant_chunk", text: chunk });
      full += chunk;
      buffer += chunk;
      // Try to emit speech as sentences complete (non-blocking flush
      // semantics: we await but it's usually sub-second per sentence).
      await flush(false);
    }
    await flush(true);
    send({ type: "assistant_end" });
    return full;
  };

  socket.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send({ type: "error", message: "invalid json" });
    }

    if (msg.type === "user_text" && typeof msg.text === "string") {
      try {
        const userInput = withExpression(msg.text, msg.expression);
        await streamAssistantTurn(userInput);
      } catch (err) {
        app.log.error(err);
        send({ type: "error", message: err.message || String(err) });
      }
      return;
    }

    if (msg.type === "user_audio" && typeof msg.data === "string") {
      try {
        const wav = Buffer.from(msg.data, "base64");
        send({ type: "stt_started" });
        const text = await transcribe(wav, { language: msg.language ?? "auto" });
        if (!text) {
          send({ type: "stt_empty" });
          return;
        }
        send({ type: "stt_result", text });
        app.log.info({ expression: msg.expression }, "received expression");
        const userInput = withExpression(text, msg.expression);
        await streamAssistantTurn(userInput);
      } catch (err) {
        app.log.error(err);
        send({ type: "error", message: err.message || String(err) });
      }
      return;
    }

    send({ type: "error", message: `unknown message type: ${msg.type}` });
  });

  socket.on("close", () => {
    app.log.info({ sessionId: session.sessionId }, "client disconnected");
  });
});

const hasWhisper = await whisperAvailable();
if (!hasWhisper) {
  app.log.warn("whisper binary or model missing — voice input will fail");
}

app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  console.log(`\n  iris server running at http://localhost:${PORT}`);
  console.log(`  whisper: ${hasWhisper ? "ready" : "missing"}\n`);
});
