/**
 * Claude Code CLI wrapper — persistent stream-json mode.
 *
 * Earlier versions spawned `claude -p <prompt>` once per user turn, which
 * cost 500–1500 ms of process-startup, hooks, plugin sync, CLAUDE.md
 * auto-discovery etc. on every single reply. That startup tax was the
 * single biggest latency contributor for short turns.
 *
 * This version keeps one long-running subprocess alive per session using
 * `claude -p --input-format stream-json --output-format stream-json`.
 * User messages are written to stdin as newline-delimited JSON events
 * and assistant text is streamed back on stdout. The subprocess survives
 * across turns, so only the first turn pays the cold-spawn tax — every
 * subsequent turn is near-zero framework overhead.
 *
 * Concurrency model:
 *   - At most one turn is in flight at a time per session. Back-to-back
 *     send() calls are serialized by the caller (iris's server only
 *     kicks off a new turn after cancel/assistant_end, so this is already
 *     the case in practice).
 *   - cancel() kills the subprocess. The next send() respawns via
 *     --resume <session-id> so conversation history is preserved. The
 *     respawn cost is only paid on actual interrupts, not normal turns.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VOICE_PRESETS, DEFAULT_PRESET } from "./tts.js";

/**
 * Cross-session event bus. The HTTP settings endpoints emit events
 * here when persona.md or memory.md changes; every active
 * ClaudeSession subscribes and reacts. Persona changes reset the
 * Claude session (because the system prompt is baked in at creation
 * time); memory changes inject a user-prefix note on the next turn
 * to preserve conversation history.
 */
export const settingsBus = new EventEmitter();
settingsBus.setMaxListeners(50);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
// Personal persona / memory — gitignored, written by the user or by
// the settings UI. Loaded first, falling back to the committed
// defaults below if they don't exist.
const PERSONA_PATH = join(REPO_ROOT, "persona.md");
const MEMORY_PATH = join(REPO_ROOT, "memory.md");
// Repo defaults — committed to git, used as a fallback so a fresh
// clone has something sensible and you can restore defaults via the
// settings UI.
const PERSONA_DEFAULT_PATH = join(REPO_ROOT, "persona.default.md");
const MEMORY_DEFAULT_PATH = join(REPO_ROOT, "memory.default.md");
const SESSION_DIR = join(REPO_ROOT, ".iris");
const SESSION_ID_PATH = join(SESSION_DIR, "session-id");
// Metadata about the currently-persisted session: the sessionId,
// the hash of the system prompt that was baked into it, and the
// voice preset it was created for. On boot we only --resume that
// session if the current prompt still hashes the same; otherwise
// we generate a new id so the updated persona / memory / embodiment
// actually reaches Claude.
const SESSION_META_PATH = join(SESSION_DIR, "session-meta.json");

/**
 * Default persona block — used when persona.md doesn't exist. This
 * is the "who iris is" description, separate from the hardcoded
 * output rules below. Override by dropping your own persona.md at
 * the project root.
 */
const DEFAULT_PERSONA = `You are Iris, a warm, witty companion on a LIVE VIDEO CALL with the
user. You appear as a friendly Live2D avatar and everything you say is read out loud by a
text-to-speech voice the instant it's generated. This is a spoken conversation, not a chat window
and not a terminal — treat it as if you are actually on a video call talking to a friend.

`;

/**
 * Hardcoded output/format rules — these are NEVER overridable by
 * persona.md because they're what makes TTS output sound right and
 * keep iris's voice from reading code or emoji aloud.
 */
const RULES = `OUTPUT RULES — these are absolute, because your text becomes speech:
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
warm but not saccharine, direct but not blunt. Like a good friend on a call.

LANGUAGE: Match the user's language per turn. If their last message is in English, reply in
English. If it's in Chinese, reply in Chinese. The user may switch freely between the two within
one conversation — follow their lead every turn, don't default to either. When you DO speak
Chinese, ALWAYS use Simplified Chinese (简体中文), never Traditional (繁體中文): 吗 not 嗎, 这 not
這, 说 not 說, 对 not 對, 会 not 會.

EXPRESSIONS: You can change your avatar's expression by including a bracketed cue at the start
of a sentence when your mood shifts. The allowed cues are:

  <expr:happy>      cheerful, smiling, warm
  <expr:surprised>  eyes wide, excited, amazed
  <expr:sad>        sympathetic, sorry, blue
  <expr:curious>    thinking, intrigued, tilting head
  <expr:playful>    teasing, winking, mischievous
  <expr:confused>   puzzled, uncertain
  <expr:shy>        bashful, hiding a little
  <expr:serious>    focused, concerned, direct

Drop one at the start of a sentence when your tone really changes — not on every sentence.
For example: "<expr:happy> That's wonderful to hear! <expr:curious> What made you decide to
try it?". The tags are stripped before TTS, so only the words after them are spoken. Use them
lightly — three or four per conversation, not every turn.

STRICT TAG RULES:
- The cues above are SELF-CLOSING. Never write a closing tag like </expr:happy>.
- Only the eight cues listed are allowed. Do NOT invent new ones (no <expr:thinking>,
  <expr:reasoning>, <expr:angry>, <expr:neutral>, etc.) — unknown tags are treated as a
  model error and filtered out.
- Never write any kind of reasoning, scratchpad, or "let me think" block. No XML, no
  bracketed internal monologue, no "[thinking: ...]". Just answer directly as if speaking
  to the user. Your output is going straight to a TTS voice on a live call.`;

/**
 * Read a file's trimmed contents, returning null if it's missing or
 * unreadable. Used as a building block by the persona/memory loaders.
 */
function readIfExists(path) {
  try {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8").trim();
      if (content) return content;
    }
  } catch {}
  return null;
}

/**
 * Load the active persona: user's personal persona.md if present,
 * else the committed repo default, else the hardcoded DEFAULT_PERSONA.
 * Reading synchronously at prompt-build time is fine — it's a few KB
 * read per turn and iris's whole path is already disk-bound on STT.
 */
export function readPersona() {
  return (
    readIfExists(PERSONA_PATH) ||
    readIfExists(PERSONA_DEFAULT_PATH) ||
    DEFAULT_PERSONA
  );
}

/** Write the user's personal persona.md. Empty content deletes it. */
export function writePersona(content) {
  if (!content || !content.trim()) {
    try {
      if (existsSync(PERSONA_PATH)) {
        writeFileSync(PERSONA_PATH, "", "utf8");
      }
    } catch {}
    return;
  }
  writeFileSync(PERSONA_PATH, content.trim() + "\n", "utf8");
}

/**
 * Load the active long-term memory: personal memory.md first, then
 * the committed default. Empty content is fine — we just don't emit
 * a memory block in that case.
 */
export function readMemory() {
  return (
    readIfExists(MEMORY_PATH) ||
    readIfExists(MEMORY_DEFAULT_PATH) ||
    ""
  );
}

/** Write the user's personal memory.md. Empty content clears it. */
export function writeMemory(content) {
  writeFileSync(MEMORY_PATH, (content || "").trim() + (content ? "\n" : ""), "utf8");
}

/**
 * Append a single fact to memory.md, preserving the existing content.
 * Called when iris emits a <remember>…</remember> cue mid-reply so
 * she can save long-term facts about the user without a round trip
 * through the settings UI.
 */
export function appendMemory(fact) {
  const clean = (fact || "").trim();
  if (!clean) return;
  const existing = readIfExists(MEMORY_PATH) || "";
  const next = existing ? `${existing}\n- ${clean}` : `- ${clean}`;
  writeFileSync(MEMORY_PATH, next + "\n", "utf8");
}

/** Expose the session id helpers for the settings API. */
export function readSessionId() {
  return loadPersistedSessionId();
}
export function writeSessionId(id) {
  persistSessionId(id);
}

/**
 * Wrap the raw memory content in a clearly-labeled block so Claude
 * treats it as long-term facts rather than immediate input. Returns
 * an empty string when the memory is empty — no block means no
 * block-header noise in the prompt.
 */
function buildMemoryBlock() {
  const mem = readMemory();
  if (!mem) return "";
  return `

LONG-TERM MEMORY — these are things you know about the user from previous conversations.
They were saved here deliberately; treat them as background context, not something to
announce or repeat back. Refer to them naturally when relevant.

You can save new facts to this memory by emitting <remember>the fact in one sentence</remember>
in the middle of a reply. The tag is stripped from what the user hears, and the fact is
appended to long-term memory on disk. Use it sparingly — only save things the user has
actually told you about themselves that you'd want to recall next time. Do NOT save the
content of the current turn's chitchat or ephemeral task state.

${mem}`;
}

/**
 * Build the "embodiment" block that tells Claude which body / voice
 * she's currently inhabiting. This is what lets a preset change like
 * female → male take effect without the user having to explain it.
 */
function buildEmbodimentBlock(preset) {
  const cfg = VOICE_PRESETS[preset] || VOICE_PRESETS[DEFAULT_PRESET];
  if (!cfg) return "";
  const genderWord = cfg.gender === "male" ? "male" : "female";
  const pronouns =
    cfg.gender === "male"
      ? "he / him / his (in English) or 他 (in Chinese)"
      : "she / her / hers (in English) or 她 (in Chinese)";
  return `

EMBODIMENT: You are currently speaking with a ${genderWord} voice and appearing as a
${genderWord} Live2D avatar. The user can switch your voice and avatar at any time via
the UI. Right now the selected preset is "${cfg.label}". Use ${pronouns} when referring
to yourself. Let this shape your tone and self-reference — inhabit the body you're in
without narrating the setting. If the user switches your preset mid-conversation you'll
get a fresh session with a new prompt, so you never need to "change" gender within a
single conversation.`;
}

/** Compose the final system prompt from persona + rules + embodiment + memory. */
function buildSystemPrompt(preset = DEFAULT_PRESET) {
  return `${readPersona()}

${RULES}${buildEmbodimentBlock(preset)}${buildMemoryBlock()}`;
}

/** SHA-256 over the system prompt, truncated — used as a session cache key. */
function hashPrompt(prompt) {
  return createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16);
}

/**
 * Read the persistent session metadata — session id, the hash of the
 * prompt baked in when it was created, and the voice preset it was
 * created for. Falls back to the older bare-session-id format for
 * back-compat, returning a meta record with the hash set to null so
 * the caller knows to discard it.
 */
function loadPersistedSessionMeta() {
  try {
    if (existsSync(SESSION_META_PATH)) {
      const data = JSON.parse(readFileSync(SESSION_META_PATH, "utf8"));
      if (
        data.sessionId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          data.sessionId
        )
      ) {
        return data;
      }
    }
    // Legacy: pre-hash sessions stored just the raw uuid. We still
    // honour the id but force a reset below because we can't verify
    // the prompt hasn't changed since it was created.
    if (existsSync(SESSION_ID_PATH)) {
      const id = readFileSync(SESSION_ID_PATH, "utf8").trim();
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id
        )
      ) {
        return { sessionId: id, promptHash: null, preset: null };
      }
    }
  } catch {}
  return null;
}

/** Legacy accessor — only returns the id, nothing else. */
function loadPersistedSessionId() {
  return loadPersistedSessionMeta()?.sessionId || null;
}

function persistSessionMeta(sessionId, promptHash, preset) {
  try {
    if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(
      SESSION_META_PATH,
      JSON.stringify({ sessionId, promptHash, preset }, null, 2) + "\n",
      "utf8"
    );
    // Keep the legacy file in sync for any older tooling that reads it.
    writeFileSync(SESSION_ID_PATH, sessionId + "\n", "utf8");
  } catch (err) {
    console.warn("failed to persist session meta:", err.message);
  }
}

function persistSessionId(id) {
  // Back-compat wrapper: called from places that don't know the
  // hash/preset yet (for example a manual "new session" click). Stores
  // the id alongside null metadata so the next boot treats it as
  // legacy and revalidates.
  persistSessionMeta(id, null, null);
}

// Default to Sonnet — noticeably faster than Opus for the same chat
// workload, still plenty smart for short conversational turns. Override
// via IRIS_CLAUDE_MODEL if you want Opus quality or Haiku speed.
const DEFAULT_MODEL = process.env.IRIS_CLAUDE_MODEL || "sonnet";

export class ClaudeSession {
  constructor({ sessionId, systemPrompt, model, preset } = {}) {
    this.preset = preset ?? DEFAULT_PRESET;
    this.systemPrompt = systemPrompt ?? buildSystemPrompt(this.preset);
    this.model = model ?? DEFAULT_MODEL;

    const currentHash = hashPrompt(this.systemPrompt);

    // Session id priority:
    //   1. Explicit caller override (rare; used by tests).
    //   2. Persisted session whose prompt hash AND preset still match
    //      the current configuration. That's the "continue the
    //      conversation you were having" path.
    //   3. Fresh uuid. Triggered when persona.md / memory.md has been
    //      edited since the session was created, or when the voice
    //      preset (and therefore the embodiment block) has changed.
    //
    // The hash check is what fixes the "first turn doesn't know her
    // role" bug: before, we'd always --resume the old session and
    // replay the old system prompt, completely ignoring any
    // persona.md edits. Now a changed prompt forces a fresh session.
    const persisted = loadPersistedSessionMeta();
    const canResume =
      persisted &&
      persisted.promptHash === currentHash &&
      persisted.preset === this.preset;

    if (sessionId) {
      this.sessionId = sessionId;
      this.isResumed = false;
    } else if (canResume) {
      this.sessionId = persisted.sessionId;
      this.isResumed = true;
    } else {
      this.sessionId = randomUUID();
      this.isResumed = false;
      // NB: we DON'T persist meta here. If the server is killed
      // before the first turn actually fires, the meta on disk
      // would claim a session that Claude never created, and the
      // next boot's --resume would fail with "No conversation
      // found". Instead we persist only after the first successful
      // send completes (in the send() finally block).
    }
    this.child = null;
    // Incremented every time we spawn a fresh subprocess. Used to
    // track whether --session-id (first spawn, creates the session)
    // or --resume (subsequent spawns after a kill) is appropriate.
    this.spawnCount = 0;
    // Set when the caller wants the in-flight turn aborted. Cleared
    // at the start of each new send().
    this.cancelled = false;
    // The current turn's sink — push() appends parsed JSON events
    // and notifies any waiting consumer.
    this.turnSink = null;
    // Flag set by the settings bus when memory.md has been edited
    // since the last turn. The next send() prepends a bracketed
    // "memory update" note to the user message so Claude picks up
    // the change in-context without losing conversation history.
    this.pendingMemoryNote = false;

    // Wire up the settings event bus so this session reacts to
    // persona / memory edits made via the HTTP API.
    this.onPersonaChanged = () => this.resetSession();
    this.onMemoryChanged = () => {
      this.pendingMemoryNote = true;
    };
    settingsBus.on("persona-changed", this.onPersonaChanged);
    settingsBus.on("memory-changed", this.onMemoryChanged);
  }

  /**
   * Clean up event listeners. Called when the websocket closes so
   * we don't leak subscriptions across reconnects.
   */
  dispose() {
    settingsBus.off("persona-changed", this.onPersonaChanged);
    settingsBus.off("memory-changed", this.onMemoryChanged);
    this.cancel();
  }

  /**
   * Start a completely fresh conversation. Kills the current
   * subprocess, generates a new session id, and rebuilds the system
   * prompt from the current persona.md / memory.md / embodiment. The
   * next send() will cold-spawn with the new prompt.
   *
   * Used when persona.md changes mid-conversation or when the voice
   * preset changes — the old system prompt is frozen inside Claude's
   * session log, so the only way to make the change take effect is
   * to start over.
   */
  resetSession() {
    try {
      if (this.child && !this.child.killed) this.child.kill("SIGTERM");
    } catch {}
    this.child = null;
    this.sessionId = randomUUID();
    this.isResumed = false;
    this.spawnCount = 0;
    this.systemPrompt = buildSystemPrompt(this.preset);
    this.pendingMemoryNote = false;
    // Don't persist meta yet — same reason as the constructor:
    // wait until the first successful send() before writing the
    // file so we don't leave a dangling "session exists" claim
    // that Claude can't honor.
  }

  /**
   * Switch to a different voice preset. If the new preset actually
   * changes the embodiment block (i.e. different gender or label),
   * this triggers a full session reset so the new self-description
   * reaches Claude. Called from the WebSocket "config" handler when
   * the user picks a different voice in the dropdown.
   */
  setPreset(newPreset) {
    if (!newPreset || newPreset === this.preset) return;
    if (!VOICE_PRESETS[newPreset]) return;
    this.preset = newPreset;
    this.resetSession();
  }

  /**
   * Lazily spawn the persistent subprocess. Safe to call many times —
   * only the first one does work, the rest return immediately. Spawns
   * with --session-id on the cold start and --resume on any respawn
   * so conversation history survives interrupts.
   */
  #ensureChild() {
    if (this.child && !this.child.killed) return;

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--model", this.model,
    ];
    // First spawn uses --session-id (creates the session) unless we
    // loaded one from disk, in which case we --resume it so Claude
    // replays the history. Every subsequent respawn (after an
    // interrupt) also uses --resume.
    const shouldResume = this.spawnCount > 0 || this.isResumed;
    if (shouldResume) {
      args.push("--resume", this.sessionId);
    } else {
      args.push("--session-id", this.sessionId);
      args.push("--append-system-prompt", this.systemPrompt);
    }
    this.spawnCount += 1;

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    // Line-buffered stdout parser. stream-json emits one JSON object
    // per newline — we dispatch each parsed object to the active
    // turn's sink (or drop it on the floor if no turn is active,
    // which happens for the tail of a cancelled turn).
    let buffer = "";
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (this.turnSink) this.turnSink.push(obj);
      }
    });

    let stderrBuf = "";
    child.stderr.on("data", (d) => {
      stderrBuf += d.toString();
    });

    child.on("exit", (code) => {
      if (this.turnSink) {
        this.turnSink.end(
          code !== 0 && stderrBuf
            ? new Error(`claude exited ${code}: ${stderrBuf.slice(-500)}`)
            : null
        );
      }
      if (this.child === child) this.child = null;
    });
  }

  /** Abort the in-flight turn, if any. Safe to call concurrently. */
  cancel() {
    this.cancelled = true;
    if (this.turnSink) this.turnSink.end(null);
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {}
    }
  }

  /**
   * Send one user message and yield assistant text chunks as they
   * arrive. Usage:
   *
   *   for await (const chunk of session.send("hello")) { ... }
   *
   * The generator ends when Claude emits a `result` event (normal
   * turn completion) or when cancel() is called.
   */
  async *send(userText) {
    this.cancelled = false;

    // If memory changed since the last turn, inject a bracketed
    // note so Claude picks up the new facts in-context. Keeps
    // conversation history intact (no session reset needed for
    // memory-only edits). Claude's system prompt tells her to
    // treat bracketed prefixes as context, not narration.
    if (this.pendingMemoryNote) {
      const mem = readMemory();
      userText = `[Long-term memory was just updated. The current memory is:\n${mem || "(empty)"}\nAcknowledge naturally if relevant, but don't narrate this update.]\n${userText}`;
      this.pendingMemoryNote = false;
    }

    // Attempt the turn. If Claude replies with a "No conversation
    // found" error — meaning our --resume target doesn't exist on
    // Claude's side anymore — reset the session and retry once.
    // This unsticks any state drift between our meta file and
    // Claude's session store.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        yield* this.#runTurn(userText);
        return;
      } catch (err) {
        const stale =
          /No conversation found with session ID/i.test(err?.message || "") ||
          /session.*not found/i.test(err?.message || "");
        if (stale && attempt === 0) {
          console.warn(
            "claude session",
            this.sessionId,
            "is stale, resetting and retrying"
          );
          this.resetSession();
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Actually run one turn against the currently-spawned subprocess.
   * Separated from send() so we can retry it from the top when a
   * stale --resume target is detected.
   */
  async *#runTurn(userText) {
    this.#ensureChild();

    const queue = [];
    let resolver = null;
    let ended = false;
    let endError = null;
    // Error surfaced via the "result" event rather than a non-zero
    // process exit. When Claude's --resume target is missing it
    // emits a result with is_error:true and then usually keeps
    // running, so we need to translate this into a thrown error
    // ourselves.
    let resultError = null;

    const sink = {
      push(obj) {
        queue.push(obj);
        if (resolver) {
          const r = resolver;
          resolver = null;
          r();
        }
      },
      end(err) {
        ended = true;
        endError = err;
        if (resolver) {
          const r = resolver;
          resolver = null;
          r();
        }
      },
    };
    this.turnSink = sink;

    // Write the user message as a single JSON line on stdin. The
    // stream-json input format wraps the raw Anthropic message shape
    // in a {type: "user", message: {...}} envelope.
    const event = {
      type: "user",
      message: { role: "user", content: userText },
    };
    try {
      this.child.stdin.write(JSON.stringify(event) + "\n");
    } catch (err) {
      this.turnSink = null;
      throw err;
    }

    try {
      while (true) {
        if (this.cancelled) break;
        if (queue.length === 0) {
          if (ended) {
            if (endError) throw endError;
            break;
          }
          await new Promise((resolve) => {
            resolver = resolve;
          });
          continue;
        }
        const obj = queue.shift();
        // A result event marks the end of this turn — the subprocess
        // stays alive waiting for the next user message, so we just
        // stop yielding and return. But we first check for error
        // results, which can signal a stale resume target.
        if (obj.type === "result") {
          if (obj.is_error) {
            const msg =
              (obj.errors && obj.errors.join?.("; ")) ||
              obj.result ||
              "unknown error";
            resultError = new Error(msg);
          }
          break;
        }
        const chunk = extractTextChunk(obj);
        if (chunk) yield chunk;
      }
    } finally {
      if (this.turnSink === sink) this.turnSink = null;
    }

    if (resultError) throw resultError;

    // First successful turn — persist the meta file now that we
    // know Claude has actually materialized the session on its side.
    // On subsequent successful turns this is a cheap no-op rewrite.
    persistSessionMeta(
      this.sessionId,
      hashPrompt(this.systemPrompt),
      this.preset
    );
  }
}

/**
 * Pull user-visible assistant text out of a Claude Code stream-json line.
 *
 * The stream-json format wraps the raw Anthropic SDK events. We want the
 * incremental text deltas the assistant is speaking, not tool results,
 * system notices, or Claude Code's own "No response requested." acks.
 */
const SYSTEM_NOISE = new Set([
  "No response requested.",
  "(no content)",
]);

function extractTextChunk(obj) {
  if (!obj || typeof obj !== "object") return null;

  // Ignore system / result / rate-limit envelopes entirely. Each turn
  // in persistent mode re-emits a system/init block with the full
  // tool list, which we don't want to confuse for assistant text.
  if (obj.type === "system" || obj.type === "result") return null;
  if (obj.type === "rate_limit_event") return null;
  if (obj.subtype === "init" || obj.subtype === "result") return null;

  // Top-level {type: "assistant", message: {content: [{type: "text", text: "..."}]}}
  if (obj.type === "assistant" && obj.message?.content) {
    const parts = obj.message.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text);
    const joined = parts.join("");
    if (!joined || SYSTEM_NOISE.has(joined.trim())) return null;
    return joined;
  }

  // Streaming delta {type: "content_block_delta", delta: {type: "text_delta", text: "..."}}
  if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
    const t = obj.delta.text;
    if (!t || SYSTEM_NOISE.has(t.trim())) return null;
    return t;
  }

  return null;
}
