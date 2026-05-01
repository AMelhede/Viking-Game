// State fusion: maps real-time sensor metrics to a single cognitive state
// the game can react to. The 2x2:
//
//                  Low arousal (calm body) | High arousal (charged body)
//   High focus  →   FLOW                    | BERSERKER
//   Low focus   →   MEDITATION              | FRANTIC
//
// Single-sensor modes are first-class:
//   - rPPG only (no EEG):     'calm' | 'aroused' | 'neutral'
//   - EEG only (no rPPG):     'focused' | 'distracted' | 'neutral'
//   - Both:                   full 2x2 above + 'neutral'
//
// Hysteresis: state only flips when metrics cross a threshold AND stay across
// for at least DWELL_MS. Prevents flicker during sensor noise.

const DWELL_MS = 1500;
const AROUSAL_HIGH = 0.6;   // arousal z-score above which we say "charged"
const AROUSAL_LOW  = -0.3;  // below which we say "calm"
const FOCUS_HIGH   = 0.65;  // focus index above which we say "sharp mind"
const FOCUS_LOW    = 0.35;  // below which we say "relaxed mind"

export class StateFusion {
  constructor({ onStateChange }) {
    this.onStateChange = onStateChange || (() => {});
    this._rppg = null;
    this._eeg = null;
    this._state = "neutral";
    this._candidate = "neutral";
    this._candidateSince = 0;
  }

  ingestRppg(m) {
    this._rppg = m;
    this._evaluate();
  }
  ingestEeg(m) {
    this._eeg = m;
    this._evaluate();
  }

  state() { return this._state; }
  /** 0..1 confidence based on how cleanly thresholds are crossed. */
  confidence() {
    let n = 0, sum = 0;
    if (this._rppg && typeof this._rppg.arousal === "number") {
      const d = Math.min(Math.abs(this._rppg.arousal) / 1.5, 1);
      sum += d; n++;
    }
    if (this._eeg && typeof this._eeg.focus === "number") {
      const d = Math.min(Math.abs(this._eeg.focus - 0.5) * 2, 1);
      sum += d; n++;
    }
    return n === 0 ? 0 : sum / n;
  }

  _evaluate() {
    const candidate = this._classify();
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (candidate !== this._candidate) {
      this._candidate = candidate;
      this._candidateSince = now;
    }
    if (candidate !== this._state && (now - this._candidateSince) >= DWELL_MS) {
      const prev = this._state;
      this._state = candidate;
      this.onStateChange(this._state, prev);
    }
  }

  _classify() {
    const aroused = this._rppg && this._rppg.arousal != null
      ? (this._rppg.arousal >= AROUSAL_HIGH ? "high"
         : this._rppg.arousal <= AROUSAL_LOW ? "low" : "mid")
      : null;
    const focused = this._eeg && this._eeg.focus != null
      ? (this._eeg.focus >= FOCUS_HIGH ? "high"
         : this._eeg.focus <= FOCUS_LOW ? "low" : "mid")
      : null;

    // Both axes available — full 2x2
    if (aroused && focused) {
      if (focused === "high" && aroused === "low")  return "flow";
      if (focused === "high" && aroused === "high") return "berserker";
      if (focused === "low"  && aroused === "low")  return "meditation";
      if (focused === "low"  && aroused === "high") return "frantic";
      // mid in either axis → fall through to single-axis read
    }
    if (aroused === "high") return "aroused";
    if (aroused === "low")  return "calm";
    if (focused === "high") return "focused";
    if (focused === "low")  return "distracted";
    return "neutral";
  }
}
