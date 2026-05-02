// Floating Bio UI: a corner status badge, a slide-out settings panel, and a
// post-run debrief overlay. The UI lives outside the game's canvas so the
// addition is visually unobtrusive and game logic untouched.
//
// Privacy principle: when a sensor is active, the badge always shows it.
// One click opens the panel, one click toggles off.

import { currentTier, nextTier } from "./identity.js";
import { renderDrillList } from "./drills.js";

const PANEL_ID = "bio-panel";
const BADGE_ID = "bio-badge";
const STYLE_ID = "bio-styles";

const STATE_LABEL = {
  flow: "Flow", berserker: "Berserker", meditation: "Meditation", frantic: "Frantic",
  focused: "Focused", aroused: "Charged", calm: "Calm", distracted: "Distracted",
  neutral: "—",
};

const STATE_COLOR = {
  flow: "#fbbf24", berserker: "#dc2626", meditation: "#10b981", frantic: "#a78bfa",
  focused: "#3b82f6", aroused: "#f97316", calm: "#22d3ee", distracted: "#9ca3af",
  neutral: "#6b7280",
};

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
  #${BADGE_ID}{position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;align-items:center;gap:10px;
    background:linear-gradient(135deg,#dc2626,#fbbf24);color:#0d1117;
    border:2px solid #fbbf24;border-radius:999px;
    padding:12px 20px;font:800 14px/1.2 system-ui,sans-serif;
    cursor:pointer;user-select:none;box-shadow:0 12px 32px rgba(220,38,38,.4),0 0 0 4px rgba(251,191,36,.2);
    transition:transform .15s ease;letter-spacing:.5px}
  #${BADGE_ID}:hover{transform:translateY(-2px) scale(1.04)}
  #${BADGE_ID}::before{content:"🧠";font-size:18px}
  #${BADGE_ID} .dot{width:10px;height:10px;border-radius:50%;background:#0d1117;box-shadow:0 0 10px currentColor}
  #${BADGE_ID} .dot.live{background:#10b981;animation:bio-pulse 2s infinite}
  #${BADGE_ID} .dot.warming{background:#f59e0b;animation:bio-pulse 1s infinite}
  #${BADGE_ID} .dot.error{background:#7f1d1d}
  @keyframes bio-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(1.2)}}
  @keyframes bio-attention{0%,100%{box-shadow:0 12px 32px rgba(220,38,38,.4),0 0 0 4px rgba(251,191,36,.2)}
    50%{box-shadow:0 12px 32px rgba(220,38,38,.6),0 0 0 12px rgba(251,191,36,.3)}}
  #${BADGE_ID}.attract{animation:bio-attention 2s ease-in-out 3}

  #${PANEL_ID}{position:fixed;right:12px;bottom:56px;z-index:9999;width:320px;max-width:calc(100vw - 24px);
    background:rgba(13,17,23,.96);color:#e5e7eb;border:1px solid rgba(251,191,36,.4);border-radius:14px;
    padding:18px;font:13px/1.4 system-ui,sans-serif;backdrop-filter:blur(8px);
    box-shadow:0 24px 60px rgba(0,0,0,.55);transform:translateY(8px);opacity:0;pointer-events:none;
    transition:opacity .18s ease,transform .18s ease}
  #${PANEL_ID}.open{opacity:1;transform:translateY(0);pointer-events:auto}
  #${PANEL_ID} h3{margin:0 0 4px;font-size:14px;color:#fbbf24;letter-spacing:.5px}
  #${PANEL_ID} .sub{color:#9ca3af;font-size:11px;margin-bottom:14px}
  #${PANEL_ID} .row{display:flex;align-items:center;justify-content:space-between;margin:10px 0}
  #${PANEL_ID} .row .label{font-weight:600}
  #${PANEL_ID} .row .meta{font-size:11px;color:#9ca3af}
  #${PANEL_ID} .toggle{position:relative;width:38px;height:22px;background:#374151;border-radius:999px;
    cursor:pointer;transition:background .15s}
  #${PANEL_ID} .toggle.on{background:#10b981}
  #${PANEL_ID} .toggle.disabled{opacity:.4;cursor:not-allowed}
  #${PANEL_ID} .toggle::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;
    background:#e5e7eb;border-radius:50%;transition:transform .15s}
  #${PANEL_ID} .toggle.on::after{transform:translateX(16px)}
  #${PANEL_ID} .metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}
  #${PANEL_ID} .metric{background:rgba(255,255,255,.04);border-radius:8px;padding:8px 10px}
  #${PANEL_ID} .metric .v{font-size:18px;font-weight:700;color:#fbbf24}
  #${PANEL_ID} .metric .k{font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px}
  #${PANEL_ID} .state{margin-top:14px;padding:10px;border-radius:10px;background:rgba(255,255,255,.04);
    text-align:center;font-weight:700;letter-spacing:.5px;font-size:14px}
  #${PANEL_ID} .blurb{font-size:11px;color:#9ca3af;line-height:1.5;margin-top:12px;padding-top:12px;
    border-top:1px solid rgba(255,255,255,.07)}
  `;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

function fmt(n, digits = 0, fallback = "—") {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return n.toFixed(digits);
}

export function mountUi(Bio) {
  if (typeof document === "undefined") return;
  if (document.getElementById(BADGE_ID)) return; // already mounted

  injectStyles();

  const caps = Bio.capabilities();

  // Badge
  const badge = document.createElement("div");
  badge.id = BADGE_ID;
  badge.title = "Biosignals — click to open";
  badge.innerHTML = `<span class="dot"></span><span class="text">BIO</span>`;
  document.body.appendChild(badge);
  // Pulse 3 times on first ever mount to draw attention
  badge.classList.add("attract");
  setTimeout(() => badge.classList.remove("attract"), 6500);

  // Panel
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <h3>Biosignals</h3>
    <div class="sub">Ambient. Optional. Privacy-first.</div>

    <div class="row">
      <div>
        <div class="label">Heart rate (camera)</div>
        <div class="meta" id="bio-rppg-meta">${caps.rppg ? "Ready" : "Camera not supported"}</div>
      </div>
      <div class="toggle ${caps.rppg ? "" : "disabled"}" id="bio-rppg-toggle"></div>
    </div>

    <div class="row">
      <div>
        <div class="label">EEG (Muse headband)</div>
        <div class="meta" id="bio-eeg-meta">${caps.eeg ? "Ready" : "Web Bluetooth not supported"}</div>
      </div>
      <div class="toggle ${caps.eeg ? "" : "disabled"}" id="bio-eeg-toggle"></div>
    </div>

    <div class="state" id="bio-state-label" style="background:rgba(107,114,128,.18);color:#6b7280">—</div>

    <div class="metrics">
      <div class="metric"><div class="v" id="bio-bpm">—</div><div class="k">BPM</div></div>
      <div class="metric"><div class="v" id="bio-hrv">—</div><div class="k">HRV (ms)</div></div>
      <div class="metric"><div class="v" id="bio-focus">—</div><div class="k">Focus</div></div>
      <div class="metric"><div class="v" id="bio-flow">—</div><div class="k">Flow min</div></div>
    </div>

    <div id="bio-tier-block" style="margin-top:12px;padding:10px 12px;border-radius:10px;
      background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <div><span style="font-size:10px;color:#9ca3af;letter-spacing:.5px;text-transform:uppercase">Tier</span>
        <div id="bio-tier-name" style="font-weight:800;font-size:15px">Initiate</div></div>
        <div id="bio-tier-streak" style="font-size:11px;color:#9ca3af">— day streak</div>
      </div>
      <div style="margin-top:8px;height:5px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden">
        <div id="bio-tier-fill" style="height:100%;background:#fbbf24;width:0%;transition:width .6s ease"></div>
      </div>
      <div id="bio-tier-next" style="font-size:10px;color:#9ca3af;margin-top:4px">—</div>
    </div>

    <div style="margin-top:12px;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px">
      Daily mind training
    </div>
    <div id="bio-drill-host"></div>

    <div class="blurb">
      Each sensor is useful alone. Combining heart rate + EEG unlocks
      <b>Flow state</b> (calm body + sharp mind) and <b>Berserker</b>
      (charged body + sharp mind) — neither sensor can detect those alone.
    </div>
  `;
  document.body.appendChild(panel);

  const rppgToggle = panel.querySelector("#bio-rppg-toggle");
  const eegToggle  = panel.querySelector("#bio-eeg-toggle");
  const rppgMeta   = panel.querySelector("#bio-rppg-meta");
  const eegMeta    = panel.querySelector("#bio-eeg-meta");

  // Friendly banner for browsers that can't run bio at all (Safari/iOS, Firefox EEG-only).
  if (!caps.rppg && !caps.eeg) {
    const note = document.createElement("div");
    note.style.cssText = `position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99998;
      max-width:520px;padding:10px 16px;background:rgba(13,17,23,.92);color:#fbbf24;
      border:1px solid rgba(251,191,36,.35);border-radius:10px;font:600 12px/1.4 system-ui,sans-serif;
      box-shadow:0 8px 24px rgba(0,0,0,.4);text-align:center;cursor:pointer`;
    note.textContent = "Biosignals work in Chrome / Edge desktop. The game still plays great here — open this in Chrome to unlock bio.";
    note.title = "Click to dismiss";
    note.addEventListener("click", () => note.remove());
    setTimeout(() => { note.style.opacity = "0"; note.style.transition = "opacity .5s"; setTimeout(() => note.remove(), 600); }, 8000);
    document.body.appendChild(note);
  } else if (!caps.eeg) {
    // rPPG works (Chrome) but EEG doesn't (rare — Chrome should have both).
    eegMeta.textContent = "Web Bluetooth blocked in this browser";
  }

  let open = false;
  const setOpen = (v) => {
    open = v;
    panel.classList.toggle("open", open);
  };
  badge.addEventListener("click", () => setOpen(!open));
  document.addEventListener("click", (e) => {
    if (!open) return;
    if (panel.contains(e.target) || badge.contains(e.target)) return;
    setOpen(false);
  });
  const stateEl    = panel.querySelector("#bio-state-label");
  const bpmEl      = panel.querySelector("#bio-bpm");
  const hrvEl      = panel.querySelector("#bio-hrv");
  const focusEl    = panel.querySelector("#bio-focus");
  const flowEl     = panel.querySelector("#bio-flow");
  const badgeText  = badge.querySelector(".text");
  const badgeDot   = badge.querySelector(".dot");

  rppgToggle.addEventListener("click", async () => {
    if (rppgToggle.classList.contains("disabled")) return;
    if (rppgToggle.classList.contains("on")) {
      await Bio.stopRppg();
    } else {
      await Bio.start({ rppg: true });
    }
  });

  eegToggle.addEventListener("click", async () => {
    if (eegToggle.classList.contains("disabled")) return;
    if (eegToggle.classList.contains("on")) {
      await Bio.stopEeg();
    } else {
      await Bio.start({ eeg: true });
    }
  });

  Bio.on("rppgStatus", ({ status, detail }) => {
    rppgToggle.classList.toggle("on", status === "warming" || status === "live");
    rppgMeta.textContent = detail || labelStatus(status, "rPPG");
    refreshBadge();
  });
  Bio.on("eegStatus", ({ status, detail }) => {
    eegToggle.classList.toggle("on", status === "warming" || status === "live");
    eegMeta.textContent = detail || labelStatus(status, "EEG");
    refreshBadge();
  });
  Bio.on("rppgMetric", () => refreshMetrics());
  Bio.on("eegMetric", () => refreshMetrics());
  Bio.on("stateChange", () => refreshState());

  // Periodic refresh for warming progress and health snapshot
  setInterval(() => {
    refreshMetrics();
    refreshState();
    refreshBadge();
    if (open) refreshDrills();
  }, 1000);

  function refreshDrills() {
    const host = panel.querySelector("#bio-drill-host");
    if (host) renderDrillList(host);
  }

  function refreshBadge() {
    const s = Bio.status();
    const liveR = s.rppg === "live", warmR = s.rppg === "warming", errR = s.rppg === "error";
    const liveE = s.eeg === "live",  warmE = s.eeg === "warming",  errE = s.eeg === "error";
    badgeDot.className = "dot";
    if (liveR || liveE) badgeDot.classList.add("live");
    else if (warmR || warmE) badgeDot.classList.add("warming");
    else if (errR || errE) badgeDot.classList.add("error");
    const labels = [];
    if (s.rppg !== "off") labels.push(`HR ${shortStatus(s.rppg)}`);
    if (s.eeg  !== "off") labels.push(`EEG ${shortStatus(s.eeg)}`);
    badgeText.textContent = labels.length ? labels.join(" · ") : "Bio: off";
  }

  function refreshMetrics() {
    const m = Bio.metrics();
    bpmEl.textContent = fmt(m.rppg?.bpm, 0);
    hrvEl.textContent = fmt(m.rppg?.hrv, 0);
    focusEl.textContent = m.eeg?.focus != null ? fmt(m.eeg.focus * 100, 0) + "%" : "—";
    const h = Bio.health();
    flowEl.textContent = fmt(h.today.flowMinutes, 1);
    refreshTier(h);
  }

  function refreshTier(h) {
    const tier = currentTier(h);
    const next = nextTier(h);
    const nameEl = panel.querySelector("#bio-tier-name");
    const streakEl = panel.querySelector("#bio-tier-streak");
    const fillEl = panel.querySelector("#bio-tier-fill");
    const nextEl = panel.querySelector("#bio-tier-next");
    if (nameEl) { nameEl.textContent = tier.name; nameEl.style.color = tier.color; }
    if (streakEl) streakEl.textContent = `${h.streak} day streak`;
    if (fillEl) {
      fillEl.style.width = (next.progress * 100).toFixed(0) + "%";
      fillEl.style.background = (next.tier?.color) || tier.color;
    }
    if (nextEl) nextEl.textContent = next.tier
      ? `Next: ${next.tier.name} — ${(next.progress * 100).toFixed(0)}%`
      : "Highest tier reached.";
  }

  function refreshState() {
    const s = Bio.cognitiveState();
    stateEl.textContent = STATE_LABEL[s] || "—";
    stateEl.style.background = hexA(STATE_COLOR[s] || "#6b7280", 0.18);
    stateEl.style.color = STATE_COLOR[s] || "#9ca3af";
  }
}

function labelStatus(status, prefix) {
  switch (status) {
    case "off": return `${prefix} off`;
    case "warming": return `${prefix} warming up — ambient calibration`;
    case "live": return `${prefix} live`;
    case "error": return `${prefix} error`;
    case "unsupported": return `${prefix} not supported in this browser`;
    default: return status;
  }
}
function shortStatus(s) {
  return s === "live" ? "live" : s === "warming" ? "warming" : s === "error" ? "error" : s;
}
function hexA(hex, a) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
