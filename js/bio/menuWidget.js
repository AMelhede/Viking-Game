// Pre-game menu widgets that surface longitudinal bio progress where the
// player will actually see it: in the start menu, before they hit Play.
//
// Two widgets:
//   1. Weekly flow sparkline + tier strip — "look at the line going up,"
//      the Whoop / Oura compounding-progress hook.
//   2. Skald's Breath morning ritual prompt — once per local day, a
//      one-tap CTA to do the 60s breath drill before today's first run.
//
// Both auto-hide gracefully when there's no data or no sensor support.

import { currentTier, nextTier } from "./identity.js";

const SPARK_ID = "bio-menu-sparkline";
const RITUAL_ID = "bio-menu-ritual";
const RITUAL_KEY = "bio_morning_ritual_v1"; // { date: 'YYYY-MM-DD', done: bool }

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ritualState() {
  try { return JSON.parse(localStorage.getItem(RITUAL_KEY)) || {}; }
  catch { return {}; }
}
function setRitualDone() {
  try { localStorage.setItem(RITUAL_KEY, JSON.stringify({ date: todayKey(), done: true })); } catch {}
}
function ritualDoneToday() {
  const s = ritualState();
  return s.date === todayKey() && s.done;
}

function findHost() {
  // Try to mount inside the existing "Biosignals (Elata SDK)" pane on the
  // start menu. The block is matched by the bioOpenBtn / bioQuickHrBtn
  // siblings.
  const open = document.getElementById("bioOpenBtn");
  if (!open) return null;
  // The pane is the closest div with the bio gradient styling — use
  // the parent of the buttons row.
  let el = open;
  for (let i = 0; i < 5 && el; i++) {
    if (el.parentElement && el.parentElement.style && /linear-gradient/.test(el.parentElement.style.background)) {
      return el.parentElement;
    }
    el = el.parentElement;
  }
  return open.parentElement || null;
}

/** Build a 7-day flow-minutes sparkline as inline SVG. */
function renderSparkline(days) {
  const w = 220, h = 28;
  const max = Math.max(1, ...days.map(d => d || 0));
  const step = w / Math.max(1, days.length - 1);
  const pts = days.map((v, i) => {
    const x = i * step;
    const y = h - 4 - (Math.max(0, v) / max) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polyline fill="none" stroke="#fbbf24" stroke-width="2" stroke-linejoin="round"
        points="${pts.join(" ")}" />
      ${pts.map(p => {
        const [x, y] = p.split(",");
        return `<circle cx="${x}" cy="${y}" r="2" fill="#fbbf24"/>`;
      }).join("")}
    </svg>`;
}

function lastNDaysFlowMinutes(snapshot, n = 7) {
  const today = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const day = snapshot.raw && snapshot.raw[k];
    out.push(day ? (day.flowSeconds || 0) / 60 : 0);
  }
  return out;
}

export function mountMenuWidget(Bio) {
  const host = findHost();
  if (!host) return;

  // Container that holds both widgets above the existing buttons.
  let wrap = document.getElementById(SPARK_ID);
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = SPARK_ID;
    wrap.style.cssText = "margin:8px 0 12px";
    host.insertBefore(wrap, host.firstChild);
  }

  const refresh = () => {
    const snap = Bio.health();
    const tier = currentTier(snap);
    const next = nextTier(snap);
    const days = lastNDaysFlowMinutes(snap, 7);
    const totalFlowMin = days.reduce((a, b) => a + b, 0);
    const todayMin = days[days.length - 1] || 0;
    const hasAny = totalFlowMin > 0 || (snap.today && (snap.today.peakHr || snap.today.peakFocus));

    // No data yet → soft hint instead of a hidden empty card
    const sparkOrHint = hasAny
      ? renderSparkline(days)
      : `<div style="font-size:11px;color:#9ca3af;font-style:italic">Your weekly flow line will appear here once bio is on.</div>`;

    wrap.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;
        padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.04);
        border:1px solid rgba(255,255,255,.07)">
        <div>
          <div style="font:600 10px/1 system-ui,sans-serif;letter-spacing:1px;color:#9ca3af;text-transform:uppercase;margin-bottom:6px">
            This week — flow minutes
          </div>
          ${sparkOrHint}
          <div style="margin-top:6px;font:700 12px/1 system-ui,sans-serif;color:#fbbf24">
            ${totalFlowMin.toFixed(1)} min · today ${todayMin.toFixed(1)}
          </div>
        </div>
        <div style="text-align:right">
          <div style="font:900 13px/1 system-ui,sans-serif;color:${tier.color};letter-spacing:.5px">
            ${tier.name}
          </div>
          <div style="font:600 10px/1.2 system-ui,sans-serif;color:#9ca3af;margin-top:4px">
            ${snap.streak} day streak
          </div>
          ${next.tier ? `
            <div style="margin-top:6px;height:3px;width:60px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;margin-left:auto">
              <div style="height:100%;width:${(next.progress * 100).toFixed(0)}%;background:${next.tier.color}"></div>
            </div>` : ""}
        </div>
      </div>
    `;
  };

  refresh();
  // Refresh whenever bio metrics change so the line moves in near-real time.
  Bio.on("rppgMetric", refresh);
  Bio.on("eegMetric", refresh);
  Bio.on("stateChange", refresh);
}

/** Skald's Breath morning ritual: 60s 4-7-8 breath drill, once per day. */
export function mountMorningRitual(Bio) {
  const caps = Bio.capabilities();
  if (!caps.rppg) return; // no camera, no ritual
  if (ritualDoneToday()) return;

  const host = findHost();
  if (!host) return;
  if (document.getElementById(RITUAL_ID)) return;

  const el = document.createElement("button");
  el.id = RITUAL_ID;
  el.type = "button";
  el.style.cssText = [
    "display:flex", "align-items:center", "gap:10px",
    "width:100%", "padding:10px 12px", "margin:0 0 10px",
    "border-radius:10px", "border:1px solid rgba(34,211,238,.4)",
    "background:linear-gradient(135deg,rgba(34,211,238,.18),rgba(34,211,238,.04))",
    "color:#22d3ee", "font:700 12px/1.2 system-ui,sans-serif",
    "cursor:pointer", "text-align:left",
    "transition:transform .15s ease",
  ].join(";");
  el.innerHTML = `
    <span style="font-size:18px">🌅</span>
    <span style="flex:1">
      <div style="color:#22d3ee;font-weight:800;letter-spacing:.5px">Skald's Breath — morning ritual</div>
      <div style="color:#9ca3af;font-weight:500;font-size:11px;margin-top:2px">60s of paced breath · sets today's HRV baseline · once per day</div>
    </span>
    <span style="font-size:18px;color:#22d3ee">→</span>
  `;
  el.addEventListener("mouseenter", () => el.style.transform = "translateY(-1px)");
  el.addEventListener("mouseleave", () => el.style.transform = "");
  el.addEventListener("click", async () => {
    // Auto-enable rPPG if not already, then run the Skald's Breath drill via
    // the existing drills module. The bio panel handles the actual UI.
    try {
      const status = Bio.status();
      if (status.rppg !== "live" && status.rppg !== "warming") {
        await Bio.start({ rppg: true });
      }
    } catch (e) { console.warn("[Bio] morning ritual rPPG start failed", e); }

    // Open the bio panel and scroll to drills.
    const badge = document.getElementById("bio-badge");
    if (badge) badge.click();

    // Mark done so we don't nag.
    setRitualDone();

    // Hide the prompt
    el.style.display = "none";

    // Invite-style toast
    const toast = document.createElement("div");
    toast.textContent = "Open the bio panel and tap Skald's Breath to begin.";
    toast.style.cssText = "position:fixed;top:18px;left:50%;transform:translateX(-50%);background:rgba(13,17,23,.95);color:#22d3ee;padding:12px 20px;border-radius:12px;border:1px solid rgba(34,211,238,.4);font:700 13px/1 system-ui,sans-serif;z-index:99999;box-shadow:0 12px 32px rgba(0,0,0,.5)";
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.transition = "opacity .4s"; toast.style.opacity = "0"; setTimeout(() => toast.remove(), 500); }, 4000);
  });
  host.insertBefore(el, host.firstChild);
}
