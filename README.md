# iris

A voice + video AI companion that lives in your browser. Claude as the brain, Live2D as the face, real-time conversation with lip sync, face tracking, and memory. You just talk — iris sees you, hears you, and talks back.

*[中文版在下面 / Chinese version below](#中文)*

---

## What it does

- **Continuous voice chat** — Silero VAD listens the whole time, no push-to-talk. Start talking over iris mid-reply and she stops mid-sentence.
- **Live2D avatar** — lip-synced to the TTS stream, expressions driven by Claude (`<expr:happy>` etc.), eye contact follows your face, torso moves while she speaks.
- **Face tracking** — MediaPipe reads your expression and feeds it to Claude as natural language (`[The user just shifted from neutral to smiling]`), so she reacts to mood changes. Also detects when you leave or come back to the camera.
- **Persistent memory** — editable persona + long-term facts about you. Iris can save facts herself mid-reply via `<remember>…</remember>` tags.
- **Ambient check-in** — after ~90 s of silence iris gently nudges the conversation.
- **Multi-model** — Sonnet / Opus / Haiku picker in the UI, no API key needed (uses your Claude subscription via the CLI).
- **Bilingual** — Chinese + English, auto-detected per turn. Paraformer-zh for fast Mandarin STT, whisper.cpp for everything else.

## Architecture

```
┌─────────────── browser ───────────────┐         ┌──────── server ────────┐
│ PIXI + pixi-live2d-display            │         │ Fastify + WebSocket    │
│ MediaPipe Face Landmarker             │ ◄─ WS ─►│ Persistent Claude CLI  │
│ Silero VAD (continuous mic)           │         │ whisper.cpp + Paraformer│
│ Web Audio TTS playback + RMS lip sync │         │ edge-tts (Azure neural) │
└───────────────────────────────────────┘         └────────────────────────┘
```

- **Brain**: Claude Code CLI in persistent `--input-format stream-json` mode. One long-running subprocess per session handles every turn via stdin JSON — only the first reply pays the cold-spawn tax. Model picker in the UI (`sonnet` / `opus` / `haiku`). Uses your existing Claude subscription, no API key.
- **STT**:
  - **whisper.cpp** (`ggml-small-q5_1.bin`, ~181 MB, ~3 s/turn on CPU) — multilingual with a strict en/zh script validator that retries on language mis-IDs.
  - **Paraformer-zh** via `sherpa-onnx-node` (~232 MB ONNX, ~300–500 ms/turn) — state-of-the-art Mandarin, routed automatically when 中文 is picked. In-process native addon, no Python sidecar.
- **TTS**: [edge-tts](https://github.com/rany2/edge-tts) — free, needs internet. Presets pair an English neural voice with a Chinese neural voice (Xiaoxiao / Xiaoyi / HsiaoYu for 她, Yunxi / Yunyang / Yunjian / YunJhe for 他). Speaking speed and model are user-configurable from the compose bar.
- **Voice activity**: Silero VAD via `@ricky0123/vad-web` in an AudioWorklet. Stays hot during replies for barge-in; a 1 s grace window after TTS start ignores echo leak.
- **Avatar**: Live2D Cubism 4 via `pixi-live2d-display`. Default models are Haru (女) and the Natori sample / Mark (男), overridable via env. Expression cues from Claude map to per-model mood slots (Haru's `f01`–`f08`, Natori's `Smile`/`Angry`/`Sad`/etc.).
- **Tracking**: MediaPipe Face Landmarker runs every ~2 s producing a 52-blendshape snapshot + nose-tip position. The snapshot is prefixed to each user turn as a natural-language hint; the nose tip drives the avatar's `model.focus` so her eyes follow you. Leave/return transitions fire a short check-in turn.
- **Lip sync**: Web Audio `AnalyserNode` reads RMS off the TTS stream and writes `ParamMouthOpenY` + a `ParamMouthForm` boost every frame so the avatar's mouth opens and shapes with the syllable envelope. Patched at the `coreModel.update` level because the vertex bake happens inside Cubism's own internal update.

## Personality & memory

iris has two user-editable markdown files at the project root, both loaded into every Claude turn:

- **`persona.md`** — who iris is. Describe her voice, relationship to you, roleplay setting. Edit freely; hardcoded output rules (no emoji / markdown / code blocks, because this is TTS) always stay on top.
- **`memory.md`** — long-term facts iris knows about you. Iris saves new facts automatically by emitting `<remember>fact in one sentence</remember>` mid-reply; you can also edit it directly.

Both files are **gitignored**. The repo ships committed defaults at `persona.default.md` / `memory.default.md` as fallbacks. Session history also persists across restarts via `.iris/session-meta.json` — a SHA-256 hash of the current system prompt keys the resume so changing persona / memory / voice preset automatically starts a fresh session instead of replaying the old prompt.

### Settings panel

Click **⚙︎ settings** in the chat header for:
- Persona text area (save, restore default)
- Memory text area (save, clear all)
- Current session id + "new session" button

The **language**, **persona** (voice preset + avatar), **speaking speed**, and **model** selectors live in the compose bar and are persisted in `localStorage`.

## Running

Prereqs:
- Node 20+
- Python 3 with `pip install edge-tts`
- `claude` CLI installed and logged in (`claude` works in your terminal)
- Xcode Command Line Tools (for building whisper.cpp)
- CMake
- A modern browser with mic + webcam permissions

```bash
# 1. Build whisper.cpp and download the default model (~181 MB)
./scripts/install-whisper.sh

# 2. (optional, recommended) Paraformer-zh for faster / more accurate Chinese
./scripts/install-paraformer.sh

# 3. Install node deps
npm install

# 4. Start the server
npm run dev
# open http://localhost:3000
```

First reply is ~4 s (cold Claude subprocess + model warm-up). Every subsequent reply lands a first audio chunk in roughly 1 s.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `IRIS_CLAUDE_MODEL` | `sonnet` | Default Claude model (UI picker overrides per-connection) |
| `IRIS_WHISPER_MODEL` | `ggml-small-q5_1.bin` | Default whisper model |
| `IRIS_WHISPER_MODEL_EN` / `_ZH` | `$IRIS_WHISPER_MODEL` | Per-language whisper override |
| `IRIS_PARAFORMER_MODEL` | `models/paraformer-zh/model.int8.onnx` | Paraformer ONNX path |
| `IRIS_VOICE_EN` / `IRIS_VOICE_ZH` | `AvaNeural` / `XiaoxiaoNeural` | Legacy female edge-tts voices |
| `IRIS_VOICE_EN_M` / `IRIS_VOICE_ZH_M` | `AndrewNeural` / `YunxiNeural` | Legacy male edge-tts voices |
| `IRIS_TTS_RATE` | `0` | Default speaking speed offset (−50..+50 %) |
| `IRIS_AVATAR_FEMALE_URL` | Haru CDN | Custom female Live2D `.model3.json` URL |
| `IRIS_AVATAR_MALE_URL` | Natori CDN | Custom male Live2D `.model3.json` URL |

### Note on Metal / Apple Silicon

`install-whisper.sh` disables the Metal backend (`-DGGML_METAL=OFF`) because Metal produced garbled output on Intel Macs. On Apple Silicon, remove that flag from the script for much faster GPU-accelerated STT.

## Layout

```
iris/
├── server/
│   ├── index.js         Fastify + WebSocket entry, /api settings endpoints
│   ├── claude.js        Persistent Claude CLI subprocess + persona/memory
│   ├── stt.js           Whisper/Paraformer dispatcher
│   ├── whisper.js       whisper.cpp wrapper with script-validated retry
│   ├── paraformer.js    sherpa-onnx Paraformer-zh wrapper
│   └── tts.js           edge-tts wrapper with voice presets + rate
├── web/public/
│   ├── index.html       Chat + stage markup, settings modal
│   ├── style.css
│   ├── main.js          Browser client (WebSocket, webcam, settings, VAD)
│   ├── stage.js         Live2D avatar with live persona swap + lip sync
│   ├── vad.js           Silero VAD wrapper
│   ├── face.js          MediaPipe Face Landmarker wrapper
│   └── audio.js         WAV helpers
├── persona.default.md   Committed default persona
├── memory.default.md    Committed default memory fallback
├── persona.md           Personal persona (gitignored)
├── memory.md            Personal long-term memory (gitignored)
├── models/              Whisper + Paraformer model files (gitignored)
├── scripts/             install-whisper.sh, install-paraformer.sh
└── package.json
```

---

## 中文

一个跑在浏览器里的语音 + 视频 AI 伙伴。Claude 当大脑，Live2D 当脸，实时对话 + 口型同步 + 面部追踪 + 长期记忆。你只管说话，它看得见你、听得见你、会开口回你。

### 能做什么

- **持续语音对话** — Silero VAD 一直在听，不用按键说话。她说到一半你开口，她会立刻停下来。
- **Live2D 虚拟形象** — 口型跟着 TTS 音频走，表情由 Claude 控制（通过 `<expr:happy>` 之类的内嵌标签），眼神追你的脸，说话时身子也会动。
- **面部追踪** — MediaPipe 把你的表情提炼成自然语言提示喂给 Claude（`[用户刚从 neutral 变成 smiling]`），让她能对情绪变化做出反应。你走开或回来也会被检测到并触发简短的问候。
- **持久化记忆** — 人设 + 长期事实都存在本地 markdown 文件里，直接编辑即可。她也能通过 `<remember>…</remember>` 标签在回复中自动把事实存进来。
- **安静时主动搭话** — 超过 90 秒没说话，她会轻轻问一句。
- **多模型切换** — UI 下拉选 Sonnet / Opus / Haiku，不需要 API key（走你本地登录的 `claude` CLI）。
- **中英双语** — 每轮自动识别。中文走 Paraformer-zh 加速，其他语言走 whisper.cpp。

### 架构

```
┌─────────────── 浏览器 ───────────────┐         ┌──────── 服务端 ────────┐
│ PIXI + pixi-live2d-display          │         │ Fastify + WebSocket    │
│ MediaPipe Face Landmarker           │ ◄─ WS ─►│ 常驻 Claude CLI 子进程  │
│ Silero VAD（常开麦克风）              │         │ whisper.cpp + Paraformer│
│ Web Audio TTS 播放 + RMS 口型同步    │         │ edge-tts（Azure 神经音）│
└─────────────────────────────────────┘         └────────────────────────┘
```

- **大脑**：Claude Code CLI 常驻 `--input-format stream-json` 模式，一个会话一个子进程，只有第一次交互承担冷启动成本。UI 里可切 `sonnet` / `opus` / `haiku`。走你本地登录的 Claude 订阅，不用 API key。
- **STT**：
  - **whisper.cpp**（`ggml-small-q5_1.bin`，~181 MB，CPU 下 ~3 秒/轮）—— 多语言，带一个严格的中英文字脚本校验器，识别错语言时自动重试。
  - **Paraformer-zh** 通过 `sherpa-onnx-node`（~232 MB ONNX，~300–500 ms/轮）—— 当前最强的中文识别，选中"中文"时自动走这条路。原生 Node 插件，不需要 Python 辅助进程。
- **TTS**：[edge-tts](https://github.com/rany2/edge-tts) —— 免费但需要联网。预设按"英 + 中"神经音配对（女声：Xiaoxiao / Xiaoyi / HsiaoYu；男声：Yunxi / Yunyang / Yunjian / YunJhe），语速和模型都在输入栏下拉里调。
- **语音活动检测**：`@ricky0123/vad-web` 里的 Silero VAD，跑在 AudioWorklet 里。回复播放期间也保持监听以支持打断；TTS 开始后 1 秒的宽限期用来忽略回音泄漏。
- **虚拟形象**：`pixi-live2d-display` 驱动 Live2D Cubism 4 模型。默认用 Haru（女）和 Natori / Mark（男），可通过环境变量换成自定义模型。Claude 发出的表情标签会映射到每个模型的情绪槽（Haru 的 `f01`–`f08`，Natori 的 `Smile` / `Angry` / `Sad` 等）。
- **追踪**：MediaPipe Face Landmarker 每 2 秒左右跑一次推理，给出 52 个 blendshape + 鼻尖位置。快照作为自然语言前缀拼到每轮用户消息上；鼻尖位置同时驱动 Live2D 的 `model.focus`，让她的视线跟着你走。离开 / 回来会触发一段简短的问候。
- **口型同步**：Web Audio 的 `AnalyserNode` 从 TTS 音频流读 RMS，每帧写 `ParamMouthOpenY` 并叠加 `ParamMouthForm`，让嘴巴的开合和形状都跟着音节走。Hook 点在 Cubism 的 `coreModel.update` 上，因为顶点烘焙发生在那一层——写在外层的 `internalModel.update` 上太晚了。

### 人设与记忆

项目根目录里有两个用户可编辑的 markdown，每轮 Claude 都会看到：

- **`persona.md`** —— 她是谁。定义她的声音、和你的关系、角色扮演的设定。随便改；硬编码的输出规则（禁止 emoji / markdown / 代码块，因为这是 TTS）永远放在最上层。
- **`memory.md`** —— 长期事实。她在回复中发出 `<remember>一句话</remember>` 就会自动追加进去，你也可以直接编辑。

两个文件都 **不会提交 git**。仓库自带 `persona.default.md` / `memory.default.md` 作为回落。会话历史跨重启持久化在 `.iris/session-meta.json`—— 记录当前系统提示词的 SHA-256，改了人设 / 记忆 / 预设会自动开新会话，而不是让旧的 prompt 继续生效。

### 设置面板

点聊天栏顶部的 **⚙︎ settings**：
- 人设编辑区（保存、恢复默认）
- 记忆编辑区（保存、清空）
- 当前会话 id + "new session" 按钮

**语言**、**音色/形象预设**、**语速**、**模型**四个下拉放在输入栏，选择会存进 `localStorage`。

### 运行

前置：
- Node 20+
- Python 3，`pip install edge-tts`
- 装好并登录过的 `claude` CLI（终端里敲 `claude` 能用）
- Xcode Command Line Tools（编译 whisper.cpp）
- CMake
- 能开麦克风和摄像头的现代浏览器

```bash
# 1. 编译 whisper.cpp + 下载默认模型（~181 MB）
./scripts/install-whisper.sh

# 2.（可选，推荐）Paraformer-zh，中文识别更快更准
./scripts/install-paraformer.sh

# 3. 装 node 依赖
npm install

# 4. 启动
npm run dev
# 打开 http://localhost:3000
```

第一次回复大约 4 秒（冷启动 Claude 子进程 + 模型预热），之后每轮首音频片段大约 1 秒内就能送到。

### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `IRIS_CLAUDE_MODEL` | `sonnet` | 默认 Claude 模型（UI 选择覆盖每个连接的值）|
| `IRIS_WHISPER_MODEL` | `ggml-small-q5_1.bin` | 默认 whisper 模型 |
| `IRIS_WHISPER_MODEL_EN` / `_ZH` | 同上 | 分语言覆盖 |
| `IRIS_PARAFORMER_MODEL` | `models/paraformer-zh/model.int8.onnx` | Paraformer ONNX 路径 |
| `IRIS_VOICE_EN` / `IRIS_VOICE_ZH` | `AvaNeural` / `XiaoxiaoNeural` | 女声 edge-tts 默认 |
| `IRIS_VOICE_EN_M` / `IRIS_VOICE_ZH_M` | `AndrewNeural` / `YunxiNeural` | 男声 edge-tts 默认 |
| `IRIS_TTS_RATE` | `0` | 默认语速偏移（−50..+50 %）|
| `IRIS_AVATAR_FEMALE_URL` | Haru CDN | 自定义女性 Live2D `.model3.json` URL |
| `IRIS_AVATAR_MALE_URL` | Natori CDN | 自定义男性 Live2D `.model3.json` URL |

### Metal / Apple Silicon 注意

`install-whisper.sh` 用 `-DGGML_METAL=OFF` 禁掉了 Metal 后端，因为 Metal 在 Intel Mac 上会产出乱码。Apple Silicon 上把这个 flag 拿掉就能用 GPU 加速，速度会快很多。
