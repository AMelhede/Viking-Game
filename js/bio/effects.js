// Bio → gameplay effects.
//
// This module is the SEAM between bio state and the game. It runs outside the
// game's update loop, reads `window.Bio.cognitiveState()` every frame, and
// applies effects by mutating the existing globals (`world`, `viking`) that
// the game already exposes.
//
// Why outside-in: the game is a 10k-line single-file vanilla JS app. Editing
// every score-emitting site to multiply a bio bonus would be invasive and
// fragile. Instead we observe the score delta each frame and ADD a bonus
// proportional to bio state, so all existing score logic stays untouched.
//
// Effect catalog (multipliers are applied to NEW score gained that frame):
//
//   STATE         | score× | mead/sec | visual tint    | extra
//   ──────────────┼────────┼──────────┼────────────────┼─────────────────────
//   flow          | 2.0    | +0.5     | gold pulse     | "Odin's Sight" toast
//   berserker     | 1.5    | 0        | red overlay    | shake on enter
//   meditation    | 1.0    | +1.5     | teal pulse     | hearts regen+
//   frantic       | 1.0    | 0        | violet flicker | fast respawn flag
//   focused       | 1.25   | 0        | blue glow      | EEG-only
//   aroused       | 1.25   | 0        | orange glow    | rPPG-only
//   calm          | 1.0    | +0.75    | cyan glow      | rPPG-only
//   distracted    | 1.0    | 0        | none           |
//   neutral       | 1.0    | 0        | none           |
//
// All effects are zero when bio is off (cognitiveState === "neutral" because
// no inputs have been ingested). The game runs perfectly without bio.

const PROFILES = {
  flow:        { score: 2.00, mead: 0.50, color: "#fbbf24", label: "FLOW STATE — score ×2" },
  berserker:   { score: 1.50, mead: 0.00, color: "#dc2626", label: "BERSERKER — score ×1.5" },
  meditation:  { score: 1.00, mead: 1.50, color: "#10b981", label: "Meditation — passive mead" },
  frantic:     { score: 1.00, mead: 0.00, color: "#a78bfa", label: "Frantic — recover quickly" },
  focused:     { score: 1.25, mead: 0.00, color: "#3b82f6", label: "Focused — score ×1.25" },
  aroused:     { score: 1.25, mead: 0.00, color: "#f97316", label: "Charged — score ×1.25" },
  calm:        { score: 1.00, mead: 0.75, color: "#22d3ee", label: "Calm — passive mead" },
  distracted:  { score: 1.00, mead: 0.00, color: null,      label: null },
  neutral:     { score: 1.00, mead: 0.00, color: null,      label: null },
};

const TINT_ID = "bio-tint";
const TOAST_ID = "bio-toast";

let active = false;
let lastScore = 0;
let leftoverMead = 0;
let lastFrameAt = 0;
let lastState = "neutral";
let tintEl = null;
let toastEl = null;

function ensureTint() {
  if (tintEl) return tintEl;
  const el = document.createElement("div");
  el.id = TINT_ID;
  el.style.cssText = [
    "position:fixed", "inset:0", "pointer-events:none", "z-index:9998",
    "mix-blend-mode:overlay", "transition:background-color .8s ease, opacity .8s ease",
    "background-color:transparent", "opacity:0",
  ].join(";");
  document.body.appendChild(el);
  tintEl = el;
  return el;
}

function ensureToast() {
  if (toastEl) return toastEl;
  const el = document.createElement("div");
  el.id = TOAST_ID;
  el.style.cssText = [
    "position:fixed", "left:50%", "top:18%", "transform:translate(-50%,-20px)",
    "z-index:9998", "pointer-events:none", "padding:14px 26px",
    "background:rgba(13,17,23,.92)", "color:#fbbf24",
    "border:2px solid currentColor", "border-radius:14px",
    "font:800 18px/1.1 system-ui,sans-serif", "letter-spacing:1px",
    "box-shadow:0 16px 40px rgba(0,0,0,.55)",
    "opacity:0", "transition:opacity .25s ease, transform .25s ease",
  ].join(";");
  document.body.appendChild(el);
  toastEl = el;
  return el;
}

function showToast(text, color) {
  const el = ensureToast();
  el.textContent = text;
  el.style.color = color;
  el.style.borderColor = color;
  el.style.opacity = "1";
  el.style.transform = "translate(-50%, 0)";
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translate(-50%, -20px)";
  }, 2200);
}

function applyTint(profile) {
  const el = ensureTint();
  if (!profile.color) {
    el.style.opacity = "0";
    return;
  }
  el.style.backgroundColor = profile.color;
  el.style.opacity = "0.18";
}

/** Start the effects loop. Safe to call multiple times. */
export function startEffects(Bio) {
  if (active) return;
  if (typeof window === "undefined") return;
  active = true;
  lastFrameAt = performance.now();
  // Initialize lastScore once world exists
  const w = () => (typeof window.world !== "undefined" ? window.world : null);

  Bio.on("stateChange", ({ state }) => {
    const profile = PROFILES[state] || PROFILES.neutral;
    if (profile.label && state !== "neutral") showToast(profile.label, profile.color || "#fbbf24");
    applyTint(profile);
  });

  function tick(now) {
    if (!active) return;
    const dt = Math.min(0.1, Math.max(0, (now - lastFrameAt) / 1000));
    lastFrameAt = now;

    const world = w();
    if (world) {
      const state = (Bio.cognitiveState && Bio.cognitiveState()) || "neutral";
      const profile = PROFILES[state] || PROFILES.neutral;

      // Score multiplier — observe delta and add a bonus.
      const cur = typeof world.score === "number" ? world.score : 0;
      if (lastScore === 0) lastScore = cur;
      const delta = cur - lastScore;
      if (delta > 0 && profile.score > 1 && world.started && !world.over) {
        const bonus = delta * (profile.score - 1);
        world.score = cur + bonus;
      }
      lastScore = world.score;

      // Mead trickle (calm / meditation) — accumulate fractional, add when ≥ 1.
      if (profile.mead > 0 && world.started && !world.over) {
        leftoverMead += profile.mead * dt;
        if (leftoverMead >= 1) {
          const add = Math.floor(leftoverMead);
          leftoverMead -= add;
          world.mead = (world.mead || 0) + add;
        }
      }

      // Track time-in-state for daily health log.
      if (state !== lastState) lastState = state;
      const health = Bio.health && Bio.health();
      if (health) {
        // accrueState lives on the HealthLog; we look it up via the closure indirection.
        const log = window.__bioHealthLog;
        if (log && typeof log.accrueState === "function") {
          log.accrueState(state, dt);
        }
      }
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/** Stop the effects loop and remove visuals. */
export function stopEffects() {
  active = false;
  if (tintEl) { tintEl.style.opacity = "0"; }
}
