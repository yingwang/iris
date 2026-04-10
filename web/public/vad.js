/**
 * Continuous voice-activity-detection recorder using Silero VAD.
 *
 * Wraps @ricky0123/vad-web (loaded from esm.sh — no npm needed) so iris
 * can feel like a real video call: you just talk, it notices you
 * started, waits for you to finish, and ships the captured audio.
 *
 * Callbacks:
 *   onSpeechStart()            user started talking
 *   onSpeechEnd(wavBlob)       user stopped talking; blob is 16 kHz mono WAV
 *   onMisfire()                VAD started but was too short — ignored
 *   onVolume(level 0..1)       for mouth-open amplitude animation later
 *
 * While iris is speaking (TTS playing), call pause() to stop the mic
 * and prevent iris hearing herself; resume() when the playback queue
 * drains. getUserMedia's built-in echoCancellation helps but isn't
 * enough on its own.
 */

import { MicVAD } from "https://esm.sh/@ricky0123/vad-web@0.0.24";

const TARGET_SR = 16000;

export class VADRecorder {
  constructor({ onSpeechStart, onSpeechEnd, onMisfire, onVolume } = {}) {
    this.onSpeechStart = onSpeechStart ?? (() => {});
    this.onSpeechEnd = onSpeechEnd ?? (() => {});
    this.onMisfire = onMisfire ?? (() => {});
    this.onVolume = onVolume ?? (() => {});
    this.vad = null;
    this.paused = false;
  }

  async start() {
    this.vad = await MicVAD.new({
      // Silero model params — tuned for low latency. Cutting redemption
      // frames from 20 to 10 halves the silence iris has to wait through
      // before she starts processing, at the cost of occasionally
      // cutting off a long mid-sentence pause.
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.4,
      minSpeechFrames: 3, // ~90 ms of speech required to count
      preSpeechPadFrames: 8, // ~240 ms of lead-in audio captured
      redemptionFrames: 10, // ~300 ms of silence ends the utterance

      onSpeechStart: () => {
        if (this.paused) return;
        this.onSpeechStart();
      },
      onSpeechEnd: (audio) => {
        if (this.paused) return;
        // audio is Float32Array, already 16 kHz mono
        const wav = encodeWav(audio, TARGET_SR);
        this.onSpeechEnd(wav);
      },
      onVADMisfire: () => {
        if (this.paused) return;
        this.onMisfire();
      },
      onFrameProcessed: (probs) => {
        if (this.paused) return;
        this.onVolume(probs.isSpeech ?? 0);
      },
    });
    this.vad.start();
  }

  pause() {
    if (!this.vad || this.paused) return;
    this.paused = true;
    this.vad.pause();
  }

  resume() {
    if (!this.vad || !this.paused) return;
    this.paused = false;
    this.vad.start();
  }

  stop() {
    if (this.vad) {
      this.vad.pause();
      this.vad.destroy();
      this.vad = null;
    }
  }
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

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
