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

const MODEL_URL =
  "https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/haru/haru_greeter_t03.model3.json";

export class AvatarStage {
  constructor(canvasEl) {
    this.canvasEl = canvasEl;
    this.app = null;
    this.model = null;
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

    try {
      this.model = await PIXI.live2d.Live2DModel.from(MODEL_URL);
    } catch (err) {
      console.error("Failed to load Live2D model:", err);
      throw err;
    }

    this.app.stage.addChild(this.model);

    // Fit to canvas
    this.fitModel();
    window.addEventListener("resize", () => this.fitModel());

    // Disable built-in mouth lip sync so ours wins.
    this.model.internalModel.breath?.setParameters?.([]);

    // Per-tick updates for expression + mouth drives.
    this.app.ticker.add(() => this.tick());

    this.ready = true;
  }

  fitModel() {
    if (!this.model || !this.app) return;
    const { width, height } = this.app.renderer.screen;
    const scale = Math.min(width / this.model.width, height / this.model.height) * 0.9;
    this.model.scale.set(scale);
    this.model.x = width / 2 - (this.model.width / 2);
    this.model.y = height / 2 - (this.model.height / 2);
    // Slight vertical bias so the character isn't centered on the chest.
    this.model.y -= height * 0.05;
  }

  tick() {
    if (!this.model) return;
    const coreModel = this.model.internalModel?.coreModel;
    if (!coreModel || !coreModel.setParameterValueById) return;

    // Live2D standard parameter ids. Haru uses these; most Cubism 4
    // models do. If a parameter doesn't exist, setParameterValueById
    // is a no-op on this model.
    try {
      coreModel.setParameterValueById("ParamMouthOpenY", this.externalMouth);
      coreModel.setParameterValueById("ParamMouthForm", this.externalSmile);
    } catch (_) {}
  }

  /** Drive mouth from TTS amplitude. Called by main.js audio analyser. */
  setMouthOpen(v) {
    this.externalMouth = clamp01(v);
  }

  /** 0 = neutral, 1 = big smile. */
  setSmile(v) {
    this.externalSmile = (clamp01(v) - 0.5) * 2; // map to -1..1
  }

  setExpression(label) {
    if (!this.model || !this.model.expression) return;
    // If the model has named expressions that match our labels,
    // trigger them. Haru has a handful (f01..f08) — label-to-name
    // mapping is model-specific, so we ignore unknown labels.
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
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
