// rPPG sensor wrapper — webcam → heart rate, HRV, arousal.
// Wraps @elata-biosciences/rppg-web with ambient-calibration semantics.
//
// Output metric shape:
//   { bpm, hrv, arousal, baseline, confidence, signalQuality, t }
//   - bpm:           current heart rate (null while warming)
//   - hrv:           RMSSD ms (from SDK's hrv_rmssd; may be null briefly)
//   - arousal:       z-score-ish, computed as (bpm - baseline) / 15, clipped to [-2, 2].
//                    +1.0 ≈ +15 BPM above baseline, -1.0 ≈ 15 below.
//   - baseline:      SDK's rolling baseline BPM (the "ambient calibration")
//   - confidence:    0..1 from SDK
//   - signalQuality: 0..1 from SDK (face visible, motion low, lighting OK)
//
// Status state machine:
//   off → warming → live          (got confident BPM for ≥ N consecutive samples)
//   any → error                    (camera denied, WASM failed, etc.)
//   any → unsupported              (no getUserMedia)

import { createRppgSession } from "@elata-biosciences/rppg-web";

const WASM_JS_URL = new URL("../../../vendor/elata/rppg-web/pkg/rppg_wasm.js", import.meta.url).href;
const WASM_BIN_URL = new URL("../../../vendor/elata/rppg-web/pkg/rppg_wasm_bg.wasm", import.meta.url).href;

const POLL_MS = 250;
const LIVE_THRESHOLD_SAMPLES = 4;        // need 4 consecutive confident reads to go "live"
const LIVE_MIN_CONFIDENCE = 0.35;
const AROUSAL_BPM_SCALE = 15;             // ±15 BPM from baseline maps to ±1.0 arousal

export class RppgSensor {
  constructor({ onStatus, onMetric }) {
    this.onStatus = onStatus || (() => {});
    this.onMetric = onMetric || (() => {});
    this._status = "off";
    this._lastMetric = null;
    this._stream = null;
    this._video = null;
    this._session = null;
    this._pollHandle = null;
    this._goodSamples = 0;
  }

  status() { return this._status; }
  metrics() { return this._lastMetric; }

  async start() {
    if (this._status === "warming" || this._status === "live") return { ok: true };
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this._setStatus("unsupported", "Camera not available");
      return { ok: false, reason: "unsupported" };
    }

    this._setStatus("warming", "Requesting camera…");

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (e) {
      this._setStatus("error", `Camera denied (${e?.name || "error"})`);
      return { ok: false, reason: "permission" };
    }
    this._stream = stream;
    this._video = createHiddenVideo(stream);

    this._setStatus("warming", "Locking on heart rate…");

    try {
      this._session = await createRppgSession({
        video: this._video,
        backend: "wasm",
        faceMesh: "off",          // skip MediaPipe — saves ~3MB and works without it for arousal/HR
        wasmJsUrl: WASM_JS_URL,
        wasmBinaryUrl: WASM_BIN_URL,
        sampleRate: 30,
        windowSec: 10,
      });
    } catch (e) {
      console.warn("[Bio] rPPG session init failed", e);
      this._teardownStream();
      this._setStatus("error", `Sensor init failed: ${e?.message || "unknown"}`);
      return { ok: false, reason: "init", error: e };
    }

    this._goodSamples = 0;
    this._pollHandle = setInterval(() => this._poll(), POLL_MS);
    return { ok: true };
  }

  async stop() {
    if (this._pollHandle != null) { clearInterval(this._pollHandle); this._pollHandle = null; }
    try { await this._session?.dispose?.(); } catch {}
    this._session = null;
    this._teardownStream();
    this._lastMetric = null;
    this._setStatus("off");
  }

  _teardownStream() {
    if (this._stream) {
      for (const t of this._stream.getTracks()) {
        try { t.stop(); } catch {}
      }
      this._stream = null;
    }
    if (this._video) {
      try { this._video.srcObject = null; this._video.remove(); } catch {}
      this._video = null;
    }
  }

  _poll() {
    if (!this._session) return;
    let raw;
    try { raw = this._session.getMetrics(); } catch (e) {
      console.warn("[Bio] rPPG getMetrics failed", e);
      return;
    }
    if (!raw) return;

    const bpm = typeof raw.bpm === "number" && Number.isFinite(raw.bpm) ? raw.bpm : null;
    const baseline = typeof raw.baseline_bpm === "number" ? raw.baseline_bpm : null;
    const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
    const signalQuality = typeof raw.signal_quality === "number" ? raw.signal_quality : 0;
    const hrv = typeof raw.hrv_rmssd === "number" ? raw.hrv_rmssd : null;

    let arousal = null;
    if (bpm != null && baseline != null) {
      const delta = bpm - baseline;
      arousal = Math.max(-2, Math.min(2, delta / AROUSAL_BPM_SCALE));
    }

    const metric = {
      bpm,
      hrv,
      arousal,
      baseline,
      confidence,
      signalQuality,
      t: performance.now(),
    };
    this._lastMetric = metric;

    // Promote to "live" once we've seen enough confident samples.
    if (bpm != null && confidence >= LIVE_MIN_CONFIDENCE) {
      this._goodSamples++;
      if (this._status === "warming" && this._goodSamples >= LIVE_THRESHOLD_SAMPLES) {
        this._setStatus("live");
      }
    } else {
      this._goodSamples = Math.max(0, this._goodSamples - 1);
      if (this._status === "live" && this._goodSamples === 0) {
        // Lost lock — drop back to warming, don't error
        this._setStatus("warming", "Re-acquiring heart rate…");
      }
    }

    this.onMetric(metric);
  }

  _setStatus(s, detail) {
    if (this._status !== s) {
      this._status = s;
      this.onStatus(s, detail);
    } else if (detail) {
      // Allow updating detail message even when status hasn't changed
      this.onStatus(s, detail);
    }
  }
}

function createHiddenVideo(stream) {
  const v = document.createElement("video");
  v.setAttribute("playsinline", "");
  v.setAttribute("muted", "");
  v.muted = true;
  v.autoplay = true;
  v.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px";
  v.srcObject = stream;
  document.body.appendChild(v);
  v.play().catch(() => {}); // autoplay may need ensureVideoPlaying inside session
  return v;
}
