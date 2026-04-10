/**
 * Canvas-based portrait avatar — alternative to Live2D for cases
 * where you have a photograph or a high-quality AI-generated still
 * but no rigged .moc3 file.
 *
 * Renders a static image into the same #avatar canvas AvatarStage
 * uses, plus three subtle animations driven by the existing stage
 * interface:
 *
 *   - breathing: slow ±1% scale oscillation around the image center
 *   - blink: a dark elliptical band briefly covers the eye region
 *     every few seconds
 *   - mouth: a soft dark ellipse at the mouth region whose vertical
 *     radius scales with setMouthOpen(), driven by the TTS RMS loop
 *
 * The image and facial feature regions come from the constructor.
 * Regions are normalized (0..1 of image dimensions) so you can use
 * the same class with any portrait — just measure the mouth and eye
 * positions in the source file and pass them in.
 *
 * Implements the same `setMouthOpen(v)` / `setPersona(key)` /
 * `setMood(name)` / `init()` interface as AvatarStage so main.js
 * can swap between the two transparently.
 */
export class PortraitStage {
  constructor(
    canvasEl,
    {
      imageUrl,
      // Normalized facial feature regions. Defaults are tuned for
      // the default hanfu-scholar.png portrait; override per image.
      mouthRegion = { cx: 0.51, cy: 0.42, rx: 0.035, ry: 0.007 },
      eyeRegion = { cx: 0.51, cy: 0.345, rx: 0.14, ry: 0.018 },
    } = {}
  ) {
    this.canvasEl = canvasEl;
    this.ctx = null;
    this.image = null;
    this.imageUrl = imageUrl;
    this.mouthRegion = mouthRegion;
    this.eyeRegion = eyeRegion;
    this.externalMouth = 0;
    this.lastBlinkAt = 0;
    this.blinking = false;
    this.blinkEndsAt = 0;
    this.rafId = null;
    this.ready = false;
    this.resizeObserver = null;
  }

  async init() {
    // Reset the canvas context (in case it was used by Live2D / PIXI
    // previously — PIXI leaves a webgl context bound, so we need a
    // fresh 2d context). Detaching the webgl context is done by
    // PIXI.Application.destroy({ removeView: false }) upstream.
    this.ctx = this.canvasEl.getContext("2d");

    await this.#loadImage();

    const parent = this.canvasEl.parentElement;
    const resize = () => {
      if (!parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      this.canvasEl.width = Math.round(w * dpr);
      this.canvasEl.height = Math.round(h * dpr);
      this.canvasEl.style.width = w + "px";
      this.canvasEl.style.height = h + "px";
      this.ctx = this.canvasEl.getContext("2d");
      this.ctx.scale(dpr, dpr);
    };
    resize();
    if ("ResizeObserver" in window && parent) {
      this.resizeObserver = new ResizeObserver(resize);
      this.resizeObserver.observe(parent);
    } else {
      window.addEventListener("resize", resize);
    }

    this.#startLoop();
    this.ready = true;
  }

  /**
   * PortraitStage only has one image at a time, so persona swaps
   * are a no-op — the caller is responsible for tearing this stage
   * down and constructing a new one with a different image URL.
   */
  async setPersona(_personaKey) {
    /* no-op */
  }

  /** Drive the mouth shape from the TTS amplitude analyser. */
  setMouthOpen(v) {
    if (!Number.isFinite(v)) return;
    this.externalMouth = Math.max(0, Math.min(1, v));
  }

  /** Mood cues are a no-op until we support multiple portrait images. */
  setMood(_name) {
    /* no-op */
  }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.ready = false;
  }

  async #loadImage() {
    if (!this.imageUrl) return;
    await new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        this.image = img;
        resolve();
      };
      img.onerror = () => {
        console.warn("portrait image failed to load:", this.imageUrl);
        resolve();
      };
      img.src = this.imageUrl;
    });
  }

  #startLoop() {
    const loop = () => {
      this.#draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  #draw() {
    const ctx = this.ctx;
    if (!ctx || !this.image) return;
    const cw = this.canvasEl.clientWidth;
    const ch = this.canvasEl.clientHeight;
    if (!cw || !ch) return;

    ctx.clearRect(0, 0, cw, ch);

    // Fit the image to the canvas while preserving aspect ratio,
    // then recompute the feature overlay positions in canvas space.
    const imgW = this.image.naturalWidth;
    const imgH = this.image.naturalHeight;
    const fit = Math.min(cw / imgW, ch / imgH);
    const drawW = imgW * fit;
    const drawH = imgH * fit;
    const offX = (cw - drawW) / 2;
    const offY = (ch - drawH) / 2;

    const t = performance.now() / 1000;
    const breath = 1 + Math.sin(t * 0.8) * 0.012;

    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.scale(breath, breath);
    ctx.translate(-cw / 2, -ch / 2);

    // Base portrait
    ctx.drawImage(this.image, offX, offY, drawW, drawH);

    // --- mouth overlay ---
    // A soft dark ellipse sitting over the lip line whose vertical
    // radius scales with external mouth amplitude. Subtle at rest,
    // more visible while speaking.
    const mR = this.mouthRegion;
    const mCx = offX + drawW * mR.cx;
    const mCy = offY + drawH * mR.cy;
    const mRx = drawW * mR.rx;
    const mRy = drawH * mR.ry * (1 + this.externalMouth * 7);
    const alpha = 0.08 + this.externalMouth * 0.35;
    ctx.beginPath();
    ctx.ellipse(mCx, mCy, mRx, mRy, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(40, 14, 18, ${alpha})`;
    ctx.fill();

    // --- blink ---
    // Every 3–6 seconds, flash a dark ellipse across the eye
    // region for ~130 ms. Not a true eyelid animation, but enough
    // to give the impression of life.
    if (!this.blinking && t - this.lastBlinkAt > 3 + Math.random() * 3) {
      this.blinking = true;
      this.blinkEndsAt = t + 0.13;
    }
    if (this.blinking) {
      const eR = this.eyeRegion;
      const eCx = offX + drawW * eR.cx;
      const eCy = offY + drawH * eR.cy;
      const eRx = drawW * eR.rx;
      const eRy = drawH * eR.ry * 1.4;
      ctx.beginPath();
      ctx.ellipse(eCx, eCy, eRx, eRy, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(14, 8, 6, 0.55)";
      ctx.fill();
      if (t >= this.blinkEndsAt) {
        this.blinking = false;
        this.lastBlinkAt = t;
      }
    }

    ctx.restore();
  }
}
