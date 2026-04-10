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
- **STT**: Whisper.cpp running locally (not wired yet).
- **TTS**: Piper running locally (not wired yet).
- **Avatar**: Live2D Cubism via `pixi-live2d-display` (not wired yet).
- **Tracking**: MediaPipe Holistic for user face + driving the avatar's blendshape-like parameters (not wired yet).

## Roadmap

- [x] M1 — text chat: WebSocket → Claude Code CLI → streaming text back to browser
- [ ] M2 — webcam preview + MediaPipe Holistic tracking (user face only)
- [ ] M3 — voice in: mic capture → Whisper local → send text to server
- [ ] M4 — voice out: Piper TTS on server → stream wav to browser → Web Audio playback
- [ ] M5 — Live2D avatar: load a free model, basic idle animation
- [ ] M6 — lip sync: drive mouth params from TTS audio amplitude / phonemes
- [ ] M7 — expressions: map MediaPipe face blendshapes onto Live2D parameters

## Running today (M1)

Prereqs:
- Node 20+
- `claude` CLI installed and logged in (`claude` works in your terminal)

```bash
npm install
npm run dev
# open http://localhost:3000
```

Type in the chat box — the server spawns `claude -p` with a streaming session, forwards text back over the WebSocket. Same session id across turns so conversation context is preserved.

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
