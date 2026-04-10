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
import { transcribe, whisperAvailable, paraformerAvailable } from "./stt.js";
import { synthesize, guessLanguage } from "./tts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

/**
 * Strip characters that sound broken when piped through TTS. Even
 * though the system prompt forbids emoji / markdown / code, Claude
 * sometimes drops them in anyway — especially emoji after lists. We
 * scrub them server-side so the TTS voice never reads "dog face emoji"
 * out loud. Expression tags are already gone by the time text reaches
 * here (they're stripped by the streaming state machine below), so
 * this only handles emoji / markdown residue.
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
 * Streaming expression-tag processor. Claude's output arrives in
 * arbitrary chunks and can contain:
 *   - Self-closing mood cues: <expr:happy>, <expr:curious>, …
 *     → forwarded to the avatar, stripped from chat/TTS text
 *   - Rogue reasoning blocks: <expr:thinking> ... </expr:thinking>
 *     → entire block hidden from chat AND TTS (model hallucinated it
 *       as a scratchpad; the user shouldn't see or hear its insides)
 *   - Close tags the model invents: </expr:happy>
 *     → silently dropped
 *
 * Tags can straddle chunk boundaries, so we keep a `pending` buffer
 * holding any incomplete "<…" tail, and a `hiding` flag tracking
 * whether we're inside an opened thinking block. Returns `{ text,
 * cues }` — text is safe to display/speak, cues are expression names
 * to forward to the browser.
 */
function createExpressionStream() {
  let pending = "";
  let hiding = false;
  return {
    push(chunk) {
      pending += chunk;
      let out = "";
      const cues = [];
      let i = 0;
      while (i < pending.length) {
        if (hiding) {
          const close = pending.indexOf("</expr:thinking>", i);
          if (close === -1) {
            // Still hiding, discard everything up to here and wait.
            pending = "";
            return { text: out, cues };
          }
          i = close + "</expr:thinking>".length;
          hiding = false;
          continue;
        }
        const lt = pending.indexOf("<", i);
        if (lt === -1) {
          out += pending.slice(i);
          i = pending.length;
          break;
        }
        out += pending.slice(i, lt);
        const gt = pending.indexOf(">", lt);
        if (gt === -1) {
          // Incomplete tag — stash the tail and wait for more.
          pending = pending.slice(lt);
          return { text: out, cues };
        }
        const tag = pending.slice(lt, gt + 1);
        const openMatch = /^<expr:([a-z]+)>$/i.exec(tag);
        if (openMatch) {
          const name = openMatch[1].toLowerCase();
          if (name === "thinking") {
            hiding = true;
          } else {
            cues.push(name);
          }
        } else if (!/^<\/expr:[a-z]+>$/i.test(tag)) {
          // Not one of our tags — pass it through untouched so we
          // don't eat angle brackets that belong to real content.
          out += tag;
        }
        i = gt + 1;
      }
      pending = "";
      return { text: out, cues };
    },
    flush() {
      // On stream end, anything still in `pending` is a broken tag
      // or truncated text; emit whatever is safe. If we were hiding,
      // drop the partial reasoning entirely.
      const rest = hiding ? "" : pending;
      pending = "";
      hiding = false;
      return rest;
    },
  };
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
   * When the client tells us the user has started talking over iris, we
   * need to stop emitting. Set a flag the streaming loop checks, kill the
   * live Claude subprocess, and notify the browser so it can flush its
   * audio queue.
   */
  let interruptedAt = 0;
  const interruptCurrent = () => {
    interruptedAt = Date.now();
    session.cancel();
    send({ type: "interrupted" });
  };

  /**
   * Stream an assistant turn: forward text chunks as they arrive, and when
   * a sentence-ending punctuation appears, flush the buffered text through
   * `say` and ship the resulting WAV to the browser. The client plays WAV
   * blobs in order, so iris starts speaking before Claude finishes writing.
   */
  const streamAssistantTurn = async (userText) => {
    app.log.info({ prompt: userText.slice(0, 200) }, "→ claude");
    const turnStartedAt = Date.now();
    const isInterrupted = () => interruptedAt > turnStartedAt;
    const exprStream = createExpressionStream();
    let buffer = "";
    let full = "";

    // Minimum chars before we'll flush on a weak boundary (comma).
    // Keeps us from shipping 2-character TTS chunks while Claude is
    // still writing.
    const MIN_COMMA_FLUSH = 12;
    const flush = async (force = false) => {
      if (!buffer.trim()) return;
      let cut = buffer.length;
      if (!force) {
        // Prefer strong sentence terminators (. ! ? 。 ！ ？) if any.
        const strong = buffer.match(/[。！？!?]\s*/g);
        if (strong) {
          const last = buffer.lastIndexOf(strong[strong.length - 1]);
          cut = last + strong[strong.length - 1].length;
        } else if (buffer.length >= MIN_COMMA_FLUSH) {
          // Fall back to commas / semicolons for lower latency: ship
          // the first phrase immediately while Claude keeps typing.
          const weak = buffer.match(/[，,;:]\s*/g);
          if (!weak) return;
          const last = buffer.lastIndexOf(weak[weak.length - 1]);
          cut = last + weak[weak.length - 1].length;
        } else {
          return;
        }
      }
      const piece = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut);
      if (isInterrupted()) return;
      const speakable = stripForSpeech(piece);
      if (!speakable) return;
      try {
        const wav = await synthesize(speakable, { language: guessLanguage(speakable) });
        if (isInterrupted()) return; // user started talking while TTS was synthesizing
        if (wav.length > 0) {
          send({ type: "tts_audio", data: wav.toString("base64") });
        }
      } catch (err) {
        app.log.warn({ err: err.message }, "tts failed");
      }
    };

    for await (const chunk of session.send(userText)) {
      if (isInterrupted()) break;
      // Run the raw Claude chunk through the expression processor:
      // strips <expr:...> tags, hides <expr:thinking> reasoning
      // blocks, and tells us which mood cues to forward. Only the
      // returned `text` ever reaches the chat bubble or TTS.
      const { text: cleaned, cues } = exprStream.push(chunk);
      for (const name of cues) send({ type: "avatar_expression", name });
      if (cleaned) {
        send({ type: "assistant_chunk", text: cleaned });
        full += cleaned;
        buffer += cleaned;
      }
      // Try to emit speech as sentences complete (non-blocking flush
      // semantics: we await but it's usually sub-second per sentence).
      await flush(false);
    }
    // Drain any trailing text the processor was holding for tag
    // completion. If we were mid-thinking-block, that partial is
    // dropped.
    const tail = exprStream.flush();
    if (tail && !isInterrupted()) {
      send({ type: "assistant_chunk", text: tail });
      full += tail;
      buffer += tail;
    }
    if (!isInterrupted()) {
      await flush(true);
    }
    // Only signal end-of-turn for turns that actually completed.
    // Interrupted turns already triggered an `interrupted` message
    // when cancel() fired; emitting a stale assistant_end here races
    // the next turn and can split its transcript bubble in half.
    if (!isInterrupted()) {
      send({ type: "assistant_end" });
    }
    return full;
  };

  socket.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send({ type: "error", message: "invalid json" });
    }

    if (msg.type === "interrupt") {
      interruptCurrent();
      return;
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
        const { text, engine } = await transcribe(wav, {
          language: msg.language ?? "auto",
        });
        if (!text) {
          send({ type: "stt_empty" });
          return;
        }
        app.log.info({ engine, language: msg.language }, "stt done");
        send({ type: "stt_result", text });
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
const hasParaformer = await paraformerAvailable();
if (!hasWhisper) {
  app.log.warn("whisper binary or model missing — voice input will fail");
}
if (!hasParaformer) {
  app.log.info(
    "paraformer model not installed — Chinese turns will use whisper"
  );
}

app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  console.log(`\n  iris server running at http://localhost:${PORT}`);
  console.log(`  whisper:    ${hasWhisper ? "ready" : "missing"}`);
  console.log(`  paraformer: ${hasParaformer ? "ready (zh)" : "not installed"}\n`);
});
