// EEG sensor wrapper — Muse via Web Bluetooth → focus, calm, flow.
// Wraps @elata-biosciences/eeg-web-ble.
//
// Output metric shape:
//   { focus, calm, flow, signalQuality, channels, t, bands }
//   - focus:        beta/(alpha+theta), normalized 0..1 against rolling history
//   - calm:         alpha/(alpha+beta), normalized 0..1
//   - flow:         high alpha+theta with stable beta, 0..1 (heuristic)
//   - bands:        raw {delta, theta, alpha, beta, gamma} powers (debug)
//   - signalQuality: 0..1 composite — non-zero variance, no extreme amplitudes
//   - channels:    EEG channel names from device
//
// Calibration is ambient: rolling history (last ~60s of derived ratios)
// IS the baseline. No eyes-open/eyes-closed ritual.

import { BleTransport } from "@elata-biosciences/eeg-web-ble";
import { AthenaWasmDecoder } from "@elata-biosciences/eeg-web";
import { BandAnalyzer, CognitiveDeriver } from "./eegBands.js";

const EMIT_MS = 250;
const LIVE_THRESHOLD_SECONDS = 4; // warm for at least N seconds before going live

export class EegSensor {
  constructor({ onStatus, onMetric }) {
    this.onStatus = onStatus || (() => {});
    this.onMetric = onMetric || (() => {});
    this._status = "off";
    this._lastMetric = null;
    this._transport = null;
    this._analyzer = null;
    this._deriver = null;
    this._channels = [];
    this._sampleRate = 256;
    this._emitHandle = null;
    this._streamStartedAt = 0;
    this._lastFrameAt = 0;
    this._frameAmplitudes = []; // for signalQuality
  }

  status() { return this._status; }
  metrics() { return this._lastMetric; }

  async start() {
    if (this._status === "warming" || this._status === "live") return { ok: true };
    if (typeof navigator === "undefined" || !navigator.bluetooth) {
      this._setStatus("unsupported", "Web Bluetooth not available (Chrome/Edge desktop)");
      return { ok: false, reason: "unsupported" };
    }

    // Inner pairing routine — builds a fresh transport, races against a
    // 45s timeout, returns or throws. We call it up to twice because
    // BLE_START_FAILED is often transient (Muse's stream-start command
    // can fail right after pairing and succeed on a clean retry).
    const attempt = async (attemptLabel) => {
      this._setStatus("warming", attemptLabel);
      this._transport = new BleTransport({
        deviceOptions: {
          athenaDecoderFactory: () => new AthenaWasmDecoder(),
        },
      });
      this._transport.onStatus = (s) => { try { this._handleTransportStatus(s); } catch (err) { console.warn("[Bio] EEG status handler threw", err); } };
      this._transport.onFrame  = (f) => { try { this._handleFrame(f); } catch (err) { console.warn("[Bio] EEG frame handler threw", err); } };
      await Promise.race([
        this._transport.startStreaming(),
        new Promise((_, reject) => setTimeout(
          () => reject(Object.assign(new Error("Pairing timed out — pick the Muse in the device picker"), { code: "timeout" })),
          45000
        )),
      ]);
    };

    try {
      try {
        await attempt("Pairing Muse…");
      } catch (e1) {
        // BLE_START_FAILED = pairing completed but the stream-start
        // command on the Muse's control characteristic failed. This
        // happens fairly often on the first try because the headband's
        // BLE state can be stale from a previous session. Tear the
        // transport down and try ONE clean reconnect. Most "Failed to
        // start BLE streaming" errors clear here.
        const isStartFailed = e1?.code === "BLE_START_FAILED"
                          || /failed to start ble streaming/i.test(String(e1?.message || ""));
        if (!isStartFailed) throw e1;
        console.warn("[Bio] Muse start failed — retrying once", e1);
        try { await this._transport?.stop?.(); } catch {}
        try { await this._transport?.disconnect?.(); } catch {}
        this._transport = null;
        // Brief pause so the Muse releases the previous GATT session
        // cleanly before we re-attempt.
        await new Promise(r => setTimeout(r, 700));
        await attempt("Retrying Muse stream…");
      }
    } catch (e) {
      console.warn("[Bio] Muse connect failed", e);
      const reason = (e && e.code) ? e.code
                   : (e?.name === "NotFoundError" ? "no_device"
                   : (e?.name === "SecurityError" ? "insecure"
                   : "connect_failed"));
      // Human-readable reason. The button gets this text so the user knows
      // what to fix rather than just seeing "Failed".
      const msg = reason === "no_device" ? "No Muse selected — try again"
                : reason === "timeout"   ? "Pairing timed out — pick the Muse"
                : reason === "insecure"  ? "Web Bluetooth needs HTTPS / localhost"
                : reason === "BLE_START_FAILED" ? "Stream start failed — power-cycle your Muse (hold button 5s) and retry"
                                         : `Connect failed: ${e?.message || reason}`;
      // Best-effort cleanup so a follow-up retry has a clean slate.
      try { await this._transport?.stop?.(); } catch {}
      try { await this._transport?.disconnect?.(); } catch {}
      this._teardown();
      this._setStatus("error", msg);
      return { ok: false, reason, message: msg };
    }

    this._emitHandle = setInterval(() => { try { this._emit(); } catch (err) { console.warn("[Bio] EEG emit threw", err); } }, EMIT_MS);
    return { ok: true };
  }

  async stop() {
    if (this._emitHandle != null) { clearInterval(this._emitHandle); this._emitHandle = null; }
    try { await this._transport?.stop?.(); } catch {}
    try { await this._transport?.disconnect?.(); } catch {}
    this._teardown();
    this._setStatus("off");
  }

  _teardown() {
    this._transport = null;
    this._analyzer = null;
    this._deriver = null;
    this._lastMetric = null;
    this._frameAmplitudes = [];
  }

  _handleTransportStatus(s) {
    // s = { state, atMs, reason, errorCode, recoverable }
    if (!s) return;
    if (s.state === "Streaming" || s.state === "streaming" || s.state === 4) {
      this._streamStartedAt = performance.now();
      this._setStatus("warming", "Acquiring EEG bands…");
    } else if (s.state === "Disconnected" || s.state === "disconnected" || s.state === 0) {
      if (this._status === "live" || this._status === "warming") {
        this._setStatus("error", s.reason || "Headband disconnected");
      }
    } else if (s.state === "Error" || s.state === "error") {
      this._setStatus("error", s.reason || "EEG error");
    }
  }

  _handleFrame(frame) {
    if (!frame?.eeg) return;
    const eeg = frame.eeg;
    if (!this._analyzer) {
      this._sampleRate = eeg.sampleRateHz || 256;
      this._channels = eeg.channelNames?.slice() || [];
      this._analyzer = new BandAnalyzer(this._sampleRate);
      this._deriver = new CognitiveDeriver();
    }
    this._lastFrameAt = performance.now();

    // Each row = [ch0, ch1, ...]; analyze average across channels for robustness.
    let amp = 0, n = 0;
    for (const row of eeg.samples) {
      let sum = 0, cnt = 0;
      for (const v of row) {
        if (Number.isFinite(v)) { sum += v; cnt++; }
      }
      if (cnt > 0) {
        const avg = sum / cnt;
        this._analyzer.push(avg);
        amp += Math.abs(avg);
        n++;
      }
    }
    if (n > 0) {
      this._frameAmplitudes.push(amp / n);
      if (this._frameAmplitudes.length > 50) this._frameAmplitudes.shift();
    }
  }

  _emit() {
    if (!this._analyzer || !this._deriver) return;
    const bands = this._analyzer.bands();
    const derived = this._deriver.derive(bands);

    // Signal quality: non-zero variance + amplitudes within plausible Muse range.
    const ampOK = this._frameAmplitudes.length > 5
      ? this._frameAmplitudes.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, this._frameAmplitudes.length) > 1
      : false;
    const varOK = bands.alpha + bands.beta + bands.theta > 1e-3;
    const sinceFrame = performance.now() - this._lastFrameAt;
    const fresh = sinceFrame < 1500;
    const signalQuality = (ampOK ? 0.5 : 0) + (varOK ? 0.3 : 0) + (fresh ? 0.2 : 0);

    const metric = {
      focus: derived.focus,
      calm: derived.calm,
      flow: derived.flow,
      bands,
      channels: this._channels,
      signalQuality,
      t: performance.now(),
    };
    this._lastMetric = metric;

    // Promote to live once enough buffered seconds and decent quality
    const ageS = (performance.now() - this._streamStartedAt) / 1000;
    if (this._status === "warming" && this._analyzer.ready() && ageS >= LIVE_THRESHOLD_SECONDS && signalQuality >= 0.5) {
      this._setStatus("live");
    }

    this.onMetric(metric);
  }

  _setStatus(s, detail) {
    if (this._status !== s || detail) {
      const changed = this._status !== s;
      this._status = s;
      if (changed || detail) this.onStatus(s, detail);
    }
  }
}
