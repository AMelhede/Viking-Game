// Identity tiers — what you ARE, not just what you've scored.
// The progression that compounds across days, gated by hard-to-fake bio metrics.
//
// Why tiers and not just numbers: identity > numbers for retention. "I'm a
// Berserker" is stickier than "I have 30 minutes of high-arousal play."
//
// Five tiers:
//   Initiate  — default
//   Skald     — got real bio signal flowing (10+ min any active state lifetime)
//   Berserker — 30+ min cumulative berserker (charged body + sharp mind)
//   Jarl      — 60+ min cumulative flow (calm body + sharp mind)
//   Konungr   — 240+ min flow + 30-day streak
//
// Each tier has a sub-tier track (I, II, III) for finer granularity.

const TIERS = [
  {
    id: "initiate", name: "Initiate", color: "#9ca3af",
    blurb: "You begin the path of the warrior-monk.",
    test: () => true,
  },
  {
    id: "skald", name: "Skald", color: "#22d3ee",
    blurb: "You've kept your senses present. Body and mind speak to you now.",
    test: (h) => activeMinutes(h) >= 10,
  },
  {
    id: "berserker", name: "Berserker", color: "#dc2626",
    blurb: "Sharp mind, charged body. You've fought from the eye of the storm.",
    test: (h) => totalMinutesIn(h, "berserkerSeconds") >= 30,
  },
  {
    id: "jarl", name: "Jarl", color: "#9b8afc",
    blurb: "Sharp mind, calm body. You command the field as easily as your breath.",
    test: (h) => totalMinutesIn(h, "flowSeconds") >= 60,
  },
  {
    id: "konungr", name: "Konungr", color: "#a78bfa",
    blurb: "240 minutes in flow, 30 days unbroken. You do not chase the path — you are the path.",
    test: (h) => totalMinutesIn(h, "flowSeconds") >= 240 && h.streak >= 30,
  },
];

function activeMinutes(snapshot) {
  let s = 0;
  for (const d of Object.values(snapshot.raw || {})) {
    s += (d.flowSeconds || 0) + (d.berserkerSeconds || 0) + (d.calmSeconds || 0) + (d.focusMinSeconds || 0);
  }
  return s / 60;
}
function totalMinutesIn(snapshot, key) {
  let s = 0;
  for (const d of Object.values(snapshot.raw || {})) s += (d[key] || 0);
  return s / 60;
}

/** Returns the highest-tier object the snapshot qualifies for. */
export function currentTier(healthSnapshot) {
  let best = TIERS[0];
  for (const t of TIERS) {
    try { if (t.test(healthSnapshot)) best = t; } catch {}
  }
  return best;
}

/** Returns next tier the player is working toward, plus 0..1 progress. */
export function nextTier(healthSnapshot) {
  const cur = currentTier(healthSnapshot);
  const idx = TIERS.findIndex(t => t.id === cur.id);
  const next = TIERS[idx + 1] || null;
  if (!next) return { tier: null, progress: 1 };

  let progress = 0;
  if (next.id === "skald")     progress = Math.min(1, activeMinutes(healthSnapshot) / 10);
  if (next.id === "berserker") progress = Math.min(1, totalMinutesIn(healthSnapshot, "berserkerSeconds") / 30);
  if (next.id === "jarl")      progress = Math.min(1, totalMinutesIn(healthSnapshot, "flowSeconds") / 60);
  if (next.id === "konungr")   {
    const flowProg   = totalMinutesIn(healthSnapshot, "flowSeconds") / 240;
    const streakProg = healthSnapshot.streak / 30;
    progress = Math.min(1, Math.min(flowProg, streakProg));
  }
  return { tier: next, progress };
}

export function listTiers() { return TIERS.slice(); }
