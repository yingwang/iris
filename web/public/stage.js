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
    // List of expression NAMES the currently loaded model exposes,
    // discovered from the model's expression manager on load. Used
    // by setMood to map Claude's logical mood cues (happy, surprised,
    // ...) to whatever the model actually ships with. Different
    // models have different expression sets (Haru uses f01..f08,
    // Natori has its own naming scheme), so hardcoding file names
    // breaks when you swap personas.
    this.expressionNames = [];
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

    // Discover the model's expression catalogue so setMood can map
    // Claude's logical mood cues to real file names. pixi-live2d-
    // display exposes the manager on internalModel.motionManager,
    // and as a fallback the raw Expressions array lives on
    // internalModel.settings.expressions (straight from model3.json).
    try {
      const mgr = this.model.internalModel?.motionManager?.expressionManager;
      const defsA = mgr?.definitions || mgr?._definitions || [];
      const defsB =
        this.model.internalModel?.settings?.expressions ||
        this.model.internalModel?.settings?.Expressions ||
        [];
      const defs = defsA.length ? defsA : defsB;
      this.expressionNames = defs
        .map((d) => d?.Name || d?.name || d?.File || d?.file || "")
        .filter(Boolean);
      // Log as a plain string so it survives a copy-paste of the
      // devtools console (Array(N) otherwise).
      console.log(
        `[stage] ${personaKey} expressions (${this.expressionNames.length}): ` +
          this.expressionNames.join(", ")
      );
    } catch (err) {
      console.warn("[stage] could not read expression list:", err);
      this.expressionNames = [];
    }

    // Expose a tiny devtools helper so the user can cycle through
    // expressions and figure out which one means what. Call from
    // the browser console:
    //
    //   iris.setExp(0)     // load expression index 0
    //   iris.setExp(3)     // load index 3
    //   iris.listExp()     // print all names with indices
    //   iris.nextExp()     // advance one index
    //
    // Once you know which index looks like which mood, tell the
    // author and we hardcode the mapping into setMood().
    const self = this;
    let cursor = 0;
    window.iris = {
      listExp() {
        self.expressionNames.forEach((n, i) => console.log(`  ${i}: ${n}`));
      },
      setExp(i) {
        const idx = ((i % self.expressionNames.length) + self.expressionNames.length) %
          self.expressionNames.length;
        const name = self.expressionNames[idx];
        console.log(`[iris.setExp] ${idx} → ${name}`);
        try {
          self.model.expression(name);
        } catch (err) {
          console.warn("failed:", err);
        }
        cursor = idx;
      },
      nextExp() {
        this.setExp(cursor + 1);
      },
      model() {
        return self.model;
      },
    };

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
    if (this.idleInterval) {
      clearInterval(this.idleInterval);
      this.idleInterval = null;
    }
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
        // Priority 1 = idle; 2 = normal; 3 = force. Idle so the
        // model happily interrupts with a lip-sync when TTS plays.
        this.model.motion("Idle", undefined, 1);
      } catch (_) {}
    };
    playRandomIdle();
    // Clear any previous idle loop from a prior #loadModel call so
    // swapping models doesn't leave a zombie interval firing random
    // motions on the new model.
    if (this.idleInterval) clearInterval(this.idleInterval);
    // Every 20s (was 10s) — slower cadence reduces the "looks random"
    // feeling the user reported, and breath/blink auto-plays on top
    // so she doesn't actually freeze between cycles.
    this.idleInterval = setInterval(playRandomIdle, 20000);
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
   * playful, confused, shy, serious) to one of the loaded model's
   * expression slots. Since different models ship with different
   * expression sets we try three strategies in order:
   *
   *   1. Match by name — if the model has an expression literally
   *      called "happy" / "Happy" / "happy.exp3", use it directly.
   *   2. Fall back to an index derived from the mood's position in
   *      MOOD_ORDER, modulo the available expression count. That
   *      gives a deterministic but semantically-weak mapping for
   *      models that don't name their expressions after moods.
   *   3. Haru's legacy f01..f08 naming as a last resort.
   */
  setMood(mood) {
    if (!this.model || !this.model.expression) return;
    const key = (mood || "").toLowerCase().trim();
    if (!key) return;

    const names = this.expressionNames || [];
    const has = (name) =>
      names.some((n) => n.toLowerCase() === name.toLowerCase());

    // Per-model mood maps. Each model's expression set has
    // different names and different available slots — hardcoding
    // the mapping per model is uglier than auto-discovery but
    // gives the only semantically correct result.
    //
    // Haru (female default, pixi-live2d-display test asset): ships
    // eight expression files f01..f08 in arbitrary order, no
    // semantic names. The legacy 1:1 mapping below is what the
    // project used since the first Live2D commit.
    //
    // Natori (male default, Live2D/CubismWebSamples): ships 11
    // slots — six with mood names (Angry, Blushing, Normal, Sad,
    // Smile, Surprised) plus five unlabeled exp_NN. We use the
    // named ones and leave the rest alone.
    const MOOD_MAPS = {
      haru: {
        happy: "f01",
        surprised: "f02",
        sad: "f03",
        curious: "f04",
        playful: "f05",
        confused: "f06",
        shy: "f07",
        serious: "f08",
      },
      natori: {
        happy: "Smile",
        surprised: "Surprised",
        sad: "Sad",
        curious: "Normal",
        playful: "Smile",
        confused: "Sad",
        shy: "Blushing",
        serious: "Angry",
      },
    };

    // Detect which model we're on by looking at its expression
    // name set. Haru has f01..f08, Natori has Smile/Sad/etc.
    let modelKey = null;
    if (has("f01") || has("f01.exp3") || has("f01.exp3.json")) {
      modelKey = "haru";
    } else if (has("Smile") && has("Sad")) {
      modelKey = "natori";
    }

    let chosen = null;
    if (modelKey) {
      chosen = MOOD_MAPS[modelKey][key] || null;
    }

    // Generic name-match fallback for custom models the user drops
    // in via IRIS_AVATAR_*_URL that happen to have mood-named
    // expressions. We don't do arbitrary index mapping — a
    // random-looking expression change feels worse than none.
    if (!chosen) {
      const candidates = [
        key,
        key[0].toUpperCase() + key.slice(1),
        `${key}.exp3`,
        `${key}.exp3.json`,
      ];
      chosen = candidates.find((c) => has(c));
    }

    if (!chosen) {
      console.log(
        `[stage] mood ${key}: no matching expression, skipping`
      );
      return;
    }

    console.log(`[stage] mood ${key} → expression ${chosen}`);
    try {
      this.model.expression(chosen);
    } catch (err) {
      console.warn(`[stage] expression(${chosen}) failed:`, err);
    }
  }
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
