// Bio adapter — single source of truth between the game and the Elata SDK.
// The game ONLY ever talks to `window.Bio` (or this module's named exports).
// Swapping or upgrading the SDK should never require touching game code.
//
// Design principles:
//  - Bio is additive, never gating. Game must run perfectly with bio off.
//  - Calibration is ambient: sensors learn baselines from natural play, no
//    forced rituals. First ~60s after a sensor goes live is "warming"; after
//    that, scoring is relative percentiles against a rolling 5-minute window.
//  - Two physiologically distinct axes:
//       rPPG = body / arousal
//       EEG  = mind / focus
//    Each provides standalone value. Combining unlocks the 2x2 of cognitive
//    states (Flow, Berserker, Meditation, Frantic) that neither sensor alone
//    can detect.

import { RppgSensor } from "./sensors/rppg.js";
import { EegSensor } from "./sensors/eeg.js";
import { StateFusion } from "./state.js";
import { HealthLog } from "./health.js";
import { mountUi } from "./ui.js";
import { startEffects } from "./effects.js";
import { startDebriefWatcher } from "./debrief.js";

const listeners = new Map(); // event name -> Set<fn>

function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (e) { console.warn(`[Bio] ${event} handler failed`, e); }
  }
}

const rppg = new RppgSensor({
  onStatus: (status, detail) => emit("rppgStatus", { status, detail }),
  onMetric: (m) => { fusion.ingestRppg(m); health.ingestRppg(m); emit("rppgMetric", m); },
});

const eeg = new EegSensor({
  onStatus: (status, detail) => emit("eegStatus", { status, detail }),
  onMetric: (m) => { fusion.ingestEeg(m); health.ingestEeg(m); emit("eegMetric", m); },
});

const fusion = new StateFusion({
  onStateChange: (state, prev) => emit("stateChange", { state, prev }),
});

const health = new HealthLog();
// Expose the log so effects.js can call accrueState() without a circular import.
if (typeof window !== "undefined") window.__bioHealthLog = health;

// Public API ---------------------------------------------------------------
export const Bio = {
  /** Start one or both sensors. Returns immediately; status fires async. */
  async start({ rppg: useRppg = false, eeg: useEeg = false } = {}) {
    const out = {};
    if (useRppg) out.rppg = await rppg.start().catch((e) => ({ ok: false, error: e }));
    if (useEeg)  out.eeg  = await eeg.start().catch((e) => ({ ok: false, error: e }));
    return out;
  },
  async stop() { await Promise.all([rppg.stop(), eeg.stop()]); },
  async stopRppg() { return rppg.stop(); },
  async stopEeg() { return eeg.stop(); },

  /** Sensor status: 'off' | 'warming' | 'live' | 'error' | 'unsupported'. */
  status() {
    return {
      rppg: rppg.status(),
      eeg: eeg.status(),
    };
  },

  /** Latest derived metrics (may be null while warming). */
  metrics() {
    return {
      rppg: rppg.metrics(),
      eeg: eeg.metrics(),
      cognitiveState: fusion.state(),
      stateConfidence: fusion.confidence(),
    };
  },

  /** Convenience: returns one of
   *  'flow' | 'berserker' | 'meditation' | 'frantic' |
   *  'focused' | 'aroused' | 'calm' | 'neutral'
   */
  cognitiveState() { return fusion.state(); },

  /** Daily/longitudinal metrics for HUD and debrief. */
  health() { return health.snapshot(); },

  /** Subscribe to events: 'rppgStatus' | 'eegStatus' | 'rppgMetric' | 'eegMetric' | 'stateChange'. */
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  },

  /** Browser feature support — used by UI to gate toggles. */
  capabilities() {
    return {
      rppg: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
      eeg: typeof navigator !== "undefined" && !!navigator.bluetooth,
      secureContext: typeof window !== "undefined" && window.isSecureContext,
    };
  },
};

// Attach to window so legacy non-module game code can read it.
if (typeof window !== "undefined") {
  window.Bio = Bio;

  const boot = () => {
    try { mountUi(Bio); } catch (e) { console.warn("[Bio] mountUi failed", e); }
    try { startEffects(Bio); } catch (e) { console.warn("[Bio] startEffects failed", e); }
    try { startDebriefWatcher(Bio); } catch (e) { console.warn("[Bio] startDebriefWatcher failed", e); }
    window.dispatchEvent(new CustomEvent("bio:ready"));
    console.log("[Bio] adapter ready", Bio.capabilities());
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    // body might still not exist if this module loaded synchronously between
    // <head> and <body>. Defer one tick if so.
    if (document.body) boot();
    else queueMicrotask(() => (document.body ? boot() : setTimeout(boot, 0)));
  }
}
