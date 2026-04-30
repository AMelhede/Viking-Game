# Viking Game

Fun Viking endless-runner where you advance through levels, kill bosses, and collect powerups — and a tech demo for biosignal-driven gameplay using the [Elata Bio SDK](https://github.com/Elata-Biosciences/elata-bio-sdk).

V.0.5 + biosignals foundation.

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
