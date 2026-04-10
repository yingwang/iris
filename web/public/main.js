/**
 * iris — browser entry.
 *
 * Milestones wired so far:
 *   M1 text chat streaming over WebSocket
 *   M3 voice input: MediaRecorder → 16 kHz WAV → server whisper.cpp
 *
 * Not yet: Live2D avatar, Piper TTS playback, MediaPipe tracking.
 */

import { blobToBase64 } from "/audio.js";
import { VADRecorder } from "/vad.js";
import { FaceTracker } from "/face.js";
import { AvatarStage } from "/stage.js";

const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const form = document.getElementById("compose");
const input = document.getElementById("input");
const micBtn = document.getElementById("mic");
const selfView = document.getElementById("self-view");
const avatarCanvas = document.getElementById("avatar");

// --- WebSocket ----------------------------------------------------------

let ws;
let currentAssistantBubble = null;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener("open", () => {
    statusEl.textContent = "connected · ready";
  });

  ws.addEventListener("close", () => {
    statusEl.textContent = "disconnected — reconnecting…";
    setTimeout(connect, 1500);
  });

  ws.addEventListener("error", () => {
    statusEl.textContent = "socket error";
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  });
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "stt_started":
      statusEl.textContent = "transcribing…";
      break;
    case "stt_result":
      appendBubble("user", msg.text);
      statusEl.textContent = "iris is thinking…";
      break;
    case "stt_empty":
      statusEl.textContent = "couldn't hear you — try again";
      break;
    case "assistant_chunk":
      if (!currentAssistantBubble) currentAssistantBubble = appendBubble("assistant", "");
      currentAssistantBubble.textContent += msg.text;
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      break;
    case "assistant_end":
      currentAssistantBubble = null;
      statusEl.textContent = "ready";
      break;
    case "tts_audio":
      enqueueTtsAudio(msg.data);
      break;
    case "error":
      appendBubble("assistant", `⚠️ ${msg.message}`);
      currentAssistantBubble = null;
      statusEl.textContent = `error: ${msg.message}`;
      break;
  }
}

// --- TTS playback queue ------------------------------------------------
//
// Server sends one base64 WAV per spoken sentence. We play them in order
// using a single AudioContext so there's no gap between sentences. The
// first play after a user gesture unlocks audio in most browsers — we
// prime the context on the first pointerdown anywhere.

let audioCtx = null;
const playQueue = [];
let playing = false;

function ensureAudioCtx() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audioCtx = new Ctx();
  return audioCtx;
}

window.addEventListener("pointerdown", () => {
  const ctx = ensureAudioCtx();
  if (ctx.state === "suspended") ctx.resume();
}, { once: false });

async function enqueueTtsAudio(base64) {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  playQueue.push(bytes.buffer);
  if (!playing) pumpPlayQueue();
}

// Also let main.js update the avatar expression based on the user's
// face — not just the mouth corners, but a named expression trigger
// when the user's mood changes noticeably.
let lastExpressionLabel = "neutral";
setInterval(() => {
  if (!faceTracker || !avatarStage?.ready) return;
  const snap = faceTracker.snapshot();
  if (snap.label !== lastExpressionLabel) {
    lastExpressionLabel = snap.label;
    avatarStage.setExpression(snap.label);
  }
}, 300);

async function pumpPlayQueue() {
  if (playing) return;
  playing = true;
  ttsSpeaking = true;
  // Mute mic while iris is talking so she doesn't hear herself.
  if (vadRecorder) vadRecorder.pause();

  while (playQueue.length > 0) {
    const ab = playQueue.shift();
    const blob = new Blob([ab], { type: "audio/wav" });
    try {
      // Prefer Live2D's built-in speak(): it plays audio AND drives
      // the mouth at the Cubism engine level, which plays nicer with
      // the motion manager than overwriting ParamMouthOpenY from an
      // outside ticker.
      if (avatarStage?.ready) {
        await avatarStage.speak(blob);
      } else {
        await playBlobViaWebAudio(blob);
      }
    } catch (err) {
      console.warn("tts playback failed:", err);
    }
  }

  playing = false;
  ttsSpeaking = false;
  // Give speakers a beat to settle, then unmute.
  setTimeout(() => {
    if (vadRecorder) vadRecorder.resume();
  }, 300);
}

async function playBlobViaWebAudio(blob) {
  const ctx = ensureAudioCtx();
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch {}
  }
  const ab = await blob.arrayBuffer();
  const buffer = await ctx.decodeAudioData(ab);
  await new Promise((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = resolve;
    src.start();
  });
}

function appendBubble(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  transcriptEl.appendChild(el);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return el;
}

function sendText(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  appendBubble("user", text);
  statusEl.textContent = "iris is thinking…";
  ws.send(JSON.stringify({ type: "user_text", text }));
}

async function sendAudio(wavBlob) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!wavBlob || wavBlob.size < 200) {
    statusEl.textContent = "recording too short";
    return;
  }
  const data = await blobToBase64(wavBlob);
  // Hint whisper about the primary language; "auto" also works.
  const language = (navigator.language || "").startsWith("zh") ? "zh" : "auto";
  const expression = faceTracker ? faceTracker.snapshot() : null;
  statusEl.textContent = "uploading audio…";
  ws.send(JSON.stringify({ type: "user_audio", data, language, expression }));
}

// --- form submit --------------------------------------------------------

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  sendText(text);
  input.value = "";
});

// --- continuous voice chat (Silero VAD) ---------------------------------

let vadRecorder = null;
let faceTracker = null;
let avatarStage = null;
let ttsSpeaking = false;

async function initVoice() {
  try {
    vadRecorder = new VADRecorder({
      onSpeechStart: () => {
        statusEl.textContent = "listening…";
        micBtn.classList.add("recording");
      },
      onSpeechEnd: async (wavBlob) => {
        micBtn.classList.remove("recording");
        statusEl.textContent = "transcribing…";
        await sendAudio(wavBlob);
      },
      onMisfire: () => {
        micBtn.classList.remove("recording");
        statusEl.textContent = "ready";
      },
    });
    await vadRecorder.start();
    statusEl.textContent = "listening for you · just talk";
  } catch (err) {
    console.error(err);
    statusEl.textContent = `mic error: ${err.message || err.name}`;
  }
}

// Toggle mic icon state for visual feedback. It's no longer a button to
// press; it's just an indicator.
micBtn.addEventListener("click", (ev) => {
  ev.preventDefault();
  if (!vadRecorder) return;
  if (vadRecorder.paused) {
    vadRecorder.resume();
    statusEl.textContent = "listening for you · just talk";
  } else {
    vadRecorder.pause();
    statusEl.textContent = "mic muted — click 🎙️ to resume";
  }
});

// --- webcam + face tracking ---------------------------------------------

async function initFace() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 480, height: 360 },
      audio: false,
    });
    selfView.srcObject = stream;
    await new Promise((r) => {
      if (selfView.readyState >= 2) r();
      else selfView.addEventListener("loadeddata", r, { once: true });
    });
    faceTracker = new FaceTracker(selfView);
    await faceTracker.start();
    // Mirror user expression onto the avatar: if you smile, iris
    // smiles back (subtly).
    setInterval(() => {
      if (!avatarStage || !faceTracker) return;
      const snap = faceTracker.snapshot();
      avatarStage.setSmile(0.5 + snap.smile * 0.5);
    }, 80);
  } catch (err) {
    console.warn("face tracking unavailable:", err);
  }
}

async function initAvatar() {
  try {
    avatarStage = new AvatarStage(avatarCanvas);
    await avatarStage.init();
    statusEl.textContent = "avatar ready · click anywhere to start";
  } catch (err) {
    console.error("avatar init failed:", err);
    statusEl.textContent = "avatar failed to load — text still works";
  }
}

// --- boot ---------------------------------------------------------------

connect();
initFace();
initAvatar();
// VAD needs a user gesture in most browsers — start it on the first click
// anywhere, which also unlocks the audio context.
window.addEventListener(
  "pointerdown",
  () => {
    if (!vadRecorder) initVoice();
  },
  { once: true }
);
