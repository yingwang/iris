# iris

A voice + video AI companion that lives in your browser. Claude as the brain, Live2D as the face, real-time conversation with lip sync, face tracking, and memory. You just talk — iris sees you, hears you, and talks back.

*[中文](#中文)*

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

Prerequisites:
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

一个运行于浏览器中的语音 + 视频 AI 伙伴。以 Claude 为大脑，Live2D 为面孔，支持实时对话、口型同步、面部追踪与长期记忆。无需按键操作，只需开口说话——她便能看见你、听见你，并以自然的声音作答。

### 功能概览

- **持续语音对话**——Silero VAD 全程监听，无需按键。你在她回应途中开口，她会立即停顿，让位于你的发言。
- **Live2D 虚拟形象**——口型与 TTS 音频同步，表情由 Claude 通过内嵌的 `<expr:happy>` 之类标签驱动；视线会跟随你的面部移动，言谈间身体亦有自然的动作。
- **面部追踪**——MediaPipe 将你的表情转化为自然语言提示传给 Claude（如 `[用户刚从 neutral 变为 smiling]`），使她能够回应情绪的变化。你离开或重新出现在镜头前同样会被察觉，并触发一句简短的招呼。
- **持久化记忆**——人设与长期事实均以本地 markdown 文件存放，可直接编辑。她亦能在回复中通过 `<remember>…</remember>` 标签自动追加新事实。
- **静默时主动问候**——若超过 90 秒未开口，她会主动说一句轻语。
- **多模型切换**——UI 下拉即可在 Sonnet / Opus / Haiku 之间切换，无需 API key，通过本地已登录的 `claude` CLI 调用你的订阅。
- **中英双语**——逐轮自动识别。中文由 Paraformer-zh 加速，其他语言由 whisper.cpp 承担。

### 架构

```
┌─────────────── 浏览器 ───────────────┐         ┌──────── 服务端 ────────┐
│ PIXI + pixi-live2d-display          │         │ Fastify + WebSocket    │
│ MediaPipe Face Landmarker           │ ◄─ WS ─►│ 常驻 Claude CLI 子进程  │
│ Silero VAD(常开麦克风)              │         │ whisper.cpp + Paraformer│
│ Web Audio TTS 播放 + RMS 口型同步    │         │ edge-tts(Azure 神经音)  │
└─────────────────────────────────────┘         └────────────────────────┘
```

- **大脑**：Claude Code CLI 以 `--input-format stream-json` 模式常驻，每个会话对应一个长期存活的子进程，仅首轮承担冷启动开销。UI 可切换 `sonnet` / `opus` / `haiku`，通过本地已登录的 Claude 订阅运行，无需 API key。
- **STT**：
  - **whisper.cpp**（`ggml-small-q5_1.bin`，约 181 MB，CPU 下每轮约 3 秒）——多语言支持，内置严格的中英文字脚本校验器，识别语种错误时自动重试。
  - **Paraformer-zh** 通过 `sherpa-onnx-node`（约 232 MB ONNX，每轮约 300–500 ms）——当前最优的中文识别方案，选中"中文"时自动启用。基于原生 Node 插件，无需 Python 辅助进程。
- **TTS**：[edge-tts](https://github.com/rany2/edge-tts)——免费但需要联网。预设以"英 + 中"神经音配对（女声：Xiaoxiao / Xiaoyi / HsiaoYu；男声：Yunxi / Yunyang / Yunjian / YunJhe），语速与模型均可在输入栏的下拉中调节。
- **语音活动检测**：`@ricky0123/vad-web` 中的 Silero VAD，运行于 AudioWorklet 之中。回复播放期间仍保持监听以支持打断；TTS 开始后设有 1 秒的宽限期，用以屏蔽回音泄漏。
- **虚拟形象**：由 `pixi-live2d-display` 驱动 Live2D Cubism 4 模型。默认采用 Haru（女）与 Natori / Mark（男），可通过环境变量替换为自定义模型。Claude 发出的表情标签会映射至各模型对应的情绪槽（Haru 的 `f01`–`f08`，Natori 的 `Smile` / `Angry` / `Sad` 等）。
- **追踪**：MediaPipe Face Landmarker 每两秒左右进行一次推理，输出 52 项 blendshape 与鼻尖位置。快照会作为自然语言前缀拼接到每轮用户消息中；鼻尖位置同时驱动 Live2D 的 `model.focus`，令她的视线始终追随你。离开与归来均会触发简短的问候。
- **口型同步**：Web Audio 的 `AnalyserNode` 从 TTS 音频流中读取 RMS，每帧写入 `ParamMouthOpenY` 并叠加 `ParamMouthForm`，使嘴形的开合与轮廓紧贴音节包络。Hook 点置于 Cubism 的 `coreModel.update` 之上，因为顶点烘焙正发生于此层，写在外层的 `internalModel.update` 上为时已晚。

### 人设与记忆

项目根目录下有两份用户可编辑的 markdown 文件，Claude 在每一轮对话中均会读取：

- **`persona.md`**——定义她的身份：声音、与你的关系、角色扮演的设定等。可自由编辑；硬编码的输出规则（禁用 emoji、markdown、代码块，因输出直送 TTS）始终位居最上层，不可覆盖。
- **`memory.md`**——关于你的长期事实。她在回复中发出 `<remember>一句话</remember>` 即会自动追加至此文件，你亦可直接编辑。

二者均 **不纳入 git**。仓库内置 `persona.default.md` / `memory.default.md` 作为回落。会话历史通过 `.iris/session-meta.json` 跨重启持久化——其中记录了当前系统提示词的 SHA-256；修改人设、记忆或预设后会自动开启新会话，而非让旧 prompt 继续生效。

### 设置面板

点击聊天栏顶部的 **⚙︎ settings**，可进行以下操作：
- 编辑人设（保存、恢复默认）
- 编辑记忆（保存、一键清空）
- 查看当前会话 id，或创建新会话

**语言**、**音色与形象预设**、**语速**、**模型** 四项下拉位于输入栏，所选值保存在 `localStorage` 中。

### 运行

前置条件：
- Node 20 及以上
- Python 3，执行 `pip install edge-tts`
- 已安装并登录的 `claude` CLI（终端中 `claude` 命令可正常使用）
- Xcode Command Line Tools（用于编译 whisper.cpp）
- CMake
- 支持麦克风与摄像头权限的现代浏览器

```bash
# 1. 编译 whisper.cpp 并下载默认模型(约 181 MB)
./scripts/install-whisper.sh

# 2. (可选，推荐)安装 Paraformer-zh，中文识别更快更准
./scripts/install-paraformer.sh

# 3. 安装 node 依赖
npm install

# 4. 启动服务
npm run dev
# 打开 http://localhost:3000
```

首轮回复约需 4 秒（冷启动 Claude 子进程与模型预热），此后每轮首段音频大致在 1 秒内送达。

### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `IRIS_CLAUDE_MODEL` | `sonnet` | 默认 Claude 模型（UI 选择会覆盖每个连接的值）|
| `IRIS_WHISPER_MODEL` | `ggml-small-q5_1.bin` | 默认 whisper 模型 |
| `IRIS_WHISPER_MODEL_EN` / `_ZH` | 同上 | 按语言覆盖 whisper 模型 |
| `IRIS_PARAFORMER_MODEL` | `models/paraformer-zh/model.int8.onnx` | Paraformer ONNX 路径 |
| `IRIS_VOICE_EN` / `IRIS_VOICE_ZH` | `AvaNeural` / `XiaoxiaoNeural` | 女声 edge-tts 默认 |
| `IRIS_VOICE_EN_M` / `IRIS_VOICE_ZH_M` | `AndrewNeural` / `YunxiNeural` | 男声 edge-tts 默认 |
| `IRIS_TTS_RATE` | `0` | 默认语速偏移（−50..+50 %）|
| `IRIS_AVATAR_FEMALE_URL` | Haru CDN | 自定义女性 Live2D `.model3.json` URL |
| `IRIS_AVATAR_MALE_URL` | Natori CDN | 自定义男性 Live2D `.model3.json` URL |

### Metal / Apple Silicon 说明

`install-whisper.sh` 以 `-DGGML_METAL=OFF` 关闭了 Metal 后端，因其在 Intel Mac 上会产生异常输出。若使用 Apple Silicon，请移除该 flag 以启用 GPU 加速，性能提升十分明显。
