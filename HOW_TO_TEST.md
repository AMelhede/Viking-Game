# How to test

## Run the game

**Windows:** double-click `start-game.bat`
**Mac/Linux:** `./start-game.sh`

Both spin up a local Node server on `http://localhost:8000/` and open it in your default browser. Node is the only prerequisite.

The game cannot be opened directly via `file://` anymore — biosignal APIs (camera, Web Bluetooth) require a secure context (HTTPS or localhost).

---

## Smoke tests (golden path)

### 1. Game runs cleanly with bio off
- Open the game. The daily-bonus modal appears, claim it.
- Pick Easy difficulty, hit Start.
- Confirm: viking runs, score climbs, mead is collectable, jumping/ducking work.
- Open the browser DevTools Console (F12). Should see no errors.

### 2. Boss patrols back-and-forth and is killable
- Get to a score of ~5,000 on level 1, OR start a higher level directly.
- Watch for the "BOSS APPROACHING" notification.
- The boss (King Alfred etc.) should walk **back and forth** across the screen — not get stuck on the left or right edge.
- Jump on the boss's head from above to damage it. Each stomp -1 HP. Boss dies when HP hits 0.
- Side collision (running into boss) should cost lives.
- Killing a boss should:
  - Trigger victory fanfare audio
  - Add bonus score (varies by level)
  - Show "BOSS DEFEATED!" notification
  - Unlock the boss achievement

### 3. Levels feel different
- Play level 1 (York), then level 2 (Dublin), level 3 (Hedeby).
- Confirm: different background colors, different enemy sprites, different boss, different powerups.
- Verify the level-music shifts with the level.

### 4. Audio
The audio is fully procedural (Web Audio API). After the audio overhaul:
- Menu music: deeper drones, mellower horn (triangle, not sawtooth), wind ambient is now real noise (sounds like wind, not a buzzsaw).
- Gameplay music: the melody plays **fixed Norse-modal phrases** instead of random pentatonic notes — no more atonal wandering.
- War drums: layered noise burst on top of the sub for proper taiko-style "thud."
- Victory fanfare on boss death sounds clean.

If anything still sounds off, note the specific moment and we'll iterate.

---

## Bio sensor tests

The bio panel is in the bottom-right corner. Click the badge to open it.

### A. Heart rate (rPPG, requires camera)
1. Click the panel, toggle **Heart rate** on.
2. Browser asks for camera permission. Allow.
3. Badge turns **amber** ("warming"). Sit visible to camera.
4. Within ~10–20 seconds, badge turns **green** ("live") and a BPM appears in the panel.
5. Move around (raise heart rate) → BPM should rise within a few seconds.

**Game effect with rPPG only:**
- HR above your rolling baseline → `aroused` state → ~1.25× score, orange tint
- HR below baseline → `calm` state → +0.75 mead/sec passive trickle, cyan tint
- A toast appears each time the state changes

### B. EEG (Muse headband, requires Bluetooth and a paired Muse)
1. Power on Muse, ensure it's not paired with another app.
2. In the bio panel, toggle **EEG** on.
3. Browser shows a Bluetooth picker. Select your Muse.
4. Badge turns amber, then green within a few seconds.
5. Focus level shows in the panel as a percentage.

**Game effect with EEG only:**
- High focus → `focused` state → ~1.25× score, blue tint
- Low focus → `distracted` state (no penalty)

### C. Both sensors → 2×2 cognitive states (the centerpiece)
With both rPPG and EEG live:
- **Calm body + sharp mind** → **Flow** → 2× score, gold tint, "Odin's Sight" toast
- **Charged body + sharp mind** → **Berserker** → 1.5× score, red tint
- **Calm body + relaxed mind** → **Meditation** → +1.5 mead/sec, teal tint
- **Charged body + relaxed mind** → **Frantic** → no penalty, recover quickly

These states are **only detectable with both sensors** — that's the upsell.

### D. Post-run debrief
After bio is active, end a run (let yourself die). A debrief overlay appears showing:
- Your end-of-run BPM, HRV, focus
- Time spent in flow / berserker that run
- Your current identity tier (Initiate → Skald → Berserker → Jarl → Konungr) and progress to the next
- A contextual insight (e.g. "HRV is up 12% vs your 7-day average")

### E. Mind-training drills
In the bio panel, scroll down to "Daily mind training." Each is gated by which sensor is on:
- **Skald's Breath** (rPPG) — 60s of 4-7-8 paced breathing, scored on HRV growth
- **Odin's Eye** (EEG) — 60s of sustained attention on a drifting rune, scored on focus stability
- **Berserker's Calm** (both) — 90s of staying calm under chaotic visual stimuli

Each drill is one-per-day. Completion logged to localStorage; streak persists.

---

## Failure paths to test

- **Deny camera permission** → bio panel says "Camera denied" with red dot. Game keeps running.
- **No Muse / cancel BT picker** → bio panel says "No Muse selected." Game keeps running.
- **Disconnect Muse mid-game** → bio status drops to error. Game keeps running.
- **Switch tabs / minimize** → game pauses (browser throttles rAF). Resume on focus.

---

## Repository layout

- `index.html` — game (single-file vanilla JS, ~10k lines).
- `js/bio/` — bio adapter (the only thing the game ever talks to).
  - `index.js`, `state.js`, `health.js`, `identity.js`, `effects.js`, `debrief.js`, `drills.js`, `ui.js`
  - `sensors/rppg.js`, `sensors/eeg.js`, `sensors/eegBands.js`
- `vendor/elata/` — vendored Elata SDK (`rppg-web`, `eeg-web`, `eeg-web-ble`) + WASM.
- `server.js` — zero-dep static server with proper WASM MIME types.
- `start-game.{bat,sh}` — launchers.

## Browser support

| Browser | rPPG | EEG (Muse) |
|---|---|---|
| Chrome (desktop) | yes | yes |
| Edge (desktop) | yes | yes |
| Chrome (Android) | yes | yes |
| Safari (any) | yes | no (no Web Bluetooth) |
| Firefox | yes | no |

The game itself works in any modern browser with bio disabled.
