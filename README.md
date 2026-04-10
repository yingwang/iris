# iris

A voice + video AI companion. Claude as the brain, Live2D as the face, real-time conversation in the browser. You just talk, iris sees you, hears you, and talks back with lip-synced animation.

## Architecture

```
┌─────────────── browser ───────────────┐         ┌──────── server ────────┐
│ PIXI + pixi-live2d (Haru Live2D)      │         │ Fastify + WebSocket    │
│ MediaPipe Face Landmarker             │ ◄─ WS ─►│ Claude Code CLI child  │
│ Silero VAD (continuous mic)           │         │ whisper.cpp (STT)      │
│ Web Audio TTS playback + RMS lip sync │         │ edge-tts (TTS)         │
└───────────────────────────────────────┘         └────────────────────────┘
```

- **Brain**: Claude Code CLI (`claude -p … --output-format stream-json`) as a subprocess. Uses your existing Claude subscription — no API key needed.
- **STT**: whisper.cpp (`ggml-tiny.bin` by default) running locally on CPU with Whisper language auto-detect, so English and Chinese both work with no toggle.
- **TTS**: [edge-tts](https://github.com/rany2/edge-tts) — a Python CLI that talks to Microsoft Edge's neural voice backend. Free, no API key, needs internet. Defaults to `en-US-AvaNeural` / `zh-CN-XiaoxiaoNeural`.
- **Voice activity**: Silero VAD via `@ricky0123/vad-web` runs the neural VAD in an AudioWorklet so you can just talk without pressing anything. VAD is automatically muted while iris is speaking to stop her from transcribing her own voice.
- **Avatar**: Live2D Cubism 4 via `pixi-live2d-display`. Loads the Haru sample model from jsdelivr; Cubism Core is loaded from live2d.com (required). Claude can emit `<expr:happy>`, `<expr:surprised>`, `<expr:sad>`, etc. inline and the avatar's expression morphs accordingly.
- **Tracking**: MediaPipe Face Landmarker produces a 52-blendshape snapshot every frame. The snapshot is sent with each user turn as a natural-language prefix (`[The user looks smiling, grinning broadly.]`) so Claude can react to your face.
- **Lip sync**: Web Audio AnalyserNode reads RMS off the TTS stream and writes `ParamMouthOpenY` on the Live2D model, so iris's mouth moves in sync with what she's saying.

## Roadmap

- [x] M1 — text chat: WebSocket → Claude Code CLI → streaming text back to browser
- [x] M2 — webcam + MediaPipe Face Landmarker: live blendshape snapshot sent as prompt context
- [x] M3 — voice in: Silero VAD continuous capture → whisper.cpp → text → Claude (no button)
- [x] M4 — voice out: sentence-by-sentence macOS `say` → WAV → Web Audio playback
- [x] M5 — Live2D avatar: Haru sample loads via pixi-live2d-display
- [x] M6 — lip sync: AnalyserNode RMS on TTS stream → `ParamMouthOpenY`
- [x] M7 — expression mirror: user's smile → avatar's `ParamMouthForm`

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

`install-whisper.sh` disables the Metal backend (`-DGGML_METAL=OFF`) because
Metal produced garbled output on Intel Macs. If you're on Apple Silicon,
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

