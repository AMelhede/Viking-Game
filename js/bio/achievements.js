// Bio → game achievement bridge.
//
// Watches Bio metrics + state and unlocks the bio_* achievements that live
// inside the existing window.Achievements system. Non-invasive — the game's
// achievement code (UI, persistence, point awards) is reused as-is.
//
// State trackers persist to localStorage so multi-run achievements (e.g.
// "60s in Flow across runs") accumulate.

const KEY = "bio_ach_v1";

function loadCounters() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch { return {}; }
}
function saveCounters(c) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch {}
}

export function startAchievementsBridge(Bio) {
  if (typeof window === "undefined") return;
  const counters = loadCounters();
  let lastTick = performance.now();

  // Calm/focus dwell trackers reset between runs (game over).
  let calmDwellS = 0;
  let focusDwellS = 0;
  let coherenceDwellS = 0;
  let lastWorldOver = false;

  // Recovery: track HR at moment-of-death and watch for a 15-BPM drop in 30s.
  let deathHr = null;
  let deathAt = 0;

  // Subscribe to events for instantaneous unlocks
  Bio.on("rppgStatus", ({ status }) => {
    if (status === "live") tryUnlock("bioFirstBeat");
  });
  Bio.on("stateChange", ({ state }) => {
    if (state === "berserker") tryUnlock("bioBerserker");
    if (state === "flow") tryUnlock("bioFlow");
  });
  Bio.on("eegMetric", (m) => {
    if (typeof m?.focus === "number" && m.focus >= 0.85) tryUnlock("bioPeakFocus");
  });

  function tick() {
    requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min(0.5, (now - lastTick) / 1000);
    lastTick = now;
    const w = window.world;
    const A = window.Achievements;
    if (!A) return;

    const state = (Bio.cognitiveState && Bio.cognitiveState()) || "neutral";
    const m = Bio.metrics();

    // Run-bound dwell counters reset on each new run
    if (w && w.over !== lastWorldOver) {
      lastWorldOver = w.over;
      if (!w.over) {
        // Run started — reset run counters
        calmDwellS = 0;
        focusDwellS = 0;
        coherenceDwellS = 0;
      } else if (w.over && m.rppg?.bpm != null) {
        // Run ended — capture death HR for recovery achievement
        deathHr = m.rppg.bpm;
        deathAt = now;
      }
    }

    // Run-bound: calm body 60s
    if (state === "calm" || state === "meditation") {
      calmDwellS += dt;
      if (calmDwellS >= 60) tryUnlock("bioCalmWarrior");
    } else {
      calmDwellS = 0;
    }

    // Run-bound: focus 30s
    if (state === "focused" || state === "flow") {
      focusDwellS += dt;
      if (focusDwellS >= 30) tryUnlock("bioFocusedMind");
    } else {
      focusDwellS = 0;
    }

    // Run-bound: HRV ≥ 50ms for 60s
    if (m.rppg?.hrv != null && m.rppg.hrv >= 50) {
      coherenceDwellS += dt;
      if (coherenceDwellS >= 60) tryUnlock("bioCoherence");
    } else {
      coherenceDwellS = 0;
    }

    // Cross-run: 60s cumulative Flow
    if (state === "flow") {
      counters.flowSeconds = (counters.flowSeconds || 0) + dt;
      saveCounters(counters);
      if (counters.flowSeconds >= 60) tryUnlock("bioFlowMaster");
    }

    // Recovery: deathHr captured, check for 15-BPM drop within 30s
    if (deathHr != null && (now - deathAt) <= 30000 && m.rppg?.bpm != null) {
      if (deathHr - m.rppg.bpm >= 15) {
        tryUnlock("bioRecovery");
        deathHr = null;
      }
    } else if (deathHr != null && (now - deathAt) > 30000) {
      deathHr = null; // window closed
    }

    // Daily streak — increment once per local-day
    const today = new Date().toDateString();
    if (counters.lastBioDay !== today) {
      // Only count if any sensor is at least warming (player engaged with bio today)
      const s = Bio.status();
      if (s.rppg !== "off" || s.eeg !== "off") {
        const yesterday = new Date(Date.now() - 86400000).toDateString();
        counters.bioStreak = counters.lastBioDay === yesterday ? (counters.bioStreak || 0) + 1 : 1;
        counters.lastBioDay = today;
        saveCounters(counters);
        if (counters.bioStreak >= 3) tryUnlock("bioStreak3");
      }
    }
  }
  requestAnimationFrame(tick);

  function tryUnlock(id) {
    const A = window.Achievements;
    if (!A || !A.list || !A.list[id]) return;
    if (A.unlocked && A.unlocked[id]) return;
    try { A.unlock(id); } catch (e) { console.warn("[Bio] unlock failed", id, e); }
  }
}
