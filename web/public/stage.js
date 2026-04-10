/**
 * Live2D avatar stage.
 *
 * Sets up a PIXI.js canvas on #avatar, loads a Cubism 4 model, and
 * exposes hooks for:
 *   - setMouthOpen(0..1)    — drive lip sync from TTS amplitude
 *   - setSmile(0..1)        — mirror the user's smile
 *   - setExpression(label)  — coarse expression state
 *
 * The model is loaded from a CDN copy of the Haru sample that ships
 * with pixi-live2d-display's test assets. To use your own model, drop
 * a .model3.json + textures + .moc3 into /models/ and point
 * MODEL_URL at /models/your-model/your-model.model3.json.
 */

// Cubism 4 sample models used as the female / male companion avatars.
// Female: Haru from pixi-live2d-display's test assets (bundled with
// the library, the classic sample model).
// Male: Natori from Live2D's official CubismWebSamples repo — a young
// man in traditional Japanese-style attire with a sword, the closest
// aesthetic we have to the 古风 / ancient-Chinese look the user asked
// for. Both URLs can be overridden via IRIS_AVATAR_FEMALE_URL /
// IRIS_AVATAR_MALE_URL env vars if you want to drop in a custom model.
//
// Both work with the ParamMouthOpenY lip-sync path we drive from the
// TTS AnalyserNode. We don't use Live2D's built-in model.speak() —
// it bypasses our analyser pipeline.
const MODELS = {
  female:
    "https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/haru/haru_greeter_t03.model3.json",
  male:
    "https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/Samples/Resources/Natori/Natori.model3.json",
};

export class AvatarStage {
  constructor(canvasEl, { persona = "female", modelOverrides = {} } = {}) {
    this.canvasEl = canvasEl;
    this.app = null;
    this.model = null;
    this.persona = persona;
    // Per-instance model URL map, starting from the built-in defaults
    // and layered with any overrides from the server (for example a
    // custom 古风 male model configured via IRIS_AVATAR_MALE_URL).
    this.modelUrls = {
      female: modelOverrides.female || MODELS.female,
      male: modelOverrides.male || MODELS.male,
    };
    this.ready = false;
    this.externalMouth = 0;
    this.externalSmile = 0;
  }

  async init() {
    const PIXI = window.PIXI;
    if (!PIXI || !PIXI.live2d) {
      throw new Error("PIXI or pixi-live2d-display not loaded");
    }
    // pixi-live2d-display needs PIXI globally for ticker.
    window.PIXI = PIXI;

    this.app = new PIXI.Application({
      view: this.canvasEl,
      autoStart: true,
      resizeTo: this.canvasEl.parentElement,
      backgroundAlpha: 0,
      antialias: true,
    });

    await this.#loadModel(this.persona);

    // Fit to canvas, and re-fit whenever the stage element changes
    // size — not just on window resize, because the grid cell can
    // reflow for tab moves, devtools toggles, etc.
    const parent = this.canvasEl.parentElement;
    if ("ResizeObserver" in window && parent) {
      this.resizeObserver = new ResizeObserver(() => this.fitModel());
      this.resizeObserver.observe(parent);
    } else {
      window.addEventListener("resize", () => this.fitModel());
    }

    // Per-tick updates for expression + mouth drives.
    this.app.ticker.add(() => this.tick());

    this.ready = true;
  }

  /**
   * Load the Live2D model for the given persona key into the stage,
   * replacing whatever's currently there. Used both on first init and
   * when the user switches the persona dropdown live.
   */
  async #loadModel(personaKey) {
    const PIXI = window.PIXI;
    const url = this.modelUrls[personaKey] || this.modelUrls.female;

    // Tear down the previous model if present.
    if (this.model) {
      try {
        this.app.stage.removeChild(this.model);
        this.model.destroy();
      } catch (err) {
        console.warn("failed to destroy previous model:", err);
      }
      this.model = null;
    }

    try {
      this.model = await PIXI.live2d.Live2DModel.from(url);
    } catch (err) {
      console.error("Failed to load Live2D model:", err);
      throw err;
    }

    this.app.stage.addChild(this.model);

    // Cache the model's intrinsic size before we touch its scale.
    // pixi-live2d-display's .width / .height return the current
    // rendered size (post-scale); we snapshot the unscaled footprint
    // so repeated fits on reflow are idempotent.
    this.baseWidth = this.model.width;
    this.baseHeight = this.model.height;
    this.fitModel();

    // Let the avatar track the mouse/center so there's subtle head
    // and eye movement even when idle.
    this.model.focus(
      this.app.renderer.screen.width / 2,
      this.app.renderer.screen.height / 2
    );

    // Kick off an idle motion. Cubism 4 models organise motions by
    // group — both Haru and Mark use "Idle" as the default idle
    // group. We loop through random Idle motions; pixi-live2d-display
    // will auto-play breath and blink on top.
    this.startIdleLoop();

    this.persona = personaKey;
  }

  /** Swap to a different persona's avatar live, without a reload. */
  async setPersona(personaKey) {
    if (!this.ready || this.persona === personaKey) return;
    await this.#loadModel(personaKey);
  }

  /**
   * Tear down the PIXI application and free the WebGL context so
   * the canvas can be reused by a different stage renderer (for
   * example PortraitStage's 2D context). Safe to call multiple
   * times.
   */
  destroy() {
    try {
      this.resizeObserver?.disconnect();
    } catch {}
    this.resizeObserver = null;
    if (this.model) {
      try {
        this.model.destroy();
      } catch {}
      this.model = null;
    }
    if (this.app) {
      try {
        // removeView:false keeps the <canvas> element alive so the
        // next stage can grab a new 2d/webgl context from it.
        this.app.destroy(false, { children: true, texture: true });
      } catch {}
      this.app = null;
    }
    this.ready = false;
  }

  startIdleLoop() {
    if (!this.model) return;
    const playRandomIdle = () => {
      try {
        // Priority 1 = idle; 2 = normal; 3 = force. Idle so Haru will
        // happily interrupt with a lip-sync when TTS plays.
        this.model.motion("Idle", undefined, 1);
      } catch (_) {}
    };
    playRandomIdle();
    // Retrigger every ~10 s so she doesn't freeze between idle cycles.
    setInterval(playRandomIdle, 10000);
  }

  fitModel() {
    if (!this.model || !this.app) return;
    const { width, height } = this.app.renderer.screen;
    if (!width || !height) return;
    // Compute scale against the cached unscaled footprint, so
    // repeated fits on reflow are idempotent.
    const scale =
      Math.min(width / this.baseWidth, height / this.baseHeight) * 0.9;
    this.model.scale.set(scale);
    // Center using the now-scaled width/height (which match base*scale).
    const scaledW = this.baseWidth * scale;
    const scaledH = this.baseHeight * scale;
    this.model.x = (width - scaledW) / 2;
    this.model.y = (height - scaledH) / 2 - height * 0.05;
  }

  tick() {
    if (!this.model) return;
    const coreModel = this.model.internalModel?.coreModel;
    if (!coreModel || !coreModel.setParameterValueById) return;

    // We only override the mouth parameter for lip sync. The mouth
    // form (smile) is left to the model's own idle/breath animation
    // so Iris has her own neutral resting expression instead of
    // mimicking the user's face.
    try {
      coreModel.setParameterValueById("ParamMouthOpenY", this.externalMouth);
    } catch (_) {}
  }

  /** Drive mouth from TTS amplitude. Called by main.js audio analyser. */
  setMouthOpen(v) {
    this.externalMouth = clamp01(v);
  }

  /**
   * Play a WAV blob through Live2D's built-in speak() so lip sync is
   * synced with audio at the engine level (it bypasses our manual
   * parameter write and uses an internal `sound`/`analyser` helper
   * that plays nice with the motion manager).
   *
   * Returns a Promise that resolves when playback finishes.
   */
  speak(audioBlobOrUrl, { volume = 1 } = {}) {
    if (!this.model || !this.model.speak) return Promise.resolve();
    const url =
      typeof audioBlobOrUrl === "string"
        ? audioBlobOrUrl
        : URL.createObjectURL(audioBlobOrUrl);
    return new Promise((resolve) => {
      try {
        this.model.speak(url, {
          volume,
          crossOrigin: "anonymous",
          onFinish: () => {
            if (url.startsWith("blob:")) URL.revokeObjectURL(url);
            resolve();
          },
          onError: (err) => {
            console.warn("Live2D speak error:", err);
            if (url.startsWith("blob:")) URL.revokeObjectURL(url);
            resolve();
          },
        });
      } catch (err) {
        console.warn("speak() threw:", err);
        resolve();
      }
    });
  }

  /** 0 = neutral, 1 = big smile. */
  setSmile(v) {
    this.externalSmile = (clamp01(v) - 0.5) * 2; // map to -1..1
  }

  setExpression(label) {
    if (!this.model || !this.model.expression) return;
    const mapping = {
      smiling: "f01",
      laughing: "f01",
      surprised: "f02",
      frowning: "f03",
    };
    const name = mapping[label];
    if (name) {
      try {
        this.model.expression(name);
      } catch (_) {}
    }
  }

  /**
   * Apply a Claude-emitted mood cue (happy, surprised, sad, curious,
   * playful, confused, shy, serious) to one of Haru's expression
   * files. Haru ships with f01..f08 and the label-to-file mapping is
   * somewhat arbitrary — what matters is that a change actually
   * shifts the face.
   */
  setMood(mood) {
    if (!this.model || !this.model.expression) return;
    const MOOD_TO_FILE = {
      happy: "f01",
      surprised: "f02",
      sad: "f03",
      curious: "f04",
      playful: "f05",
      confused: "f06",
      shy: "f07",
      serious: "f08",
    };
    const key = (mood || "").toLowerCase();
    const name = MOOD_TO_FILE[key];
    if (!name) return;
    try {
      this.model.expression(name);
    } catch (err) {
      console.warn("expression failed:", err);
    }
  }
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
