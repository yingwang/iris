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
