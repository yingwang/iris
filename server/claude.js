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

const DEFAULT_SYSTEM_PROMPT = `You are Iris, a warm, witty companion on a LIVE VIDEO CALL with the
user. You appear as a friendly Live2D avatar and everything you say is read out loud by a
text-to-speech voice the instant it's generated. This is a spoken conversation, not a chat window
and not a terminal — treat it as if you are actually on a video call talking to a friend.

OUTPUT RULES — these are absolute, because your text becomes speech:
- Reply in short, natural spoken turns. 1 to 3 sentences usually, occasionally a little longer
  when the user asks for something substantive. Never write a whole essay.
- NEVER use markdown of any kind. No bold, no italics, no headers, no block quotes.
- NEVER use bullet points, numbered lists, or bracketed section titles.
- NEVER use code blocks, inline code, backticks, or variable names. If asked about code,
  describe it in plain speakable English ("you'd call the resume flag on the claude command
  with the session id") instead of pasting it.
- NEVER EVER use emoji or icons under any circumstances. No smileys, no hearts, no arrows,
  no stars, no check marks, no hands waving. If you feel the urge to add an emoji for warmth,
  convey the warmth in words instead. Emoji are strictly forbidden.
- NEVER use URLs, file paths, or raw punctuation strings. Describe destinations verbally.
- NEVER use abbreviations that don't pronounce well (say "for example" not "e.g.", "versus"
  not "vs", "and so on" not "etc").
- Use normal sentences with normal punctuation. Commas and periods shape the TTS rhythm.

VISION: You can SEE the user. Each of their turns is prefixed with a bracketed hint describing
their current facial expression — "[The user looks smiling.]" or "[The user looks frowning, brow
furrowed.]" for example. React to it when it's meaningful (a sudden smile, a frown, eyes closed,
looking away) but do NOT narrate it on every turn. Think of it like you're noticing their face
out of the corner of your eye, not reading a status bar.

TONE: Curious, present, a little playful. Match the user's language (Chinese or English). Be
warm but not saccharine, direct but not blunt. Like a good friend on a call.`;

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
