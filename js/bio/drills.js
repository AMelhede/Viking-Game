// Mind-training drills — short, daily-only training experiences that turn
// the bio loop into actual cognitive training, not just a game enhancer.
//
// Three drills, each gated by what sensor is active. They live OUTSIDE the
// main runner — overlay UI, no game-state interaction:
//
//   Skald's Breath    rPPG-only  4-7-8 paced breathing scored by HRV coherence
//   Odin's Eye        EEG-only   sustained focus on a target, scored by beta stability
//   Berserker's Calm  both       maintain alpha while exposed to chaotic stimuli
//
// Daily-only: each drill resets at local midnight. Streak persists.

import { Bio } from "./index.js";

const DRILLS = [
  { id: "skalds-breath",   name: "Skald's Breath",   needs: "rppg",  duration: 60,
    blurb: "60s of paced breath. Trains HRV coherence.",
    color: "#22d3ee",
    score: skaldsBreath },
  { id: "odins-eye",       name: "Odin's Eye",       needs: "eeg",   duration: 60,
    blurb: "Hold focus on the rune. Trains sustained attention.",
    color: "#3b82f6",
    score: odinsEye },
  { id: "berserkers-calm", name: "Berserker's Calm", needs: "both",  duration: 90,
    blurb: "Stay calm while the storm rages. Trains poise under chaos.",
    color: "#dc2626",
    score: berserkersCalm },
];

const STORAGE_KEY = "bio_drills_v1";

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadCompletions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch { return {}; }
}
function saveCompletions(d) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch {}
}

function isAvailable(drill) {
  const s = Bio.status();
  if (drill.needs === "rppg") return s.rppg === "live" || s.rppg === "warming";
  if (drill.needs === "eeg") return s.eeg === "live" || s.eeg === "warming";
  if (drill.needs === "both") {
    return (s.rppg === "live" || s.rppg === "warming") && (s.eeg === "live" || s.eeg === "warming");
  }
  return false;
}

function todayCompleted(drill) {
  const c = loadCompletions();
  return c[`${todayKey()}_${drill.id}`] != null;
}
function recordCompletion(drill, score) {
  const c = loadCompletions();
  c[`${todayKey()}_${drill.id}`] = { score, at: Date.now() };
  saveCompletions(c);
}

const STYLE_ID = "bio-drills-styles";
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
  .bio-drills-list{display:grid;gap:8px;margin-top:12px}
  .bio-drill-card{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;
    background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);cursor:pointer;transition:transform .12s}
  .bio-drill-card:hover{transform:translateY(-1px);border-color:rgba(251,191,36,.4)}
  .bio-drill-card.locked{opacity:.5;cursor:not-allowed}
  .bio-drill-card.done{border-color:rgba(16,185,129,.5);background:rgba(16,185,129,.08)}
  .bio-drill-card .name{font-weight:700;font-size:13px}
  .bio-drill-card .meta{font-size:10px;color:#9ca3af}
  .bio-drill-card .badge{margin-left:auto;font-size:10px;padding:2px 8px;border-radius:999px;
    background:rgba(255,255,255,.08);color:#9ca3af}
  .bio-drill-card.done .badge{background:rgba(16,185,129,.2);color:#10b981}

  .bio-drill-overlay{position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.85);backdrop-filter:blur(8px);opacity:0;pointer-events:none;
    transition:opacity .25s ease;font:14px/1.4 system-ui,sans-serif;color:#e5e7eb}
  .bio-drill-overlay.show{opacity:1;pointer-events:auto}
  .bio-drill-overlay .stage{width:min(560px,calc(100vw - 32px));text-align:center;padding:32px}
  .bio-drill-overlay h2{margin:0;font-size:22px;color:#fbbf24}
  .bio-drill-overlay .timer{margin-top:8px;font-size:12px;color:#9ca3af}
  .bio-drill-overlay .pacer{width:200px;height:200px;margin:30px auto;border-radius:50%;
    background:radial-gradient(circle, rgba(34,211,238,.25), rgba(34,211,238,0));
    transition:transform 4s ease;box-shadow:0 0 60px rgba(34,211,238,.4)}
  .bio-drill-overlay .pacer.expand{transform:scale(1.6)}
  .bio-drill-overlay .focus-rune{font-size:80px;display:inline-block;transition:transform .4s ease,filter .4s ease}
  .bio-drill-overlay .instruct{font-size:16px;color:#cbd5e1;margin:16px 0 8px;min-height:1.4em}
  .bio-drill-overlay .live{font-size:11px;color:#9ca3af;margin-top:18px}
  .bio-drill-overlay .results{margin-top:20px;padding:16px;border-radius:12px;background:rgba(255,255,255,.04);
    border:1px solid rgba(251,191,36,.3)}
  .bio-drill-overlay button{margin-top:18px;background:#fbbf24;color:#111;border:0;padding:10px 22px;
    border-radius:10px;font-weight:700;cursor:pointer}
  .bio-drill-overlay button.ghost{background:transparent;color:#9ca3af;border:1px solid rgba(255,255,255,.15)}
  `;
  const el = document.createElement("style");
  el.id = STYLE_ID; el.textContent = css;
  document.head.appendChild(el);
}

/** Renders the drill list inside a container element (called by ui.js). */
export function renderDrillList(containerEl) {
  injectStyles();
  containerEl.innerHTML = "";
  const list = document.createElement("div");
  list.className = "bio-drills-list";
  for (const drill of DRILLS) {
    const avail = isAvailable(drill);
    const done = todayCompleted(drill);
    const card = document.createElement("div");
    card.className = "bio-drill-card" + (avail ? "" : " locked") + (done ? " done" : "");
    card.innerHTML = `
      <div>
        <div class="name" style="color:${drill.color}">${drill.name}</div>
        <div class="meta">${drill.blurb}</div>
      </div>
      <div class="badge">${done ? "Done" : avail ? `${drill.duration}s` : `Needs ${drill.needs.toUpperCase()}`}</div>
    `;
    if (avail && !done) {
      card.addEventListener("click", () => runDrill(drill));
    }
    list.appendChild(card);
  }
  containerEl.appendChild(list);
}

function runDrill(drill) {
  injectStyles();
  let overlay = document.querySelector(".bio-drill-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "bio-drill-overlay";
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="stage">
      <h2 style="color:${drill.color}">${drill.name}</h2>
      <div class="timer" id="bd-timer">${drill.duration}s remaining</div>
      <div id="bd-visual"></div>
      <div class="instruct" id="bd-instruct">Begin.</div>
      <div class="live" id="bd-live">—</div>
    </div>
  `;
  overlay.classList.add("show");

  const visual = overlay.querySelector("#bd-visual");
  const instruct = overlay.querySelector("#bd-instruct");
  const timerEl = overlay.querySelector("#bd-timer");
  const liveEl = overlay.querySelector("#bd-live");

  const startedAt = performance.now();
  const samples = [];
  const intervalId = setInterval(() => {
    const elapsed = (performance.now() - startedAt) / 1000;
    const remaining = Math.max(0, drill.duration - elapsed);
    timerEl.textContent = `${Math.ceil(remaining)}s remaining`;
    const m = Bio.metrics();
    samples.push({ t: elapsed, m });
    drill.tick?.({ visual, instruct, liveEl, elapsed, total: drill.duration, m });
    if (remaining <= 0) {
      clearInterval(intervalId);
      finish(drill, overlay, samples);
    }
  }, 200);

  drill.start?.({ visual, instruct, liveEl });
}

function finish(drill, overlay, samples) {
  const score = drill.score(samples);
  recordCompletion(drill, score);

  overlay.innerHTML = `
    <div class="stage">
      <h2 style="color:${drill.color}">${drill.name} — Complete</h2>
      <div class="results">
        <div style="font-size:36px;font-weight:800;color:${drill.color}">${Math.round(score)}<span style="font-size:14px;color:#9ca3af"> /100</span></div>
        <div style="font-size:12px;color:#cbd5e1;margin-top:8px">${score >= 80 ? "Excellent. The training compounds." : score >= 50 ? "Solid effort. Return tomorrow to build the streak." : "First reps. Get back here tomorrow."}</div>
      </div>
      <button id="bd-close">Done</button>
    </div>
  `;
  overlay.querySelector("#bd-close").addEventListener("click", () => {
    overlay.classList.remove("show");
  });
}

// ─── Drill implementations ───────────────────────────────────────────────

const FOUR = 4, SEVEN = 7, EIGHT = 8;
DRILLS[0].start = ({ visual }) => {
  visual.innerHTML = `<div class="pacer" id="pacer"></div>`;
};
DRILLS[0].tick = ({ visual, instruct, liveEl, elapsed, m }) => {
  const cycle = FOUR + SEVEN + EIGHT;
  const tInCycle = elapsed % cycle;
  const pacer = visual.querySelector("#pacer");
  if (!pacer) return;
  if (tInCycle < FOUR) {
    instruct.textContent = "Inhale…";
    pacer.classList.add("expand");
  } else if (tInCycle < FOUR + SEVEN) {
    instruct.textContent = "Hold…";
  } else {
    instruct.textContent = "Exhale…";
    pacer.classList.remove("expand");
  }
  if (m.rppg?.bpm != null) liveEl.textContent = `${Math.round(m.rppg.bpm)} bpm · HRV ${Math.round(m.rppg.hrv || 0)}ms`;
};
function skaldsBreath(samples) {
  // Score = HRV growth from first quarter to last quarter, scaled.
  const valid = samples.filter(s => s.m?.rppg?.hrv != null).map(s => s.m.rppg.hrv);
  if (valid.length < 5) return 30;
  const q = Math.floor(valid.length / 4);
  const start = valid.slice(0, q).reduce((a, b) => a + b, 0) / Math.max(1, q);
  const end = valid.slice(-q).reduce((a, b) => a + b, 0) / Math.max(1, q);
  const delta = end - start;
  // +5ms HRV ≈ +30 score
  return Math.max(20, Math.min(100, 50 + delta * 6));
}

DRILLS[1].start = ({ visual }) => {
  visual.innerHTML = `<div class="focus-rune" id="rune">ᚢ</div>`;
};
DRILLS[1].tick = ({ visual, instruct, liveEl, elapsed, m }) => {
  const rune = visual.querySelector("#rune");
  if (!rune) return;
  // Drift the rune so player must actively focus to follow
  const x = Math.sin(elapsed * 0.7) * 30;
  const y = Math.cos(elapsed * 0.5) * 12;
  rune.style.transform = `translate(${x}px, ${y}px)`;
  const focus = m.eeg?.focus;
  if (focus != null) {
    rune.style.filter = `drop-shadow(0 0 ${focus * 30}px #3b82f6) brightness(${0.7 + focus * 0.6})`;
    liveEl.textContent = `Focus: ${(focus * 100).toFixed(0)}%`;
  }
  instruct.textContent = "Hold attention on the rune.";
};
function odinsEye(samples) {
  const valid = samples.filter(s => s.m?.eeg?.focus != null).map(s => s.m.eeg.focus);
  if (valid.length < 5) return 30;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length;
  const stability = 1 / (1 + Math.sqrt(variance));
  return Math.max(20, Math.min(100, mean * 70 + stability * 30));
}

DRILLS[2].start = ({ visual }) => {
  visual.innerHTML = `<div style="position:relative;width:200px;height:200px;margin:30px auto">
    <div id="bcalm-storm" style="position:absolute;inset:0;border-radius:50%;
      background:conic-gradient(#dc2626,#fbbf24,#3b82f6,#dc2626);animation:bcalm-spin 4s linear infinite"></div>
    <div id="bcalm-eye" style="position:absolute;inset:30%;border-radius:50%;background:#0d1117;
      display:flex;align-items:center;justify-content:center;font-size:32px;color:#22d3ee">☉</div>
  </div>
  <style>@keyframes bcalm-spin{to{transform:rotate(360deg)}}</style>`;
};
DRILLS[2].tick = ({ visual, instruct, liveEl, m }) => {
  const calm = m.eeg?.calm;
  const arousal = m.rppg?.arousal;
  if (calm != null && arousal != null) {
    liveEl.textContent = `Calm ${(calm * 100).toFixed(0)}% · Arousal ${arousal.toFixed(2)}`;
    const eye = visual.querySelector("#bcalm-eye");
    if (eye) eye.style.boxShadow = `0 0 ${calm * 60}px #22d3ee`;
  }
  instruct.textContent = "Stay still. Stay calm. Let the storm pass through you.";
};
function berserkersCalm(samples) {
  const valid = samples.filter(s => s.m?.eeg?.calm != null && s.m?.rppg?.arousal != null);
  if (valid.length < 5) return 30;
  const calmAvg = valid.reduce((a, b) => a + b.m.eeg.calm, 0) / valid.length;
  const arousalPenalty = valid.reduce((a, b) => a + Math.max(0, b.m.rppg.arousal), 0) / valid.length;
  return Math.max(20, Math.min(100, calmAvg * 90 - arousalPenalty * 20));
}
