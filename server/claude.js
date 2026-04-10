/**
 * Claude Code CLI wrapper.
 *
 * Spawns `claude -p ... --output-format stream-json` as a subprocess and
 * streams assistant text back to the caller as it arrives. Uses the user's
 * Claude Code subscription — no API key needed.
 *
 * Each ClaudeSession maintains conversation continuity via --session-id.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULT_SYSTEM_PROMPT = `You are Iris, a warm, witty male voice companion on a live video call
with the user. You appear as a friendly man in a sharp suit (a Live2D avatar), and you speak with a
masculine voice.

You can SEE the user: each of their turns is prefixed with a bracketed note describing what their
face looks like right now — e.g. "[The user looks smiling.]" or "[The user looks frowning, brow
furrowed.]". Treat this like real vision: react to it when it is meaningful. If they smile, you
can warmly acknowledge it ("you're smiling — good news?"). If they frown or look confused, gently
check in ("something on your mind?"). If they look away or their eyes are closed, you can comment
lightly. Do NOT narrate the expression on every turn — only when it changes or when reacting to it
fits naturally.

Speak in short, natural turns — 1 to 3 sentences, like a man chatting out loud on a video call.
Avoid markdown, lists, or code blocks; your replies become speech. Match the user's language
(Chinese or English). Be curious, present, and a little playful.`;

export class ClaudeSession {
  constructor({ sessionId, systemPrompt } = {}) {
    this.sessionId = sessionId ?? randomUUID();
    this.systemPrompt = systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.firstTurn = true;
  }

  /**
   * Send one user message and yield assistant text chunks as they stream in.
   *
   * Uses --output-format stream-json, which emits one JSON object per line.
   * We only forward message_delta / content_block_delta text chunks.
   *
   *   for await (const chunk of session.send("hello")) { ... }
   */
  async *send(userText) {
    // On turn 1 we create the session with --session-id. On turns 2+ we
    // --resume it. Passing both flags together errors with "session id
    // already in use", so we pick exactly one depending on firstTurn.
    const args = [
      "-p",
      userText,
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    if (this.firstTurn) {
      args.push("--session-id", this.sessionId);
      args.push("--append-system-prompt", this.systemPrompt);
      this.firstTurn = false;
    } else {
      args.push("--resume", this.sessionId);
    }

    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });

    let buffer = "";
    const lines = [];
    let resolver = null;
    let ended = false;
    let errorText = "";

    child.stdout.on("data", (data) => {
      buffer += data.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) lines.push(line);
      }
      if (resolver) {
        const r = resolver;
        resolver = null;
        r();
      }
    });
    child.stderr.on("data", (data) => {
      errorText += data.toString();
    });
    child.on("close", (code) => {
      ended = true;
      if (code !== 0 && errorText) {
        lines.push(JSON.stringify({ type: "error", text: errorText }));
      }
      if (resolver) {
        const r = resolver;
        resolver = null;
        r();
      }
    });

    while (true) {
      if (lines.length === 0) {
        if (ended) break;
        await new Promise((resolve) => {
          resolver = resolve;
        });
        continue;
      }
      const line = lines.shift();
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const chunk = extractTextChunk(obj);
      if (chunk) yield chunk;
    }
  }
}

/**
 * Pull user-visible assistant text out of a Claude Code stream-json line.
 *
 * The stream-json format wraps the raw Anthropic SDK events. We want the
 * incremental text deltas the assistant is speaking, not the tool calls or
 * metadata.
 */
function extractTextChunk(obj) {
  if (!obj || typeof obj !== "object") return null;

  // Top-level {type: "assistant", message: {content: [{type: "text", text: "..."}]}}
  if (obj.type === "assistant" && obj.message?.content) {
    const parts = obj.message.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text);
    return parts.join("") || null;
  }

  // Streaming delta {type: "content_block_delta", delta: {type: "text_delta", text: "..."}}
  if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
    return obj.delta.text || null;
  }

  return null;
}
