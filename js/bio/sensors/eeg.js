// EEG sensor wrapper. Phase 1: skeleton — wired in Phase 3.
//
// Output metric shape (Phase 3):
//   { focus, calm, flow, engagement, signalQuality, channels, t }
//   - focus: (beta+SMR power) / (alpha+theta) normalized 0..1
//   - calm: alpha power normalized 0..1
//   - flow: alpha+theta coherence with low beta variance, 0..1
//   - engagement: beta / (alpha+theta) (Pope et al.)
// Calibration is ambient: rolling 5-min baseline per band, no eyes-closed ritual.

export class EegSensor {
  constructor({ onStatus, onMetric }) {
    this.onStatus = onStatus || (() => {});
    this.onMetric = onMetric || (() => {});
    this._status = "off";
    this._lastMetric = null;
  }

  status() { return this._status; }
  metrics() { return this._lastMetric; }

  async start() {
    if (typeof navigator === "undefined" || !navigator.bluetooth) {
      this._setStatus("unsupported", "Web Bluetooth not available");
      return { ok: false, reason: "unsupported" };
    }
    this._setStatus("error", "EEG integration arrives in Phase 3");
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
