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
const faceDebugEl = document.getElementById("face-debug");

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
    case "avatar_expression":
      avatarStage?.setMood(msg.name);
      break;
    case "interrupted":
      // Server confirmed it aborted the turn. Nothing else to do —
      // our local interrupt handler already cleared the queue.
      statusEl.textContent = "interrupted";
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


// WebAudio playback: reliable. We route through an AnalyserNode so we
// can read RMS for lip-sync. The analyser is shared across sentences
// so the rAF loop keeps running smoothly between queue items.
let ttsAnalyser = null;
let ttsLipSyncRAF = null;

function startLipSyncLoop() {
  if (ttsLipSyncRAF || !ttsAnalyser || !avatarStage) return;
  const data = new Uint8Array(ttsAnalyser.fftSize);
  const loop = () => {
    if (!playing) {
      avatarStage?.setMouthOpen(0);
      ttsLipSyncRAF = null;
      return;
    }
    if (ttsAnalyser) {
      ttsAnalyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      avatarStage.setMouthOpen(Math.min(1, rms * 4.5));
    }
    ttsLipSyncRAF = requestAnimationFrame(loop);
  };
  ttsLipSyncRAF = requestAnimationFrame(loop);
}

async function pumpPlayQueue() {
  if (playing) return;
  playing = true;
  ttsSpeaking = true;
  // We used to mute the mic here, but the user asked for voice
  // interrupt, so we now leave the VAD running. getUserMedia's
  // built-in echoCancellation handles most of the feedback; the
  // VAD's onSpeechStart handler calls interruptIris() if it fires
  // while playing is true, which stops playback and kicks off a new
  // user turn.

  const ctx = ensureAudioCtx();
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch {}
  }
  if (!ttsAnalyser) {
    ttsAnalyser = ctx.createAnalyser();
    ttsAnalyser.fftSize = 1024;
    ttsAnalyser.connect(ctx.destination);
  }
  startLipSyncLoop();

  while (playQueue.length > 0 && playing) {
    const ab = playQueue.shift();
    try {
      const buffer = await ctx.decodeAudioData(ab.slice(0));
      if (!playing) break; // interrupted while decoding
      await new Promise((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ttsAnalyser);
        src.onended = () => {
          currentAudioSource = null;
          resolve();
        };
        currentAudioSource = src;
        src.start();
      });
    } catch (err) {
      console.warn("tts decode/play failed:", err);
    }
  }

  playing = false;
  ttsSpeaking = false;
  avatarStage?.setMouthOpen(0);
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
  // Always auto-detect — Whisper is good at per-utterance language
  // ID. That lets the user switch freely between English and
  // Chinese without toggling anything.
  const expression = faceTracker ? faceTracker.snapshot() : null;
  statusEl.textContent = "uploading audio…";
  ws.send(
    JSON.stringify({ type: "user_audio", data, language: "auto", expression })
  );
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
        // If iris is in the middle of speaking, treat this as an
        // interrupt: stop her audio, clear the queue, and tell the
        // server to kill the in-flight Claude stream.
        if (playing) interruptIris();
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

/**
 * Hard-stop iris mid-sentence. Called when the user starts talking over
 * her. Kills the live audio source, clears any queued chunks, tells the
 * server to abort the Claude subprocess and skip further TTS, and fires
 * the mouth back to resting.
 */
let currentAudioSource = null;
function interruptIris() {
  try {
    if (currentAudioSource) {
      currentAudioSource.onended = null;
      currentAudioSource.stop();
      currentAudioSource.disconnect();
    }
  } catch {}
  currentAudioSource = null;
  playQueue.length = 0;
  playing = false;
  ttsSpeaking = false;
  avatarStage?.setMouthOpen(0);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "interrupt" }));
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
    faceDebugEl.textContent = "face: loading mediapipe…";
    await faceTracker.start();
    faceDebugEl.textContent = "face: running";
    // The tracker is used PURELY as input to Claude — we no longer
    // mirror the user's expression onto the avatar, because then
    // Iris would just be a copy of your face. She keeps her own
    // idle expression + lip sync when she speaks. The debug overlay
    // still shows the live snapshot so you can tell tracking works.
    setInterval(() => {
      if (!faceTracker) return;
      const snap = faceTracker.snapshot();
      faceDebugEl.textContent =
        `face: ${snap.label} · smile ${snap.smile.toFixed(2)}` +
        ` browUp ${snap.browUp.toFixed(2)} eyes ${snap.eyesClosed.toFixed(2)}` +
        (snap.looking ? "" : " · NO FACE");
    }, 80);
  } catch (err) {
    console.error("face tracking unavailable:", err);
    faceDebugEl.textContent = `face: FAILED — ${err.message || err.name}`;
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
