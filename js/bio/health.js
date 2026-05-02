// Daily/longitudinal health metrics. The Oura/Whoop layer.
// All metrics persist to localStorage and aggregate into a 30-day rolling log.
//
// Daily metrics tracked (when sensors active):
//   rPPG:  morningHrv, peakHr, recoveryTimeAvg (post-death HR return-to-baseline)
//   EEG:   focusMinutes, flowMinutes, peakFocus, calmMinutes
//   Combined: berserkerMinutes, peakStateConfidence
//
// Storage key: bio_health_v1 — { days: { 'YYYY-MM-DD': {...}, ... }, version: 1 }

const KEY = "bio_health_v1";
const RETAIN_DAYS = 90;
const SAVE_THROTTLE_MS = 5000;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { days: {}, version: 1 };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { days: {}, version: 1 };
    return { days: parsed.days || {}, version: parsed.version || 1 };
  } catch {
    return { days: {}, version: 1 };
  }
}

function save(data) {
  try {
    // Trim to RETAIN_DAYS most recent
    const keys = Object.keys(data.days).sort();
    while (keys.length > RETAIN_DAYS) {
      delete data.days[keys.shift()];
    }
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("[Bio] health save failed", e);
  }
}

export class HealthLog {
  constructor() {
    this._data = load();
    this._dayBuf = this._ensureDay(todayKey());
    this._dirty = false;
    this._lastSaveAt = 0;
    if (typeof window !== "undefined") {
      // Flush on tab hide so we don't lose recent samples on refresh/close.
      window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden" && this._dirty) this._flush();
      });
      window.addEventListener("pagehide", () => { if (this._dirty) this._flush(); });
    }
  }

  _markDirty() {
    this._dirty = true;
    const now = Date.now();
    if (now - this._lastSaveAt >= SAVE_THROTTLE_MS) this._flush();
  }
  _flush() {
    save(this._data);
    this._dirty = false;
    this._lastSaveAt = Date.now();
  }

  _ensureDay(key) {
    if (!this._data.days[key]) {
      this._data.days[key] = {
        date: key,
        // rPPG
        hrSamples: 0, hrSum: 0, peakHr: 0, hrvSamples: 0, hrvSum: 0,
        // EEG
        focusSamplesS: 0, focusMinSeconds: 0, flowSeconds: 0, calmSeconds: 0,
        peakFocus: 0,
        // Combined
        berserkerSeconds: 0, meditationSeconds: 0, franticSeconds: 0,
        // Sessions
        sessionsStarted: 0, sessionsAt: Date.now(),
      };
    }
    return this._data.days[key];
  }

  ingestRppg(m) {
    if (!m) return;
    if (typeof m.bpm === "number" && m.bpm > 0) {
      this._dayBuf.hrSamples++;
      this._dayBuf.hrSum += m.bpm;
      if (m.bpm > this._dayBuf.peakHr) this._dayBuf.peakHr = m.bpm;
    }
    if (typeof m.hrv === "number" && m.hrv > 0) {
      this._dayBuf.hrvSamples++;
      this._dayBuf.hrvSum += m.hrv;
    }
    this._markDirty();
  }

  ingestEeg(m) {
    if (!m) return;
    if (typeof m.focus === "number" && m.focus > this._dayBuf.peakFocus) {
      this._dayBuf.peakFocus = m.focus;
    }
    this._markDirty();
  }

  /** Called by state fusion to track time-in-state. dt in seconds. */
  accrueState(state, dt) {
    if (typeof dt !== "number" || dt <= 0) return;
    const d = this._dayBuf;
    if (state === "flow") d.flowSeconds += dt;
    if (state === "berserker") d.berserkerSeconds += dt;
    if (state === "meditation") d.meditationSeconds += dt;
    if (state === "frantic") d.franticSeconds += dt;
    if (state === "calm" || state === "meditation") d.calmSeconds += dt;
    // Focus minutes: any state where the EEG mind is "sharp" — flow + focused + berserker
    if (state === "focused" || state === "flow" || state === "berserker") d.focusMinSeconds += dt;
    this._markDirty();
  }

  snapshot() {
    const today = this._dayBuf;
    const keys = Object.keys(this._data.days).sort();
    const last7 = keys.slice(-7).map(k => this._data.days[k]);
    const last30 = keys.slice(-30).map(k => this._data.days[k]);

    const avgHr = today.hrSamples ? today.hrSum / today.hrSamples : null;
    const avgHrv = today.hrvSamples ? today.hrvSum / today.hrvSamples : null;
    const avg7Hrv = avgOf(last7, d => d.hrvSamples ? d.hrvSum / d.hrvSamples : null);
    const trendHrv = avg7Hrv != null && avgHrv != null ? (avgHrv - avg7Hrv) / Math.max(avg7Hrv, 1) : null;

    return {
      today: {
        date: today.date,
        avgHr,
        peakHr: today.peakHr || null,
        avgHrv,
        flowMinutes: today.flowSeconds / 60,
        focusMinutes: today.focusMinSeconds / 60,
        berserkerMinutes: today.berserkerSeconds / 60,
        meditationMinutes: today.meditationSeconds / 60,
        peakFocus: today.peakFocus || null,
      },
      trends: {
        hrv7d: avg7Hrv,
        hrvDelta: trendHrv,
        flow30dMinutes: last30.reduce((a, d) => a + (d.flowSeconds || 0), 0) / 60,
        focus30dMinutes: last30.reduce((a, d) => a + (d.focusMinSeconds || 0), 0) / 60,
      },
      streak: this._computeStreak(keys),
      raw: this._data.days,
    };
  }

  _computeStreak(keys) {
    if (keys.length === 0) return 0;
    let streak = 0;
    let cur = new Date();
    for (;;) {
      const k = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
      const d = this._data.days[k];
      const active = d && (d.hrSamples > 0 || d.peakFocus > 0 || d.sessionsStarted > 0);
      if (!active) break;
      streak++;
      cur = new Date(cur.getTime() - 86400000);
    }
    return streak;
  }
}

function avgOf(arr, getter) {
  let n = 0, sum = 0;
  for (const a of arr) {
    const v = getter(a);
    if (typeof v === "number" && !Number.isNaN(v)) { n++; sum += v; }
  }
  return n === 0 ? null : sum / n;
}
