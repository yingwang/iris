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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

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

  socket.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send({ type: "error", message: "invalid json" });
    }

    if (msg.type === "user_text" && typeof msg.text === "string") {
      try {
        for await (const chunk of session.send(msg.text)) {
          send({ type: "assistant_chunk", text: chunk });
        }
        send({ type: "assistant_end" });
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

app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  console.log(`\n  iris server running at http://localhost:${PORT}\n`);
});
