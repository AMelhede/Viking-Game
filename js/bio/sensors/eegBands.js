// Real-time EEG band-power estimator. Cascaded biquad bandpasses + RMS over
// a 1-second sliding window. Cheap (<1ms per Muse frame) and directionally
// accurate for game-scale gameplay metrics.
//
// Bands (Hz):  delta 0.5–4 | theta 4–8 | alpha 8–13 | beta 13–30 | gamma 30–50
// We do NOT need clinical-grade — we need stable, real-time-responsive,
// per-band relative power for deriving focus / calm / flow.

const BANDS = [
  { name: "delta", lo: 0.5, hi: 4 },
  { name: "theta", lo: 4,   hi: 8 },
  { name: "alpha", lo: 8,   hi: 13 },
  { name: "beta",  lo: 13,  hi: 30 },
  { name: "gamma", lo: 30,  hi: 50 },
];

// Biquad bandpass coefficients (RBJ cookbook, BPF constant 0 dB peak gain)
function bpfCoeffs(fs, f0, Q) {
  const w0 = (2 * Math.PI * f0) / fs;
  const cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);
  return {
    b0: alpha,            b1: 0,            b2: -alpha,
    a0: 1 + alpha,        a1: -2 * cosw0,   a2: 1 - alpha,
  };
}

class Biquad {
  constructor(c) {
    this.b0 = c.b0 / c.a0; this.b1 = c.b1 / c.a0; this.b2 = c.b2 / c.a0;
    this.a1 = c.a1 / c.a0; this.a2 = c.a2 / c.a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  step(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class BandTracker {
  constructor(fs, lo, hi) {
    const f0 = Math.sqrt(lo * hi);
    const bw = hi - lo;
    const Q  = f0 / bw;
    this.filter = new Biquad(bpfCoeffs(fs, f0, Q));
    this.windowSamples = Math.max(64, Math.floor(fs)); // ~1 second
    this.buf = new Float32Array(this.windowSamples);
    this.sumSq = 0;
    this.idx = 0;
    this.filled = 0;
  }
  push(sample) {
    const y = this.filter.step(sample);
    const old = this.buf[this.idx];
    this.sumSq += y * y - old * old;
    this.buf[this.idx] = y;
    this.idx = (this.idx + 1) % this.windowSamples;
    if (this.filled < this.windowSamples) this.filled++;
  }
  power() {
    if (this.filled === 0) return 0;
    return Math.max(0, this.sumSq / this.filled);
  }
}

export class BandAnalyzer {
  constructor(sampleRateHz) {
    this.fs = sampleRateHz;
    this.trackers = BANDS.map(b => new BandTracker(sampleRateHz, b.lo, b.hi));
    // DC blocker (high-pass at ~0.3 Hz) — Muse signals have huge DC offsets.
    const dcCoeffs = (() => {
      const fc = 0.3;
      const w0 = (2 * Math.PI * fc) / sampleRateHz;
      const cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
      const alpha = sinw0 / (2 * Math.SQRT1_2);
      return {
        b0: (1 + cosw0) / 2, b1: -(1 + cosw0), b2: (1 + cosw0) / 2,
        a0: 1 + alpha,       a1: -2 * cosw0,   a2: 1 - alpha,
      };
    })();
    this.dc = new Biquad(dcCoeffs);
    this.totalSamples = 0;
  }

  /** Push one sample (already averaged across EEG channels). */
  push(sample) {
    if (!Number.isFinite(sample)) return;
    const v = this.dc.step(sample);
    for (const t of this.trackers) t.push(v);
    this.totalSamples++;
  }

  /** Returns { delta, theta, alpha, beta, gamma } band powers (relative). */
  bands() {
    const out = {};
    for (let i = 0; i < BANDS.length; i++) {
      out[BANDS[i].name] = this.trackers[i].power();
    }
    return out;
  }

  /** Returns true once all per-band sliding windows are full. */
  ready() {
    return this.trackers.every(t => t.filled >= t.windowSamples);
  }
}

/**
 * Derive cognitive metrics from band powers + their recent history.
 * Inputs in any consistent power units; we compute ratios.
 *   focus       = beta / (alpha + theta)         [Pope et al. attention metric]
 *   calm        = alpha / (alpha + beta)
 *   engagement  = beta / (alpha + theta)         [same family — kept distinct so callers can swap]
 *   flow        = high alpha+theta with low beta variance over recent window
 *
 * All outputs are normalized to [0, 1] using a rolling self-baseline so the
 * scale is meaningful for THIS player without any forced calibration.
 */
export class CognitiveDeriver {
  constructor(historySize = 240 /* samples * outputRate */) {
    this.history = []; // each entry: {focus, calm, t}
    this.maxHistory = historySize;
  }
  derive(bands) {
    const a = bands.alpha + 1e-6;
    const b = bands.beta  + 1e-6;
    const t = bands.theta + 1e-6;

    const focusRaw = b / (a + t);
    const calmRaw  = a / (a + b);
    const arousalRaw = b / (a + 1e-6); // beta/alpha — proxy for cortical arousal

    this.history.push({ focusRaw, calmRaw, arousalRaw, ts: performance.now() });
    if (this.history.length > this.maxHistory) this.history.shift();

    const focus = normalizeAgainstHistory(this.history, "focusRaw", focusRaw);
    const calm  = normalizeAgainstHistory(this.history, "calmRaw",  calmRaw);
    const flow  = computeFlow(this.history);

    return { focus, calm, flow, raw: { focusRaw, calmRaw, arousalRaw, bands } };
  }
}

function normalizeAgainstHistory(history, key, value) {
  if (history.length < 8) return 0.5; // not enough history → neutral
  let min = Infinity, max = -Infinity;
  for (const h of history) {
    const v = h[key];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 1e-6) return 0.5;
  return (value - min) / (max - min);
}

// Flow proxy: high alpha+theta presence with stable beta — matches the
// hypofrontality/automaticity signature Csikszentmihalyi-style flow studies
// look for. Heuristic, not clinical. Returns 0..1.
function computeFlow(history) {
  if (history.length < 16) return 0;
  const recent = history.slice(-16);
  const alphaThetaProxy = recent.map(h => 1 / (1 + h.arousalRaw)); // high when alpha dominates
  const betaSeries = recent.map(h => h.arousalRaw);
  const meanAT = alphaThetaProxy.reduce((s, v) => s + v, 0) / alphaThetaProxy.length;
  const meanB  = betaSeries.reduce((s, v) => s + v, 0) / betaSeries.length;
  const varB = betaSeries.reduce((s, v) => s + (v - meanB) ** 2, 0) / betaSeries.length;
  const stability = 1 / (1 + Math.sqrt(varB)); // low variance → high stability → 1
  return Math.max(0, Math.min(1, meanAT * stability));
}
