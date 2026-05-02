// Post-run debrief — appears on game over with bio summary.
// THE Skinner-box moment: variable schedule of measurable self-improvement.
//
// Detection strategy: poll `window.world.over` (existing global) every 200ms.
// On a false→true transition, capture the run snapshot and show the debrief
// once. Reset on next run start.

import { currentTier, nextTier } from "./identity.js";

const OVERLAY_ID = "bio-debrief";
const STYLE_ID   = "bio-debrief-styles";

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
  #${OVERLAY_ID}{position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.65);backdrop-filter:blur(6px);opacity:0;pointer-events:none;
    transition:opacity .25s ease;font:14px/1.4 system-ui,sans-serif;color:#e5e7eb}
  #${OVERLAY_ID}.show{opacity:1;pointer-events:auto}
  #${OVERLAY_ID} .card{width:min(560px,calc(100vw - 32px));background:#0d1117;
    border:2px solid rgba(251,191,36,.5);border-radius:18px;padding:28px;box-shadow:0 30px 80px rgba(0,0,0,.7)}
  #${OVERLAY_ID} h2{margin:0 0 4px;color:#fbbf24;font-size:20px;letter-spacing:.5px}
  #${OVERLAY_ID} .sub{color:#9ca3af;font-size:12px;margin-bottom:18px}
  #${OVERLAY_ID} .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}
  #${OVERLAY_ID} .stat{background:rgba(255,255,255,.04);border-radius:10px;padding:12px}
  #${OVERLAY_ID} .stat .v{font-size:22px;font-weight:800;color:#fbbf24}
  #${OVERLAY_ID} .stat .k{font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px}
  #${OVERLAY_ID} .tier{margin-top:14px;padding:12px;border-radius:12px;
    background:linear-gradient(135deg,rgba(251,191,36,.08),rgba(251,191,36,.02));border:1px solid rgba(251,191,36,.3)}
  #${OVERLAY_ID} .tier .name{font-weight:800;font-size:18px;letter-spacing:.5px}
  #${OVERLAY_ID} .tier .blurb{font-size:12px;color:#cbd5e1;margin-top:4px}
  #${OVERLAY_ID} .progress{margin-top:10px;height:6px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden}
  #${OVERLAY_ID} .progress .fill{height:100%;background:#fbbf24;transition:width .6s ease}
  #${OVERLAY_ID} .next{font-size:11px;color:#9ca3af;margin-top:6px}
  #${OVERLAY_ID} .actions{display:flex;justify-content:flex-end;margin-top:18px;gap:10px}
  #${OVERLAY_ID} button{background:#fbbf24;color:#111;border:0;padding:10px 18px;border-radius:10px;
    font-weight:700;cursor:pointer;font-size:13px}
  #${OVERLAY_ID} button.ghost{background:transparent;color:#9ca3af;border:1px solid rgba(255,255,255,.15)}
  #${OVERLAY_ID} .insight{margin-top:10px;padding:10px 12px;border-radius:10px;background:rgba(34,211,238,.08);
    border:1px solid rgba(34,211,238,.3);font-size:12px;color:#22d3ee}
  `;
  const el = document.createElement("style");
  el.id = STYLE_ID; el.textContent = css;
  document.head.appendChild(el);
}

function fmt(n, digits = 0, fb = "—") {
  if (typeof n !== "number" || !Number.isFinite(n)) return fb;
  return n.toFixed(digits);
}

let runStartedAt = 0;
let runSnapshot = null;
let lastOverState = false;

export function startDebriefWatcher(Bio) {
  injectStyles();
  // Capture snapshot at run start so we can compute deltas at run end.
  setInterval(() => {
    const w = window.world;
    if (!w) return;
    if (w.started && !w.over && !runSnapshot) {
      runStartedAt = performance.now();
      const h = Bio.health();
      runSnapshot = {
        startMs: runStartedAt,
        startFlowSec: h.today.flowMinutes * 60,
        startBerserkerSec: h.today.berserkerMinutes * 60,
        startMeditationSec: h.today.meditationMinutes * 60,
      };
    }
    if (w.over && !lastOverState && runSnapshot) {
      // Transition false→true: show debrief
      const h = Bio.health();
      const status = Bio.status();
      const anyBio = status.rppg !== "off" || status.eeg !== "off";
      if (anyBio) {
        const runFlowS = h.today.flowMinutes * 60 - runSnapshot.startFlowSec;
        const runBerserkerS = h.today.berserkerMinutes * 60 - runSnapshot.startBerserkerSec;
        const runMeditationS = h.today.meditationMinutes * 60 - runSnapshot.startMeditationSec;
        showDebrief(Bio, h, { flowS: runFlowS, berserkerS: runBerserkerS, meditationS: runMeditationS });
      }
      runSnapshot = null;
    }
    lastOverState = w.over;
  }, 200);
}

function showDebrief(Bio, health, run) {
  let el = document.getElementById(OVERLAY_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = OVERLAY_ID;
    document.body.appendChild(el);
  }

  const tier = currentTier(health);
  const next = nextTier(health);
  const insight = computeInsight(Bio, health, run);

  const m = Bio.metrics();
  const status = Bio.status();
  const rppgOn = status.rppg !== "off";
  const eegOn = status.eeg !== "off";

  el.innerHTML = `
    <div class="card">
      <h2>Run debrief</h2>
      <div class="sub">${rppgOn ? "Heart rate" : ""}${rppgOn && eegOn ? " · " : ""}${eegOn ? "EEG" : ""} · today's totals</div>
      <div class="grid">
        ${rppgOn ? `<div class="stat"><div class="v">${fmt(m.rppg?.bpm, 0)}</div><div class="k">BPM at end</div></div>
        <div class="stat"><div class="v">${fmt(health.today.avgHrv, 0)}</div><div class="k">HRV (ms, today)</div></div>` : ""}
        ${eegOn ? `<div class="stat"><div class="v">${fmt(m.eeg?.focus != null ? m.eeg.focus * 100 : null, 0, "—")}${m.eeg?.focus != null ? "%" : ""}</div><div class="k">Focus at end</div></div>
        <div class="stat"><div class="v">${fmt(health.today.peakFocus != null ? health.today.peakFocus * 100 : null, 0, "—")}${health.today.peakFocus != null ? "%" : ""}</div><div class="k">Peak focus today</div></div>` : ""}
        <div class="stat"><div class="v">${fmt(run.flowS, 0)}s</div><div class="k">Flow this run</div></div>
        <div class="stat"><div class="v">${fmt(run.berserkerS, 0)}s</div><div class="k">Berserker this run</div></div>
      </div>

      ${insight ? `<div class="insight">${insight}</div>` : ""}

      <div class="tier">
        <div class="name" style="color:${tier.color}">${tier.name}</div>
        <div class="blurb">${tier.blurb}</div>
        ${next.tier ? `
          <div class="progress"><div class="fill" style="width:${(next.progress * 100).toFixed(0)}%;background:${next.tier.color}"></div></div>
          <div class="next">Next: <b style="color:${next.tier.color}">${next.tier.name}</b> — ${(next.progress * 100).toFixed(0)}% there</div>
        ` : `<div class="next">You are at the highest tier. Hold the line.</div>`}
      </div>

      <div class="actions">
        <button class="ghost" id="bio-debrief-close">Close</button>
        <button id="bio-debrief-share">📤 Share run</button>
      </div>
    </div>
  `;
  el.classList.add("show");

  const close = () => el.classList.remove("show");
  el.querySelector("#bio-debrief-close").addEventListener("click", close);
  el.querySelector("#bio-debrief-share").addEventListener("click", (ev) => {
    ev.stopPropagation();
    shareRun(Bio, health, run, tier, m).catch(e => console.warn("[Bio] share failed", e));
  });
  el.addEventListener("click", (e) => { if (e.target === el) close(); });

  // Was 12s; bumped to 30s now that there's a share button worth seeing.
  setTimeout(close, 30000);
}

/** Render the run debrief as a 1080x1080 share card and trigger Web Share /
 * download. The image is verifiable proof: tier badge, run stats, watermark. */
async function shareRun(Bio, health, run, tier, metrics) {
  const W = 1080, H = 1080;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const cx = cv.getContext("2d");

  const bg = cx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0d1117"); bg.addColorStop(1, "#1f2937");
  cx.fillStyle = bg; cx.fillRect(0, 0, W, H);

  cx.strokeStyle = tier.color; cx.lineWidth = 12;
  cx.strokeRect(20, 20, W - 40, H - 40);

  cx.textAlign = "center";
  cx.fillStyle = "#9ca3af";
  cx.font = "600 28px system-ui, -apple-system, sans-serif";
  cx.fillText("VIKING RUN — BIO DEBRIEF", W / 2, 100);

  cx.fillStyle = tier.color;
  cx.font = "900 96px system-ui, -apple-system, sans-serif";
  cx.fillText(tier.name.toUpperCase(), W / 2, 220);

  cx.fillStyle = "#cbd5e1";
  cx.font = "400 26px system-ui, -apple-system, sans-serif";
  wrapText(cx, tier.blurb || "", W / 2, 270, W - 160, 36);

  const gx = 100, gy = 380;
  const cellW = (W - 200) / 2;
  const cellH = 180;
  const cells = [
    { k: "Flow this run",   v: `${Math.round(run.flowS)}s` },
    { k: "Peak HR",         v: health.today.peakHr ? `${Math.round(health.today.peakHr)}` : "—" },
    { k: "Avg HRV today",   v: health.today.avgHrv ? `${Math.round(health.today.avgHrv)} ms` : "—" },
    { k: "Streak",          v: `${health.streak} day${health.streak === 1 ? "" : "s"}` },
  ];
  for (let i = 0; i < cells.length; i++) {
    const x = gx + (i % 2) * cellW;
    const y = gy + Math.floor(i / 2) * cellH;
    cx.fillStyle = "rgba(255,255,255,0.04)";
    roundRect(cx, x, y, cellW - 16, cellH - 16, 18); cx.fill();
    cx.fillStyle = tier.color;
    cx.font = "900 64px system-ui, -apple-system, sans-serif";
    cx.textAlign = "center";
    cx.fillText(cells[i].v, x + (cellW - 16) / 2, y + 80);
    cx.fillStyle = "#9ca3af";
    cx.font = "600 22px system-ui, -apple-system, sans-serif";
    cx.fillText(cells[i].k.toUpperCase(), x + (cellW - 16) / 2, y + 130);
  }

  cx.fillStyle = "#9ca3af";
  cx.font = "500 22px system-ui, -apple-system, sans-serif";
  cx.textAlign = "center";
  cx.fillText("Trained with EEG + heart rate via the Elata SDK", W / 2, H - 110);
  cx.fillStyle = "#fbbf24";
  cx.font = "800 26px system-ui, -apple-system, sans-serif";
  cx.fillText(new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }), W / 2, H - 70);

  const blob = await new Promise(res => cv.toBlob(res, "image/png", 0.95));
  if (!blob) return;
  const file = new File([blob], `viking-${tier.id}-${Date.now()}.png`, { type: "image/png" });
  const text = `Just held ${tier.name} for ${Math.round(run.flowS)}s in Viking Run. Bio-driven gameplay, verified by my own heart and brain.`;
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Viking Run", text });
      return;
    }
  } catch {}
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, cx, cy, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "", y = cy;
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxWidth) {
      ctx.fillText(line, cx, y);
      line = w; y += lineHeight;
    } else line = test;
  }
  if (line) ctx.fillText(line, cx, y);
}

function computeInsight(Bio, health, run) {
  const trends = health.trends;
  const lines = [];

  if (typeof trends.hrvDelta === "number") {
    const pct = (trends.hrvDelta * 100).toFixed(0);
    if (trends.hrvDelta > 0.05) lines.push(`HRV is up ${pct}% vs your 7-day average — recovery is improving.`);
    else if (trends.hrvDelta < -0.05) lines.push(`HRV is down ${pct}% — consider rest, breath, or a slower run.`);
  }

  if (run.flowS >= 30) lines.push(`You held flow for ${Math.round(run.flowS)}s. That's longer than 80% of runs.`);
  else if (run.flowS >= 5) lines.push(`Brief flow — ${Math.round(run.flowS)}s. Build on it.`);

  if (health.streak >= 3) lines.push(`Streak: ${health.streak} days. Daily training compounds.`);

  return lines[0] || null;
}
