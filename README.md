# iris

A voice + video AI companion. Claude as the brain, Live2D as the face, real-time conversation in the browser.

Status: **early scaffolding** — only text chat streaming works today. Roadmap below.

## Architecture

```
┌──────── browser ────────┐         ┌──────── server ────────┐
│ PIXI + pixi-live2d      │         │ Fastify + WebSocket    │
│ MediaPipe Holistic      │ ◄─ WS ─►│ Claude Code CLI child  │
│ WebRTC audio capture    │         │ Whisper (STT)          │
│ Web Audio TTS playback  │         │ Piper (TTS)            │
└─────────────────────────┘         └────────────────────────┘
```

- **Brain**: Claude Code CLI (`claude -p … --output-format stream-json`) as a subprocess. Uses your existing Claude subscription — no API key needed.
- **STT**: whisper.cpp (base.ggml) running locally on CPU. See `install-whisper.sh`.
- **TTS**: macOS built-in `say` command, because Piper's macOS x64 release is broken (missing dylibs). Tingting for Chinese, Samantha for English — both are neural voices that sound fine. Apple Silicon users can swap in Piper later.
- **Avatar**: Live2D Cubism via `pixi-live2d-display` (not wired yet).
- **Tracking**: MediaPipe Holistic for user face + driving the avatar's blendshape-like parameters (not wired yet).

## Roadmap

- [x] M1 — text chat: WebSocket → Claude Code CLI → streaming text back to browser
- [x] M3 — voice in: mic capture → WAV encode → server whisper.cpp → text → Claude
- [x] M4 — voice out: sentence-by-sentence macOS `say` → WAV → Web Audio playback
- [ ] M2 — webcam preview + MediaPipe Holistic tracking (user face only)
- [ ] M5 — Live2D avatar: load a free model, basic idle animation
- [ ] M6 — lip sync: drive mouth params from TTS audio amplitude / phonemes
- [ ] M7 — expressions: map MediaPipe face blendshapes onto Live2D parameters

## Running today (M1 + M3)

Prereqs:
- Node 20+
- `claude` CLI installed and logged in (`claude` works in your terminal)
- Xcode Command Line Tools (for building whisper.cpp)
- CMake

```bash
# 1. Build whisper.cpp and download the base model (~142 MB)
./scripts/install-whisper.sh

# 2. Install node deps
npm install

# 3. Start the server
npm run dev
# open http://localhost:3000
```

Text: type in the chat box — the server spawns `claude -p` with a streaming
session, forwards text back over the WebSocket. Same session id across turns
so conversation context is preserved.

Voice: hold the mic button or the Space key (when the text input isn't
focused). The browser records audio, resamples to 16 kHz mono, wraps it in
a WAV header, and sends it over WebSocket as base64. The server pipes it
to `whisper-cli` which prints the transcription, and the transcription
feeds Claude like any other message.

### Note on Metal / Apple Silicon

`install-whisper.sh` disables the Metal backend (`-DGGML_METAL=OFF`). On this
Intel iMac 2019 Metal produced garbled output. If you're on Apple Silicon,
remove that flag from the script to get GPU acceleration — it'll be much
faster.

## Layout

```
iris/
├── server/
│   ├── index.js         Fastify + WebSocket entry
│   └── claude.js        Claude CLI subprocess wrapper
├── web/public/
│   ├── index.html       Chat + stage markup
│   ├── style.css
│   └── main.js          Browser client (WebSocket, webcam)
├── models/              Live2D models go here (later)
├── scripts/             Setup scripts for Whisper/Piper binaries (later)
└── package.json
```

## Not a product

iris is a personal tool that wraps the officially-supported `claude -p` CLI so the user can talk to Claude with their own hands-free setup. It is not a proxy, not a SaaS, and should not be sold or redistributed — that would violate Anthropic's subscription terms. Keep it for yourself.
