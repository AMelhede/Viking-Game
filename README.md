# Viking Game

Fun Viking endless-runner where you advance through levels, kill bosses, and collect powerups — playable with **rPPG** (webcam/phone camera heart rate) and **EEG** brain devices like Muse to drive gameplay from your real biosignals.

Sentiment analysis and additional BCI functionality coming next.

**V.0.6 in progress** — about to be redeployed to the closed beta of the [Elata app store](https://app.elata.bio/) with functional rPPG and brain-device support. Let Andre know if you want an early-access code.

This repo is also the reference integration for the [Elata Bio SDK](https://github.com/Elata-Biosciences/elata-bio-sdk).

---

## Run it

Biosignals (heart rate via webcam, EEG via Muse) require a secure context, so the game runs through a tiny local server instead of opening `index.html` directly.

**Windows:** double-click `start-game.bat`
**Mac / Linux:** `./start-game.sh`

Both open `http://localhost:8000/` in your default browser. Node.js is the only prerequisite.

## Biosignals

Bio is opt-in and ambient — there are no calibration screens. Once you turn on a sensor in the bottom-right Bio panel, it learns your baseline from natural play.

| Sensor | Hardware | Measures | Game effect |
|---|---|---|---|
| **rPPG** | Webcam | Heart rate, HRV, arousal | Berserker mode under exertion; passive mead while calm |
| **EEG** | Muse headband (Bluetooth) | Focus, calm, flow | Odin's Sight (slowed time) under sustained focus |
| **Both** | — | The 2×2 of body × mind | **Flow state** (calm body + sharp mind) — only detectable with both sensors |

Each sensor is useful alone. Combining them unlocks states neither can detect on its own.

## Repository

- `index.html` — game (single-file, vanilla JS).
- `js/bio/` — biosignal adapter. Game code only ever talks to `window.Bio`.
- `vendor/elata/` — vendored Elata SDK (ESM + WASM).
- `server.js` — zero-dep static server with proper WASM MIME types.
- `start-game.{bat,sh}` — launchers.

See [HOW_TO_TEST.md](HOW_TO_TEST.md) for the full smoke-test walkthrough.
