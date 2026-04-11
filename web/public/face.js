/**
 * Face tracking via MediaPipe Face Landmarker.
 *
 * Loads the task-vision runtime from Google's CDN and runs the 468-point
 * face mesh + 52-blendshape model on every animation frame of the
 * self-view <video>. Exposes `snapshot()` which returns a compact object
 * the server can prepend to Claude's turn as natural-language context:
 *
 *   { smile: 0..1, browUp: 0..1, eyesClosed: 0..1, headYaw: -1..1,
 *     headPitch: -1..1, looking: true/false, label: "smiling" }
 *
 * The label is a coarse categorical guess that reads well in a prompt:
 * "smiling", "neutral", "surprised", "frowning", "eyes closed",
 * "looking away". Claude can use it to react — "你笑得真好看" when
 * the user grins at the camera, "怎么一脸困惑？" when they furrow.
 */

// We import the JS module from jsdelivr (not esm.sh) because MediaPipe
// tasks-vision loads its WASM files at runtime from a path you pass to
// FilesetResolver, and esm.sh doesn't serve the raw .wasm binaries
// reliably — that causes "ModelFactory not set" when it tries to
// construct a task. jsdelivr serves npm packages as static files so
// the same origin can provide both the JS and the WASM.
import {
  FilesetResolver,
  FaceLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/vision_bundle.mjs";

const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export class FaceTracker {
  constructor(videoEl) {
    this.videoEl = videoEl;
    this.landmarker = null;
    this.lastResult = null;
    this.running = false;
    // When true, loop() skips the inference step but keeps the
    // scheduler alive. main.js flips this during TTS playback so
    // face detection doesn't fight Live2D + audio decoding for
    // the main thread while iris is speaking.
    this.paused = false;
    this.latest = defaultSnapshot();
  }

  async start() {
    const filesetResolver = await FilesetResolver.forVisionTasks(WASM_BASE);
    // Try GPU delegate first; fall back to CPU on Intel Macs where
    // WebGL compute shaders can be flaky.
    const baseOptions = { modelAssetPath: MODEL_URL };
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { ...baseOptions, delegate: "GPU" },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
        runningMode: "VIDEO",
        numFaces: 1,
      });
    } catch (err) {
      console.warn("GPU face landmarker failed, falling back to CPU:", err);
      this.landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { ...baseOptions, delegate: "CPU" },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
        runningMode: "VIDEO",
        numFaces: 1,
      });
    }
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
  }

  loop() {
    if (!this.running) return;
    // Always run the inference, regardless of TTS playback — we
    // need fresh snapshots even while iris is speaking so
    // leave/return detection catches the user stepping away
    // mid-reply. The `paused` flag instead slows the cadence down
    // to save CPU without dropping data entirely: 2 s between
    // inferences normally, 4 s while iris is talking.
    if (this.videoEl.readyState >= 2) {
      try {
        const now = performance.now();
        const result = this.landmarker.detectForVideo(this.videoEl, now);
        if (result && result.faceBlendshapes && result.faceBlendshapes.length) {
          const snap = snapshotFromBlendshapes(result.faceBlendshapes[0]);
          // Also pull nose tip position from the 468 face landmarks
          // so main.js can drive Live2D's model.focus at the user's
          // actual face location (eye contact). Coordinates are
          // normalised 0..1 in the video frame.
          if (result.faceLandmarks && result.faceLandmarks.length) {
            // Landmark index 1 is the nose tip in MediaPipe's 468-
            // point face mesh. Use it as a single head-center proxy.
            const nose = result.faceLandmarks[0][1];
            if (nose) {
              snap.headX = nose.x;
              snap.headY = nose.y;
            }
          }
          this.latest = snap;
        } else {
          this.latest = { ...defaultSnapshot(), looking: false, label: "looking away" };
        }
      } catch (err) {
        // swallow transient errors (first frame, resize, etc.)
      }
    }
    // 2 s between inferences normally, stretched to 4 s while TTS
    // is playing so Live2D / audio decoding have more idle main-
    // thread time. Each MediaPipe call is ~280 ms so the cost is
    // ~14% CPU in the quiet case, ~7% while iris is speaking.
    setTimeout(() => this.loop(), this.paused ? 4000 : 2000);
  }

  /** Return the most recent expression snapshot (safe to call from anywhere). */
  snapshot() {
    return { ...this.latest };
  }
}

function defaultSnapshot() {
  return {
    smile: 0,
    browUp: 0,
    browDown: 0,
    eyesClosed: 0,
    mouthOpen: 0,
    looking: false,
    label: "looking away",
    headX: 0.5,
    headY: 0.5,
  };
}

// MediaPipe blendshape category indices we care about. Names match the
// ARKit 52-blendshape spec that MediaPipe emits as `categories`.
function pickScore(categories, name) {
  const cat = categories.find((c) => c.categoryName === name);
  return cat ? cat.score : 0;
}

function snapshotFromBlendshapes(face) {
  const cats = face.categories;
  const smileL = pickScore(cats, "mouthSmileLeft");
  const smileR = pickScore(cats, "mouthSmileRight");
  const smile = (smileL + smileR) / 2;

  const browUpL = pickScore(cats, "browInnerUp");
  const browOuterL = pickScore(cats, "browOuterUpLeft");
  const browOuterR = pickScore(cats, "browOuterUpRight");
  const browUp = Math.max(browUpL, (browOuterL + browOuterR) / 2);

  const browDownL = pickScore(cats, "browDownLeft");
  const browDownR = pickScore(cats, "browDownRight");
  const browDown = (browDownL + browDownR) / 2;

  const eyeBlinkL = pickScore(cats, "eyeBlinkLeft");
  const eyeBlinkR = pickScore(cats, "eyeBlinkRight");
  const eyesClosed = (eyeBlinkL + eyeBlinkR) / 2;

  const jawOpen = pickScore(cats, "jawOpen");
  const mouthOpen = jawOpen;

  const label = labelOf({ smile, browUp, browDown, eyesClosed, mouthOpen });

  return {
    smile: round2(smile),
    browUp: round2(browUp),
    browDown: round2(browDown),
    eyesClosed: round2(eyesClosed),
    mouthOpen: round2(mouthOpen),
    looking: true,
    label,
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function labelOf({ smile, browUp, browDown, eyesClosed, mouthOpen }) {
  if (eyesClosed > 0.7) return "eyes closed";
  if (smile > 0.5 && mouthOpen > 0.3) return "laughing";
  if (smile > 0.35) return "smiling";
  if (browUp > 0.5 && mouthOpen > 0.3) return "surprised";
  if (browDown > 0.4) return "frowning";
  if (mouthOpen > 0.4) return "mouth open";
  return "neutral";
}
