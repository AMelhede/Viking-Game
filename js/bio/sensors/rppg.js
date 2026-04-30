// rPPG sensor wrapper. Phase 1: skeleton only — start() rejects with a
// "not implemented" notice. Phase 2 wires this to @elata-biosciences/rppg-web.
//
// Output metric shape (Phase 2):
//   { bpm, hrv, arousal, coherence, signalQuality, t }
//   - arousal: z-score of current HR vs rolling-5min baseline, clipped to [-3, 3]
//   - hrv: RMSSD over 60s sliding window
//   - coherence: 0..1 spectral peak power between 0.04-0.15 Hz (HRV LF band)
// Calibration is ambient: the rolling baseline IS the calibration. No screen.

export class RppgSensor {
  constructor({ onStatus, onMetric }) {
    this.onStatus = onStatus || (() => {});
    this.onMetric = onMetric || (() => {});
    this._status = "off";
    this._lastMetric = null;
  }

  status() { return this._status; }
  metrics() { return this._lastMetric; }

  async start() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this._setStatus("unsupported", "getUserMedia not available");
      return { ok: false, reason: "unsupported" };
    }
    this._setStatus("error", "rPPG integration arrives in Phase 2");
    return { ok: false, reason: "not_implemented" };
  }

  async stop() {
    this._setStatus("off");
    this._lastMetric = null;
  }

  _setStatus(s, detail) {
    if (this._status !== s) {
      this._status = s;
      this.onStatus(s, detail);
    }
  }
}
