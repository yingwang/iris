/**
 * iris — browser entry.
 *
 * Milestones wired so far:
 *   M1 text chat streaming over WebSocket
 *   M3 voice input: MediaRecorder → 16 kHz WAV → server whisper.cpp
 *
 * Not yet: Live2D avatar, Piper TTS playback, MediaPipe tracking.
 */

import { AudioRecorder, blobToBase64 } from "/audio.js";

const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const form = document.getElementById("compose");
const input = document.getElementById("input");
const micBtn = document.getElementById("mic");
const selfView = document.getElementById("self-view");

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
    case "error":
      appendBubble("assistant", `⚠️ ${msg.message}`);
      currentAssistantBubble = null;
      statusEl.textContent = `error: ${msg.message}`;
      break;
  }
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
  statusEl.textContent = "uploading audio…";
  ws.send(JSON.stringify({ type: "user_audio", data, language }));
}

// --- form submit --------------------------------------------------------

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  sendText(text);
  input.value = "";
});

// --- voice: record actual audio and let the server transcribe ----------

let recorder = null;
let recording = false;

async function startRecording() {
  if (recording) return;
  try {
    recorder = new AudioRecorder();
    await recorder.start();
    recording = true;
    micBtn.classList.add("recording");
    statusEl.textContent = "listening…";
  } catch (err) {
    console.error(err);
    statusEl.textContent = `mic error: ${err.message || err.name}`;
    recorder = null;
  }
}

async function stopRecording(shouldSend) {
  if (!recording || !recorder) return;
  recording = false;
  micBtn.classList.remove("recording");
  try {
    const wavBlob = await recorder.stop();
    if (shouldSend && wavBlob) await sendAudio(wavBlob);
    else statusEl.textContent = "ready";
  } catch (err) {
    console.error(err);
    statusEl.textContent = `recorder error: ${err.message || err.name}`;
  } finally {
    recorder = null;
  }
}

// Mic button: press-and-hold to record, release to send.
micBtn.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  startRecording();
});
micBtn.addEventListener("pointerup", () => stopRecording(true));
micBtn.addEventListener("pointercancel", () => stopRecording(false));
micBtn.addEventListener("pointerleave", () => {
  if (recording) stopRecording(true);
});

// Space bar: hold to record, release to send — only when focus is
// outside the text input (otherwise Space inserts a space).
window.addEventListener("keydown", (ev) => {
  if (ev.code !== "Space" || ev.repeat) return;
  if (document.activeElement === input) return;
  ev.preventDefault();
  startRecording();
});
window.addEventListener("keyup", (ev) => {
  if (ev.code !== "Space") return;
  if (document.activeElement === input) return;
  ev.preventDefault();
  stopRecording(true);
});

// --- webcam (self-view only for now) ------------------------------------

async function initWebcam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240 },
      audio: false,
    });
    selfView.srcObject = stream;
  } catch (err) {
    console.warn("webcam unavailable:", err);
  }
}

// --- boot ---------------------------------------------------------------

connect();
initWebcam();
