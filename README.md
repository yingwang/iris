# iris

A voice + video AI companion. Claude as the brain, Live2D as the face, real-time conversation in the browser. You just talk, iris sees you, hears you, and talks back with lip-synced animation.

## Architecture

```
┌─────────────── browser ───────────────┐         ┌──────── server ────────┐
│ PIXI + pixi-live2d (Haru / Mark)      │         │ Fastify + WebSocket    │
│ MediaPipe Face Landmarker             │ ◄─ WS ─►│ Persistent Claude CLI  │
│ Silero VAD (continuous mic)           │         │ whisper.cpp / Paraformer│
│ Web Audio TTS playback + RMS lip sync │         │ edge-tts (TTS)         │
└───────────────────────────────────────┘         └────────────────────────┘
```

- **Brain**: Claude Code CLI in persistent `--input-format stream-json` mode. One long-running subprocess per session handles every turn via stdin JSON, so only the first reply pays the cold-spawn tax. Defaults to `--model sonnet`; override with `IRIS_CLAUDE_MODEL=opus` for extra quality or `haiku` for extra speed. Uses your existing Claude subscription — no API key needed.
- **STT**: two engines, the UI picks:
  - **whisper.cpp** (`ggml-small-q5_1.bin`, ~181 MB, ~3 s per turn on CPU) — multilingual, handles English + Chinese + auto-detect with a strict en/zh script validator that retries on mis-IDs.
  - **Paraformer-zh** via `sherpa-onnx-node` (~232 MB ONNX, ~300–500 ms per turn) — state of the art for Mandarin. Routed automatically when you pick 中文 in the language selector. In-process C++ native addon, no Python sidecar.
- **TTS**: [edge-tts](https://github.com/rany2/edge-tts) — free, needs internet. Ships with both a female voice set (`en-US-AvaNeural` + `zh-CN-XiaoxiaoNeural`) and a male voice set (`en-US-AndrewNeural` + `zh-CN-YunxiNeural`). Speaking speed is user-configurable.
- **Voice activity**: Silero VAD via `@ricky0123/vad-web` — a neural VAD running in an AudioWorklet so you just talk without pressing anything. VAD stays running during iris's replies so you can interrupt her mid-sentence; a 1 s grace window after the start of TTS playback ignores echo leak.
- **Avatar**: Live2D Cubism 4 via `pixi-live2d-display`. Female persona uses the Haru sample; male uses Mark. Claude can emit `<expr:happy>`, `<expr:surprised>`, `<expr:sad>` etc. inline and the avatar's expression morphs. The avatar model URL can be overridden via `IRIS_AVATAR_FEMALE_URL` / `IRIS_AVATAR_MALE_URL` so you can drop in a custom 古风 Chinese character or anything else that ships as `.model3.json`.
- **Tracking**: MediaPipe Face Landmarker produces a 52-blendshape snapshot every frame. The snapshot is sent with each user turn as a natural-language prefix (`[The user looks smiling, grinning broadly.]`) so Claude can react to your expression.
- **Lip sync**: Web Audio AnalyserNode reads RMS off the TTS stream and writes `ParamMouthOpenY`, so the avatar's mouth moves in sync with what she's saying.

## Personality & memory

iris has two user-editable text files at the project root, both loaded into every Claude turn:

- **`persona.md`** — who iris is. Describe her voice, relationship to you, roleplay setting, anything that shouldn't change turn-to-turn. Edit freely; hardcoded output rules (no emoji / markdown / code blocks, because this is TTS) always stay on top.
- **`memory.md`** — long-term facts iris knows about you. Iris can add here automatically by emitting `<remember>fact in one sentence</remember>` in the middle of a reply; you can also edit it directly.

Both files are **gitignored**. The repo ships committed defaults at `persona.default.md` / `memory.default.md` which are used as fallbacks when the personal files are absent. Session history also persists across restarts via `.iris/session-id`, so conversations carry forward until you hit "new session" in the settings panel.

### Settings panel

Click the ⚙︎ settings button in the chat header to get a modal with:
- Persona text area (save, restore default)
- Memory text area (save, clear all)
- Current session id + reset button

The language, persona (female/male) and speaking speed selectors live in the compose bar and are persisted in `localStorage`.

## Running

Prereqs:
- Node 20+
- Python 3 with `pip install edge-tts`
- `claude` CLI installed and logged in (`claude` works in your terminal)
- Xcode Command Line Tools (for building whisper.cpp)
- CMake
- A modern browser with mic + webcam permissions

```bash
# 1. Build whisper.cpp and download the default model (~181 MB small-q5_1)
./scripts/install-whisper.sh

# 2. (optional, recommended) Download Paraformer-zh for faster / more accurate Chinese
./scripts/install-paraformer.sh

# 3. Install node deps
npm install

# 4. Start the server
npm run dev
# open http://localhost:3000
```

First reply is ~4 s (cold Claude subprocess + model warm-up). Every reply after that lands ~1 s to first audio chunk.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `IRIS_CLAUDE_MODEL` | `sonnet` | Claude model alias — `sonnet`, `opus`, `haiku` |
| `IRIS_WHISPER_MODEL` | `ggml-small-q5_1.bin` | Default whisper model |
| `IRIS_WHISPER_MODEL_EN` / `_ZH` | `$IRIS_WHISPER_MODEL` | Per-language whisper override |
| `IRIS_PARAFORMER_MODEL` | `models/paraformer-zh/model.int8.onnx` | Paraformer ONNX path |
| `IRIS_VOICE_EN` / `IRIS_VOICE_ZH` | `AvaNeural` / `XiaoxiaoNeural` | Female edge-tts voices |
| `IRIS_VOICE_EN_M` / `IRIS_VOICE_ZH_M` | `AndrewNeural` / `YunxiNeural` | Male edge-tts voices |
| `IRIS_TTS_RATE` | `20` | Default speaking speed offset (−50..+50) |
| `IRIS_AVATAR_FEMALE_URL` | Haru CDN | Custom female Live2D `.model3.json` URL |
| `IRIS_AVATAR_MALE_URL` | Mark CDN | Custom male Live2D `.model3.json` URL |

### Note on Metal / Apple Silicon

`install-whisper.sh` disables the Metal backend (`-DGGML_METAL=OFF`) because Metal produced garbled output on Intel Macs. If you're on Apple Silicon, remove that flag from the script to get GPU acceleration — it'll be much faster.

## Layout

```
iris/
├── server/
│   ├── index.js         Fastify + WebSocket entry, /api settings endpoints
│   ├── claude.js        Persistent Claude CLI subprocess + persona/memory
│   ├── stt.js           Whisper/Paraformer dispatcher
│   ├── whisper.js       whisper.cpp wrapper with script-validated retry
│   ├── paraformer.js    sherpa-onnx Paraformer-zh wrapper
│   └── tts.js           edge-tts wrapper with per-call rate / gender
├── web/public/
│   ├── index.html       Chat + stage markup, settings modal
│   ├── style.css
│   ├── main.js          Browser client (WebSocket, webcam, settings)
│   ├── stage.js         Live2D avatar with live persona swap
│   ├── vad.js           Silero VAD wrapper
│   └── face.js          MediaPipe Face Landmarker wrapper
├── persona.default.md   Committed default persona (user editable via UI)
├── memory.default.md    Committed default memory fallback
├── persona.md           Personal persona (gitignored)
├── memory.md            Personal long-term memory (gitignored)
├── models/              Whisper + Paraformer model files (gitignored)
├── scripts/             install-whisper.sh, install-paraformer.sh
└── package.json
```
