/**
 * iris — browser entry.
 *
 * Milestone 1 (this file): text chat over WebSocket streams from Claude CLI.
 * Next milestones add: webcam preview, Live2D avatar, Web Audio recording,
 * Whisper STT (WASM or server), Piper TTS playback, MediaPipe tracking.
 */

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

// --- UI events ----------------------------------------------------------

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  sendText(text);
  input.value = "";
});

// --- voice input (push-to-talk via Web Speech API) ----------------------
//
// Temporary M3: use the browser's built-in SpeechRecognition. It's less
// accurate than Whisper and needs a network round-trip to Google for
// Chrome, but it avoids installing whisper.cpp to get something working
// today. Real Whisper integration lands next.

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognizing = false;
let recognitionFinalText = "";

function initRecognition() {
  if (!SpeechRecognition) {
    micBtn.disabled = true;
    micBtn.title = "SpeechRecognition not supported (try Chrome)";
    return;
  }
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  // Match the user's browser language by default; fall back to zh-CN.
  recognition.lang = (navigator.language || "zh-CN").startsWith("zh")
    ? "zh-CN"
    : "en-US";

  recognition.onresult = (ev) => {
    let interim = "";
    recognitionFinalText = "";
    for (let i = 0; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) recognitionFinalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    input.value = recognitionFinalText + interim;
  };

  recognition.onerror = (ev) => {
    statusEl.textContent = `mic error: ${ev.error}`;
    stopRecognition(false);
  };

  recognition.onend = () => {
    if (recognizing) {
      // unexpected end — stop UI
      stopRecognition(false);
    }
  };
}

function startRecognition() {
  if (!recognition || recognizing) return;
  recognizing = true;
  recognitionFinalText = "";
  input.value = "";
  micBtn.classList.add("recording");
  statusEl.textContent = "listening…";
  try {
    recognition.start();
  } catch (err) {
    // Some browsers throw if start() is called too fast after stop()
    console.warn(err);
    recognizing = false;
    micBtn.classList.remove("recording");
  }
}

function stopRecognition(shouldSend) {
  if (!recognition) return;
  const wasRecognizing = recognizing;
  recognizing = false;
  micBtn.classList.remove("recording");
  try {
    recognition.stop();
  } catch {}
  if (!wasRecognizing) return;
  const text = input.value.trim();
  if (shouldSend && text) {
    sendText(text);
    input.value = "";
    recognitionFinalText = "";
  } else {
    statusEl.textContent = "ready";
  }
}

// Mic button: press-and-hold to record, release to send.
micBtn.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  startRecognition();
});
micBtn.addEventListener("pointerup", () => stopRecognition(true));
micBtn.addEventListener("pointercancel", () => stopRecognition(false));
micBtn.addEventListener("pointerleave", () => {
  if (recognizing) stopRecognition(true);
});

// Space bar: hold to record, release to send — but only when focus
// isn't in the text input (otherwise Space should insert a space).
window.addEventListener("keydown", (ev) => {
  if (ev.code !== "Space" || ev.repeat) return;
  if (document.activeElement === input) return;
  ev.preventDefault();
  startRecognition();
});
window.addEventListener("keyup", (ev) => {
  if (ev.code !== "Space") return;
  if (document.activeElement === input) return;
  ev.preventDefault();
  stopRecognition(true);
});

initRecognition();

// --- webcam (self-view only for now; MediaPipe tracking lands later) ----

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
