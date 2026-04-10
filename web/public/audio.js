/**
 * Browser audio recorder for iris.
 *
 * Captures mic audio via MediaRecorder, and when stopped, produces a
 * 16 kHz mono PCM16 WAV Blob ready to ship to whisper.cpp on the server.
 *
 * Browsers give us whatever their native MediaRecorder codec is
 * (usually webm/opus at 48 kHz). We decode it with Web Audio's
 * decodeAudioData, then mix to mono and linearly resample to 16 kHz,
 * then wrap in a WAV header. All of that is cheap and runs client-side.
 *
 * Usage:
 *   const rec = new AudioRecorder();
 *   await rec.start();
 *   ...user speaks...
 *   const wavBlob = await rec.stop();
 *   const base64 = await blobToBase64(wavBlob);
 *   ws.send(JSON.stringify({ type: "user_audio", data: base64 }));
 */

const TARGET_SR = 16000; // whisper.cpp wants 16 kHz

export class AudioRecorder {
  constructor() {
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.mimeType = "";
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Pick a mime the browser actually supports
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];
    this.mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";

    this.chunks = [];
    this.recorder = new MediaRecorder(
      this.stream,
      this.mimeType ? { mimeType: this.mimeType } : undefined
    );
    this.recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    this.recorder.start();
  }

  /** Stop and return the captured audio as a 16 kHz mono WAV Blob. */
  async stop() {
    if (!this.recorder) return null;

    const stopped = new Promise((resolve) => {
      this.recorder.addEventListener("stop", resolve, { once: true });
    });
    this.recorder.stop();
    await stopped;

    // Stop mic stream promptly
    for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    this.recorder = null;

    if (this.chunks.length === 0) return null;
    const blob = new Blob(this.chunks, { type: this.mimeType || "audio/webm" });
    const arrayBuffer = await blob.arrayBuffer();

    // Decode to an AudioBuffer
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(arrayBuffer);
    } finally {
      ctx.close();
    }

    // Mono mix + resample to 16 kHz
    const mono = mixToMono(decoded);
    const resampled = linearResample(mono, decoded.sampleRate, TARGET_SR);

    // Wrap in WAV
    return encodeWav(resampled, TARGET_SR);
  }
}

function mixToMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  if (channels === 1) return audioBuffer.getChannelData(0).slice();
  const out = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) out[i] += data[i] / channels;
  }
  return out;
}

function linearResample(input, sourceSR, targetSR) {
  if (sourceSR === targetSR) return input;
  const ratio = sourceSR / targetSR;
  const newLength = Math.round(input.length / ratio);
  const out = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcPos - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const s = reader.result;
      // "data:audio/wav;base64,XXX..." -> "XXX..."
      resolve(typeof s === "string" ? s.split(",")[1] : "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
