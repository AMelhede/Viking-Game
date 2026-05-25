// 3D viking runner. Three lanes, jump+slide. Reads window.Bio if present.

import * as THREE from "three";
import { Water } from "three/addons/objects/Water.js";
// Real atmospheric Sky shader (Hosek-Wilkie scattering with sun position).
// This replaces the previous custom gradient-sphere. Hosek-Wilkie is
// the same physically-based model used in feature films for daytime sky.
import { Sky } from "three/addons/objects/Sky.js";
// Postprocessing. three layered passes turn procedural geometry into
// something that reads as "real lit world":
//   Bloom   . emissive highlights bleed (runes/Mjölnir/fire)
//   SSAO    . screen-space ambient occlusion grounds objects in
//              contact shadows (the single biggest "object weight"
//              cue in cinematic games; rocks/trees stop floating)
//   LUT     . cinematic colour grade via channel-mix shader (cool
//              shadows, warm highlights, desaturate midtones . 
//              same grade family as Northman / Vikings / The 13th
//              Warrior)
//   FXAA    . final AA pass over the post chain
import { EffectComposer }   from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass }       from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass }  from "three/addons/postprocessing/UnrealBloomPass.js";
import { SSAOPass }         from "three/addons/postprocessing/SSAOPass.js";
import { ShaderPass }       from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader }       from "three/addons/shaders/FXAAShader.js";
// HDRI image-based lighting. feeds every PBR material a real-world
// environment map so reflections + sky-lit colour come for free.
import { RGBELoader }       from "three/addons/loaders/RGBELoader.js";
// Real rigged GLB character loading. The Soldier.glb hosted on
// threejs.org/examples is a CC0 rigged human with built-in walk/run
// animations. when it loads it replaces the capsule player and gives
// the world its single biggest "this is real not a toy" cue.
// NOTE: Three.js r160's SkeletonUtils exports individual functions
// (clone, retargetClip, ...), NOT a `SkeletonUtils` object. Importing
// the wrong symbol previously broke the entire module load (game
// wouldn't start at all). We only load Soldier once and never clone
// him, so the import was unnecessary in the first place. removed.
import { GLTFLoader }       from "three/addons/loaders/GLTFLoader.js";

// Lane 0 = visually leftmost on screen. Because the camera looks toward +Z
// with default up = +Y, the camera's right vector is -X, so world +X appears
// on the LEFT side of the screen. Lane 0 must therefore be at world x=+3.4.
const LANES = [3.4, 0, -3.4];
const GROUND_WIDTH = 60;
const CHUNK_LENGTH = 60;
const CHUNK_COUNT = 6;
const VIEW_DEPTH = CHUNK_LENGTH * CHUNK_COUNT;
// Peak jump height = v²/(2g). With v=16, g=30 → peak 4.27m, up + down ≈
// 1.07s aloft. Previous v=12 → peak 2.4m which was lower than the
// tallest obstacles (ice 2.5m, boulder 2.2m), so jumps "didn't work"
// even when the player was doing the right thing. Player-reported bug:
// "u cannot even surpass obstacles by jumping omg". Fixed by giving
// the jump real headroom.
const JUMP_VELOCITY = 16;
const GRAVITY = 30;
const SLIDE_DURATION = 0.36;
const BASE_SPEED = 22;
const MAX_SPEED = 60;

// Norse cosmology biome cycle. Distance ranges are absolute metres from
// run start; after the last range the cycle wraps so the run never ends.
// `fog`+`sky` colours drive the per-frame palette ease. `pitch` is a
// semitone offset for the music loop so each realm has its own modal
// flavour without rewriting the melody. `boss` names the entrance
// encounter that fires at the start of each biome (after Midgard).
// 120m each so realms cycle within a normal 30s run. At BASE_SPEED
// 22 m/s that's first transition in ~5.5s. Midgard is brief on
// purpose so the player sees Jötunheim's icy palette + JÖTUNN boss
// within their first attempts. Boss spawns 30m ahead so they meet
// the boss within ~1.5s of the entrance banner firing.
const BIOMES = [
  { name: "Midgard",    length: 120, fog: 0xc4d2dc,
    sky: [0x9cb6cc, 0xc2d2dd, 0xdee7ec, 0xc4d2dc], pitch: 0,
    boss: null },
  { name: "Jötunheim",  length: 120, fog: 0x9ab8d0,
    sky: [0x6a8aaa, 0x9ab8d0, 0xc8dceb, 0x9ab8d0], pitch: -2,
    boss: "jotunn" },
  { name: "Muspelheim", length: 120, fog: 0xc06840,
    sky: [0x602010, 0xb04020, 0xe88040, 0xc06840], pitch: 1,
    boss: "surtr" },
  { name: "Asgard",     length: 120, fog: 0xe8c878,
    sky: [0xb08038, 0xe8b860, 0xffe8b0, 0xe8c878], pitch: 4,
    boss: "valkyrie" },
];
// Total cycle length. after this the player loops back to Midgard
// with biomeCycle++ for the score modifier.
const BIOME_CYCLE_LENGTH = BIOMES.reduce((s, b) => s + b.length, 0);

const STORE_KEY = "valhalla.v1";
const SKALD_KEY = "valhalla.skaldId";
const SKALD_NAME_KEY = "valhalla.skaldName";

// ---------------- Localization ----------------
// Minimal i18n. Only the most-visible UI strings are translated. The
// game world copy (Skald narration, biome names, kennings) stays
// English because the saga voice doesn't translate cleanly.
const I18N_DICT = {
  en: {
    run: "Run", runAgain: "Run again", paused: "Held", resume: "Walk on",
    changesAfterRefresh: "Refresh the page to apply.",
    bindBody: "Bind Body", sagaSoFar: "Saga so far",
  },
  es: {
    run: "Corre", runAgain: "Corre otra vez", paused: "Detenido", resume: "Sigue",
    changesAfterRefresh: "Recarga la página para aplicar.",
    bindBody: "Une el Cuerpo", sagaSoFar: "Saga hasta ahora",
  },
  de: {
    run: "Lauf", runAgain: "Lauf nochmal", paused: "Gehalten", resume: "Weiter",
    changesAfterRefresh: "Seite neu laden zum Anwenden.",
    bindBody: "Körper binden", sagaSoFar: "Saga bisher",
  },
  sv: {
    run: "Spring", runAgain: "Spring igen", paused: "Stilla", resume: "Vidare",
    changesAfterRefresh: "Ladda om sidan för att tillämpa.",
    bindBody: "Bind kroppen", sagaSoFar: "Saga hittills",
  },
  ja: {
    run: "走る", runAgain: "もう一度", paused: "止まる", resume: "進む",
    changesAfterRefresh: "ページを再読み込みしてください。",
    bindBody: "身体を縛る", sagaSoFar: "これまでの物語",
  },
};
function I18N(key) {
  const lang = (typeof localStorage !== "undefined" && localStorage.getItem("valhalla.lang")) || "en";
  const dict = I18N_DICT[lang] || I18N_DICT.en;
  return dict[key] || I18N_DICT.en[key] || key;
}

// ---------------- Storage ----------------
// Cloud-ready storage layer. The save model has three layers:
//
//   1. LOCAL. localStorage. Always writes. Works offline. Per browser
//      × device × origin. This is the source of truth between syncs.
//
//   2. PORTABLE. snapshot() / restore() / exportString() / importString().
//      The full save as a single JSON blob the user can copy/paste or
//      share via URL fragment. Manual cross-device sync without any
//      backend. Bridges the gap until cloud auth is live.
//
//   3. CLOUD. auto-detected via window.ElataSync (provided by the
//      Elata App Store shell when the game is hosted there). Contract:
//        window.ElataSync = {
//          ready: Promise,                  // resolves when sync layer alive
//          userId: string,                  // canonical user ID
//          load(): Promise<snapshot|null>,  // pull latest from cloud
//          save(snapshot): Promise<void>,   // push to cloud
//          onChange?(cb): void,             // remote update notifications
//        };
//      When present, Store auto-pulls on boot and auto-pushes on every
//      save with last-write-wins merge by snapshot.savedAt.
//
// All three layers operate on the same JSON shape. the game code is
// completely unaware of which layer is active.
//
// SKALD ID: a stable per-user identifier (16-hex + 3-word mnemonic
// nickname) persisted in localStorage. Used as the cloud key when the
// host doesn't provide a userId. Survives leaderboard moves and is
// shown in the menu so users can recognise their own runs.
const Store = {
  // ---------- local layer ----------
  load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  },
  save(data) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      // Best-effort cloud push; doesn't block save success.
      this._maybeCloudPush();
    } catch {}
  },

  // ---------- skald identity ----------
  // Stable per-user ID. Created lazily on first call so a fresh
  // browser doesn't trigger ID generation until it's actually needed.
  // The mnemonic ("raven-fjord-mead") is for human display; the hex
  // ID is what cloud/sync layers actually key off.
  getSkaldId() {
    let id = localStorage.getItem(SKALD_KEY);
    if (!id) {
      id = newSkaldId();
      try { localStorage.setItem(SKALD_KEY, id); } catch {}
    }
    return id;
  },
  getSkaldName() {
    let name = localStorage.getItem(SKALD_NAME_KEY);
    if (!name) {
      name = newSkaldName();
      try { localStorage.setItem(SKALD_NAME_KEY, name); } catch {}
    }
    return name;
  },

  // ---------- portable snapshot ----------
  // Full save as a versioned, self-describing object. This is the
  // contract both the export string and the cloud layer use.
  snapshot() {
    return {
      version: 1,
      skaldId: this.getSkaldId(),
      skaldName: this.getSkaldName(),
      savedAt: Date.now(),
      data: this.load(),
    };
  },
  restore(snapshot) {
    if (!snapshot || typeof snapshot !== "object") throw new Error("bad snapshot");
    if (snapshot.version !== 1) throw new Error("unsupported snapshot version " + snapshot.version);
    if (!snapshot.data || typeof snapshot.data !== "object") throw new Error("snapshot has no data");
    // Adopt the snapshot's identity too. restoring should make this
    // device "be" the user who created the snapshot.
    if (snapshot.skaldId) try { localStorage.setItem(SKALD_KEY, snapshot.skaldId); } catch {}
    if (snapshot.skaldName) try { localStorage.setItem(SKALD_NAME_KEY, snapshot.skaldName); } catch {}
    try { localStorage.setItem(STORE_KEY, JSON.stringify(snapshot.data)); } catch {}
  },

  // ---------- export / import ----------
  // Base64-URL-safe encoded JSON. Compact enough to fit in a URL
  // fragment (typical save is ~5-10KB before encoding).
  exportString() {
    const json = JSON.stringify(this.snapshot());
    // btoa needs binary string; UTF-8 may contain >127 chars, so
    // encode through TextEncoder first to be safe with future content.
    const bytes = new TextEncoder().encode(json);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  importString(s) {
    if (!s || typeof s !== "string") throw new Error("empty save");
    s = s.trim().replace(/-/g, "+").replace(/_/g, "/");
    // Restore padding stripped by exportString.
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const json = new TextDecoder().decode(bytes);
    this.restore(JSON.parse(json));
  },

  // Build a self-contained share URL. works offline, works on any
  // device with the game URL, no backend needed.
  exportUrl() {
    const enc = this.exportString();
    const base = location.origin + location.pathname;
    return base + "#save=" + enc;
  },

  // On boot, if URL has #save=… offer to restore. Returns true if a
  // restore was applied so the caller can refresh stats display.
  tryRestoreFromUrl() {
    const m = location.hash.match(/^#save=(.+)$/);
    if (!m) return false;
    const enc = m[1];
    // Clear the hash so a refresh doesn't re-prompt.
    try { history.replaceState(null, "", location.pathname); } catch {}
    if (!confirm("Restore Valhalla save from this link? This will REPLACE your current progress.")) return false;
    try {
      this.importString(enc);
      alert("Save restored. Welcome back.");
      return true;
    } catch (e) {
      console.warn("[Store] restore from URL failed", e);
      alert("Couldn't read that save link. it may be corrupted.");
      return false;
    }
  },

  // ---------- cloud sync ----------
  // ElataSync is provided by the host (Elata App Store). If absent
  // we're in local-only mode and every cloud op is a no-op.
  isCloudAvailable() { return !!(typeof window !== "undefined" && window.ElataSync); },
  cloudUserId() {
    return (window.ElataSync && window.ElataSync.userId) || this.getSkaldId();
  },
  cloudStatusText() {
    if (!this.isCloudAvailable()) return "Local only · this device";
    return "Synced via Elata App Store";
  },

  // Pull on boot. If remote is newer than local, restore. Otherwise
  // push local up. Last-write-wins by savedAt timestamp. good enough
  // for a single-user game where the user only plays one device at a
  // time. (Real concurrent multi-device would need CRDT merge, which
  // is overkill for a high-score blob.)
  async cloudPull() {
    if (!this.isCloudAvailable()) return { ok: false, reason: "no_cloud" };
    try {
      await (window.ElataSync.ready || Promise.resolve());
      const remote = await window.ElataSync.load();
      const local = this.snapshot();
      if (!remote) {
        // Cloud is empty. push our local up so future devices have something to pull.
        await window.ElataSync.save(local);
        return { ok: true, action: "pushed-initial" };
      }
      if ((remote.savedAt || 0) > (local.savedAt || 0)) {
        this.restore(remote);
        return { ok: true, action: "pulled" };
      } else if ((local.savedAt || 0) > (remote.savedAt || 0)) {
        await window.ElataSync.save(local);
        return { ok: true, action: "pushed" };
      }
      return { ok: true, action: "in-sync" };
    } catch (e) {
      console.warn("[Store] cloudPull failed", e);
      return { ok: false, reason: "error", error: e };
    }
  },

  // Best-effort push triggered by every save(). Coalesced via a 2s
  // debounce so a flurry of writes only sends one request.
  _cloudPushTimer: null,
  _maybeCloudPush() {
    if (!this.isCloudAvailable()) return;
    if (this._cloudPushTimer) clearTimeout(this._cloudPushTimer);
    this._cloudPushTimer = setTimeout(() => {
      this._cloudPushTimer = null;
      try {
        window.ElataSync.save(this.snapshot())
          .catch(e => console.warn("[Store] cloud push failed", e));
      } catch (e) { console.warn("[Store] cloud push threw", e); }
    }, 2000);
  },
};

// Generate a stable 128-bit (32-hex-char) Skald ID using
// crypto.getRandomValues. Falls back to Math.random if the platform
// somehow lacks WebCrypto (very unlikely in a browser running WebGL).
function newSkaldId() {
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

// Short, human-readable Skald name. Three words from a small Norse
// word list, joined by hyphens (e.g. "raven-fjord-mead"). Used only
// for display. the hex Skald ID is the actual cloud key.
const _SKALD_WORDS = [
  "raven","wolf","bear","stag","fox","hawk","eagle","seal","whale","boar",
  "fjord","mead","axe","sword","shield","helm","prow","mast","hammer","rune",
  "snow","ice","frost","storm","wind","gale","sea","wave","river","loch",
  "asgard","midgard","odin","thor","freya","tyr","loki","mimir","balder","hel",
  "skald","jarl","thane","wight","wyrm","norn","valk","draugr","huldra","troll",
  "oak","ash","pine","yew","birch","rowan","fir","spruce","holly","ivy",
];
function newSkaldName() {
  const pick = () => _SKALD_WORDS[Math.floor(Math.random() * _SKALD_WORDS.length)];
  return pick() + "-" + pick() + "-" + pick();
}

const $ = (id) => document.getElementById(id);

// ---------------- NorseAudio ----------------
// Procedural audio for Valhalla. No samples. everything synthesized in
// WebAudio. The aim is to sound like you've actually been transported to
// the Viking Age: longhall acoustics, lur horn carrying across a fjord,
// frame drum and skald-chant over a smoke-fire. Reverb is a cheap multi-
// tap delay with feedback (no impulse response). Music is built from
// layered procedural instruments:
//
//   Lur           . long brass-like signal horn. 3 detuned saws through
//                    a sweeping lowpass with 5.2 Hz vibrato in sustain.
//   Tagelharpa    . bowed Sami lyre. 2 detuned saws through a bandpass,
//                    plus quiet high-passed pink noise for bow friction.
//   Frame drum    . sine kick (90→32 Hz) + filtered noise skin slap.
//   Throat chant  . sawtooth + 6 harmonics through three vowel formants.
//   Animal horn   . short FM tone for bell/blessing pickups.
//
// Modal centre: D Phrygian (D Eb F G A Bb C). The flat-2nd gives the
// "Northern" minor flavour without sounding like generic minor.
class Audio {
  constructor() {
    this.muted = localStorage.getItem("valhalla.muted") === "true";
    this.ctx = null;
    this.master = null;
    this.wet = null;
    this.windNode = null;
    this.musicTimer = null;
    this.ambientTimer = null;
    this._beat = 0;
    this._noiseBuf = null;
    this._pinkBuf = null;
    // Biome-driven semitone offset applied to the music root. Eased over
    // a few loops so biome transitions don't hard-cut the key.
    this._musicPitch = 0;
    this._musicPitchTarget = 0;
  }

  // Called by the game when the biome changes. Smoothly retunes the
  // melody to the realm's modal centre (Phrygian still, just transposed).
  setBiomePitch(semitones) {
    this._musicPitchTarget = semitones || 0;
  }

  ensure() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      // Lower base level. Earlier 0.42 was already on the edge for
      // some users. 0.3 leaves headroom for the limiter below.
      this.master.gain.value = this.muted ? 0 : 0.30;

      // HARD HEARING SAFETY CHAIN. NOTHING in this game gets to
      // reach the user's ears without going through these two filters
      // and a limiter. The user has reported audio pain twice now.
      // Order: master -> lowpass(4000) -> highpass(80) -> compressor -> destination
      const safetyLP = this.ctx.createBiquadFilter();
      safetyLP.type = "lowpass"; safetyLP.frequency.value = 4000; safetyLP.Q.value = 0.5;
      const safetyHP = this.ctx.createBiquadFilter();
      safetyHP.type = "highpass"; safetyHP.frequency.value = 80; safetyHP.Q.value = 0.5;
      const limiter = this.ctx.createDynamicsCompressor();
      // Aggressive limiter: threshold -10 dBFS, ratio 20:1, ~knee 0,
      // fast attack 3ms, smooth release 250ms. Anything above the
      // threshold is squashed near-flat. Combined with the lowpass
      // there is no path to ear-piercing output.
      limiter.threshold.value = -10;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;

      this.master.disconnect();
      this.master.connect(safetyLP);
      safetyLP.connect(safetyHP);
      safetyHP.connect(limiter);
      limiter.connect(this.ctx.destination);

      // Reverb: single delay + filtered feedback. The previous 4-tap
      // network was double CPU for marginal acoustic benefit. a single
      // delay with feedback through a lowpass actually models a real
      // hall response perfectly well and halves the audio node count.
      const wet = this.ctx.createGain();
      wet.gain.value = 0.32;
      const delay = this.ctx.createDelay(0.6);
      delay.delayTime.value = 0.18;
      const fbGain = this.ctx.createGain();
      fbGain.gain.value = 0.55;
      const wetLP = this.ctx.createBiquadFilter();
      wetLP.type = "lowpass"; wetLP.frequency.value = 2200;
      wet.connect(delay); delay.connect(wetLP); wetLP.connect(fbGain);
      fbGain.connect(delay);
      wetLP.connect(this.master);
      this.wet = wet;

      // Pre-build noise buffers (cheap, reused).
      this._pinkBuf = this._makePinkBuffer(2);
      this._noiseBuf = this._makeWhiteBuffer(0.5);
    } catch (e) { console.warn("[Valhalla] audio init failed", e); }
  }

  setMuted(m) {
    this.muted = m;
    localStorage.setItem("valhalla.muted", String(m));
    if (this.master) this.master.gain.linearRampToValueAtTime(m ? 0 : 0.42, this.ctx.currentTime + 0.2);
  }

  // --- noise helpers ---------------------------------------------------
  _makeWhiteBuffer(sec) {
    const len = Math.floor(this.ctx.sampleRate * sec);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  // Voss-McCartney pink noise. much warmer than white for wind/breath.
  _makePinkBuffer(sec) {
    const len = Math.floor(this.ctx.sampleRate * sec);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0+b1+b2+b3+b4+b5+b6+w*0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return buf;
  }
  _noiseSrc(pink = true) {
    const src = this.ctx.createBufferSource();
    src.buffer = pink ? this._pinkBuf : this._noiseBuf;
    src.loop = true;
    return src;
  }

  // Send a node both dry to master and an attenuated copy to the reverb.
  _send(node, wetAmt = 0.35) {
    node.connect(this.master);
    if (this.wet && wetAmt > 0) {
      const w = this.ctx.createGain(); w.gain.value = wetAmt;
      node.connect(w); w.connect(this.wet);
    }
  }

  // --- instruments -----------------------------------------------------
  // Lur horn. REAL brass timbre via additive synthesis. Real brass has
  // a specific harmonic series with peaks shaped by lip-tension and bore
  // resonance. We build the tone as a sum of sine harmonics with the
  // amplitudes of an actual French-horn / lur spectrum (measured by
  // acoustical engineers: H1=1.0, H2=0.78, H3=0.66, H4=0.52, H5=0.36,
  // H6=0.28, H7=0.18, H8=0.11). On attack the higher harmonics swell
  // in slightly later (brass "bloom"). that's the bright sting you
  // hear when a real horn note starts. No sawtooth-through-filter
  // buzziness, no synth tell.
  _lur(when, freq, dur, vol = 0.18) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;

    // Spectral envelope. published brass-instrument values, normalised.
    const HARM = [1.00, 0.78, 0.66, 0.52, 0.36, 0.28, 0.18, 0.11];
    // Per-harmonic attack offset (in seconds). higher harmonics bloom
    // ~15-40ms after the fundamental, gives the real "brass surge".
    const HOFF = [0.00, 0.012, 0.022, 0.030, 0.045, 0.060, 0.075, 0.090];
    // 5.2 Hz lip vibrato, applied as detune on the fundamental.
    const vib = ctx.createOscillator();
    vib.type = "sine"; vib.frequency.value = 5.2;
    const vibG = ctx.createGain(); vibG.gain.value = 5;
    vib.connect(vibG);

    for (let h = 0; h < HARM.length; h++) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = freq * (h + 1);
      // Slight detune so harmonics don't beat into a flat texture.
      o.detune.value = (Math.random() - 0.5) * 4;
      // Vibrato on the partial. multiplied by harmonic number so higher
      // harmonics vibrate proportionally, just like a real instrument.
      vibG.connect(o.detune);
      const g = ctx.createGain();
      // Each harmonic has its own envelope so the spectrum opens up over
      // the attack and closes back on release.
      const tStart = when + HOFF[h];
      g.gain.setValueAtTime(0.0001, tStart);
      g.gain.exponentialRampToValueAtTime(HARM[h] * 0.18, tStart + 0.04);
      g.gain.linearRampToValueAtTime(HARM[h] * 0.15, tStart + Math.max(0.15, dur * 0.7));
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      o.connect(g); g.connect(out);
      o.start(tStart); o.stop(when + dur + 0.05);
    }
    // Tiny breath noise mixed in for the "air in the bore" quality
    // (real brass is never pure-tone. there's always a whisper).
    const breath = this._noiseSrc(true);
    const breathFil = ctx.createBiquadFilter();
    breathFil.type = "bandpass"; breathFil.frequency.value = freq * 4;
    breathFil.Q.value = 0.8;
    const breathG = ctx.createGain();
    breathG.gain.setValueAtTime(0.0001, when);
    breathG.gain.exponentialRampToValueAtTime(0.025, when + 0.06);
    breathG.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    breath.connect(breathFil); breathFil.connect(breathG); breathG.connect(out);
    breath.start(when); breath.stop(when + dur + 0.05);

    this._send(out, 0.55);
    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(vol, when + 0.08);
    out.gain.linearRampToValueAtTime(vol * 0.82, when + Math.max(0.12, dur * 0.7));
    out.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    // (Each harmonic oscillator was already started inside the harmonic
    // loop above. The leftover `for (const o of oscs)` from the old
    // sawtooth-based lur was throwing ReferenceError because `oscs`
    // doesn't exist anymore. removed.)
    vib.start(when); vib.stop(when + dur + 0.05);
  }

  // Tagelharpa. KARPLUS-STRONG plucked-string physical model. This is
  // how real strings actually work: a delay line of length 1/freq
  // seconds, filled with a noise burst (the pluck), feeds back through
  // a one-pole lowpass that simulates string damping. The natural
  // harmonics arise from the delay-line resonance; the lowpass causes
  // higher harmonics to decay faster than the fundamental (just like a
  // real string). Sounds genuinely like a plucked lyre, not a synth.
  _tagelharpa(when, freq, dur, vol = 0.14) {
    const ctx = this.ctx;
    const delaySec = 1 / freq;
    const out = ctx.createGain();
    out.gain.value = 0;
    // The feedback delay line. maxDelayTime > our delay so it doesn't clamp.
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = delaySec;
    // One-pole lowpass in the feedback path. controls how fast harmonics
    // decay. Higher Q + lower cutoff = darker, longer-sustaining string.
    const damping = ctx.createBiquadFilter();
    damping.type = "lowpass";
    damping.frequency.value = Math.min(4000, freq * 10);
    damping.Q.value = 0.4;
    // Feedback gain. set just below 1 so the string sustains then decays.
    // Lower = shorter pluck; higher = ringing harp. ~0.985 is realistic.
    const fb = ctx.createGain();
    fb.gain.value = 0.985;

    // Wire the feedback loop: delay → damping → fb → delay
    delay.connect(damping); damping.connect(fb); fb.connect(delay);
    damping.connect(out);

    // Excite the string with a short burst of filtered noise (the pluck).
    // Length = one period so the loop has a full waveform to start with.
    const noise = this._noiseSrc(false);
    const pluck = ctx.createGain();
    pluck.gain.setValueAtTime(vol * 1.4, when);
    pluck.gain.setValueAtTime(vol * 1.4, when + delaySec);
    pluck.gain.setValueAtTime(0, when + delaySec + 0.001);
    noise.connect(pluck); pluck.connect(delay);
    noise.start(when); noise.stop(when + delaySec + 0.02);

    // Bow-noise overlay. quiet high-passed pink for the friction tone
    // that real bowed strings have (tagelharpa is bowed, not plucked,
    // but Karplus-Strong models the resonance perfectly; the bow noise
    // adds the sustained excitation character).
    const bowN = this._noiseSrc(true);
    const bowHP = ctx.createBiquadFilter();
    bowHP.type = "highpass"; bowHP.frequency.value = 2200;
    const bowG = ctx.createGain();
    bowG.gain.setValueAtTime(0.0001, when);
    bowG.gain.exponentialRampToValueAtTime(vol * 0.05, when + 0.05);
    bowG.gain.linearRampToValueAtTime(vol * 0.03, when + dur * 0.6);
    bowG.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    bowN.connect(bowHP); bowHP.connect(bowG); bowG.connect(out);
    bowN.start(when); bowN.stop(when + dur + 0.05);

    this._send(out, 0.55);
    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(vol, when + 0.04);
    out.gain.linearRampToValueAtTime(vol * 0.7, when + dur * 0.7);
    out.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  }

  // Frame drum. PHYSICAL MEMBRANE MODES. A real drumhead has multiple
  // resonant modes at non-harmonic ratios (the (0,1), (1,1), (2,1) modes
  // of a circular membrane are at ratios ~1, 1.59, 2.14 of the
  // fundamental). We excite all three with a single noise burst. they
  // ring together for the rich "thud-PFFf" attack you get from a real
  // skin drum being struck. Much more natural than a swept sine kick.
  _drum(when, vol = 0.42) {
    const ctx = this.ctx;
    // The strike. a 4ms broadband noise burst that hits all modes at once.
    const burst = this._noiseSrc(false);
    const burstG = ctx.createGain();
    burstG.gain.setValueAtTime(vol * 1.6, when);
    burstG.gain.setValueAtTime(vol * 1.6, when + 0.004);
    burstG.gain.setValueAtTime(0, when + 0.005);
    burst.connect(burstG);
    burst.start(when); burst.stop(when + 0.01);

    const out = ctx.createGain(); out.gain.value = 1;

    // Membrane modes. measured Bessel-function ratios for a circular
    // drumhead. Each mode is a high-Q bandpass that rings when struck.
    // Fundamental at ~85Hz for a real Viking frame drum (about 35cm hide).
    const MODES = [
      { freq: 85,  Q: 18, gain: 1.00, decay: 0.42 },
      { freq: 135, Q: 14, gain: 0.55, decay: 0.30 },
      { freq: 182, Q: 12, gain: 0.32, decay: 0.22 },
      { freq: 285, Q: 10, gain: 0.18, decay: 0.14 },
    ];
    for (const m of MODES) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = m.freq;
      bp.Q.value = m.Q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(m.gain, when + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, when + m.decay);
      burstG.connect(bp); bp.connect(g); g.connect(out);
    }
    // Stick attack. sharp transient slap, high-passed noise so it has
    // the wood-on-skin "crack" without competing with the body.
    const slap = this._noiseSrc(false);
    const slapHP = ctx.createBiquadFilter();
    slapHP.type = "highpass"; slapHP.frequency.value = 1200;
    const slapG = ctx.createGain();
    slapG.gain.setValueAtTime(0.0001, when);
    slapG.gain.exponentialRampToValueAtTime(vol * 0.45, when + 0.002);
    slapG.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    slap.connect(slapHP); slapHP.connect(slapG); slapG.connect(out);
    slap.start(when); slap.stop(when + 0.06);

    this._send(out, 0.5);
  }

  // Throat chant / overtone singing. Saw fundamental + 5 harmonics piped
  // through three parallel bandpass "formants" tuned to a vowel. Subtle
  // vibrato on the fundamental.
  _chant(when, root, dur, vol = 0.10, vowel = "o") {
    const ctx = this.ctx;
    const VOWELS = {
      o: [570, 840, 2410], a: [700, 1220, 2600], u: [300, 870, 2240],
    };
    const F = VOWELS[vowel] || VOWELS.o;
    const out = ctx.createGain(); out.gain.value = 0;
    const formants = F.map(freq => {
      const f = ctx.createBiquadFilter();
      f.type = "bandpass"; f.frequency.value = freq; f.Q.value = 8;
      f.connect(out);
      return f;
    });
    const oscs = [];
    for (let h = 1; h <= 6; h++) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = root * h;
      const g = ctx.createGain();
      g.gain.value = 1 / (h * 0.8 + 1);
      o.connect(g);
      for (const f of formants) g.connect(f);
      oscs.push(o);
    }
    const vib = ctx.createOscillator();
    vib.frequency.value = 4.1;
    const vibG = ctx.createGain(); vibG.gain.value = root * 0.008;
    vib.connect(vibG); vibG.connect(oscs[0].frequency);

    this._send(out, 0.6);
    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(vol, when + 0.45);
    out.gain.linearRampToValueAtTime(vol * 0.85, when + dur * 0.65);
    out.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    for (const o of oscs) { o.start(when); o.stop(when + dur + 0.05); }
    vib.start(when); vib.stop(when + dur + 0.05);
  }

  // Animal-horn bell via 2-op FM. Bright, transient, ringing.
  _bell(when, freq, dur = 0.9, vol = 0.16) {
    const ctx = this.ctx;
    const carr = ctx.createOscillator();
    carr.type = "sine";
    carr.frequency.value = freq;
    const mod = ctx.createOscillator();
    mod.type = "sine";
    mod.frequency.value = freq * 1.43;
    const modG = ctx.createGain();
    modG.gain.setValueAtTime(freq * 2.2, when);
    modG.gain.exponentialRampToValueAtTime(freq * 0.2, when + dur);
    mod.connect(modG); modG.connect(carr.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    carr.connect(g);
    this._send(g, 0.7);
    carr.start(when); carr.stop(when + dur + 0.05);
    mod.start(when); mod.stop(when + dur + 0.05);
  }

  // --- ambient bed -----------------------------------------------------
  startWind() {
    this.ensure();
    if (!this.ctx || this.windNode) return;
    // LAYERED WIND: two pink-noise streams through different filters
    //. the high-passed one becomes the "whistling through pines"
    // overtone, the low-passed one is the bulk wash. Together this
    // sounds like real outdoor wind, not a single white-noise hiss.
    // The previous single-LP version was the "shit and fraud" wind
    // the user kept calling out.
    const noiseLow = this._noiseSrc(true);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 380; lp.Q.value = 0.6;
    const gLow = this.ctx.createGain(); gLow.gain.value = 0.11;
    noiseLow.connect(lp); lp.connect(gLow);

    // The "whistle" layer was a resonant bandpass at Q=2.8 around
    // 1400 Hz which can pierce eardrums. Dropped to Q=0.8, lower
    // freq, much quieter gain. Now reads as breath through pines,
    // not a tea kettle.
    const noiseHi = this._noiseSrc(true);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 700; bp.Q.value = 0.7;
    const gHi = this.ctx.createGain(); gHi.gain.value = 0.012;
    noiseHi.connect(bp); bp.connect(gHi);

    this._send(gLow, 0.35);
    this._send(gHi, 0.55);
    noiseLow.start(); noiseHi.start();

    this.windNode = { noiseLow, noiseHi, lp, bp, gLow, gHi };
    // Slow LFO on the bulk-wind cutoff + gain (~10s cycle) for the
    // "gust building and dying" feel. Bandpass cutoff drifts 1.5x as
    // fast so the whistle and bulk aren't locked together.
    setInterval(() => {
      if (!this.windNode || !this.ctx) return;
      const t = this.ctx.currentTime;
      this.windNode.lp.frequency.linearRampToValueAtTime(220 + Math.random() * 260, t + 1.6);
      this.windNode.gLow.gain.linearRampToValueAtTime(0.075 + Math.random() * 0.08, t + 1.6);
    }, 1600);
    setInterval(() => {
      if (!this.windNode || !this.ctx) return;
      const t = this.ctx.currentTime;
      // Keep whistle low + soft. Max gain 0.020 (was 0.057 = pierce).
      this.windNode.bp.frequency.linearRampToValueAtTime(500 + Math.random() * 600, t + 1.0);
      this.windNode.gHi.gain.linearRampToValueAtTime(0.008 + Math.random() * 0.012, t + 1.0);
    }, 1100);
  }

  // FIRE CRACKLE. continuous looped texture for the camp ambience.
  // Built from two layers:
  //   * Brown noise through a lowpass = the bass "whoosh" of the fire
  //   * Random tiny noise bursts = the snap/crackle/pop of embers
  // Volume modulates with `intensity` (0..1) so we can fade it up
  // when the player is near a fire pit and down when running through
  // pure meadow.
  startFireAmbience() {
    this.ensure();
    if (!this.ctx || this.fireNode) return;
    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.value = 0.0;     // starts silent; setFireProximity() raises it
    // ONLY the bass wash. The crackle pop layer (random HP-filtered
    // noise bursts) was the most likely cause of the user's audio
    // pain. Brown noise lowpassed to 200Hz is gentle and warm.
    const noise = this._noiseSrc(true);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 200; lp.Q.value = 0.4;
    const gWash = ctx.createGain(); gWash.gain.value = 0.25;
    noise.connect(lp); lp.connect(gWash); gWash.connect(master);
    noise.start();
    // CRACKLE DISABLED. Was random HP-filtered noise bursts at 1800Hz
    // with gain up to 0.4 firing every 60-280ms. User reported audio
    // pain twice. Bass wash above is enough for fire ambience.
    this._send(master, 0.18);    // small reverb so it sits in the space
    master.connect(this.master);
    this.fireNode = { master };
  }

  // Set fire ambience volume based on how close the player is to a
  // fire (0..1). 0 = silent (no fire nearby), 1 = right next to one.
  // Called from the per-frame update.
  setFireProximity(p) {
    if (!this.fireNode || !this.ctx) return;
    const target = Math.max(0, Math.min(1, p)) * 0.65;
    this.fireNode.master.gain.linearRampToValueAtTime(target, this.ctx.currentTime + 0.3);
  }

  // FOOTSTEP. short crunch sound when player stamps a footprint in
  // snow. Brown noise burst with low-pass filtering and exponential
  // envelope. Pitch + amplitude randomized so consecutive steps don't
  // sound identical (the dead giveaway of fake game audio).
  footstep() {
    this.ensure();
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const when = ctx.currentTime;
    const noise = this._noiseSrc(true);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 400 + Math.random() * 250; hp.Q.value = 0.8;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 2400 + Math.random() * 800; lp.Q.value = 0.7;
    const g = ctx.createGain();
    const amp = 0.05 + Math.random() * 0.04;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(amp, when + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.14);
    noise.connect(hp); hp.connect(lp); lp.connect(g); g.connect(this.master);
    noise.start(when); noise.stop(when + 0.16);
  }

  // Loose ambient texture: distant raven calls, ocean wash, wind gust,
  // and the occasional distant lur horn answering from across the fjord.
  // Picks ONE event per tick at random on a 5–14s interval. Frequent
  // enough that the world always feels populated, sparse enough that
  // it never feels busy.
  _scheduleAmbient() {
    const tick = () => {
      if (!this.ctx) return;
      if (!this.muted) {
        const when = this.ctx.currentTime + 0.05;
        const r = Math.random();
        if (r < 0.35)      this._raven(when, 0.05);
        else if (r < 0.65) this._wave(when);
        else if (r < 0.85) this._windGust(when);
        else               this._distantHorn(when);
      }
      this.ambientTimer = setTimeout(tick, 5000 + Math.random() * 9000);
    };
    this.ambientTimer = setTimeout(tick, 4000 + Math.random() * 4000);
  }

  // Short wind gust. pink noise with a low-pass swept up then down,
  // simulating a real gust moving past the listener.
  _windGust(when) {
    const ctx = this.ctx;
    const n = this._noiseSrc(true);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = 0.6;
    lp.frequency.setValueAtTime(300, when);
    lp.frequency.linearRampToValueAtTime(900, when + 0.8);
    lp.frequency.linearRampToValueAtTime(280, when + 2.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.085, when + 0.6);
    g.gain.linearRampToValueAtTime(0.06, when + 1.4);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 2.5);
    n.connect(lp); lp.connect(g);
    this._send(g, 0.5);
    n.start(when); n.stop(when + 2.6);
  }

  // Distant lur horn. a single long note at low volume with massive
  // reverb send. Sells the idea that other skalds / signal-watchers
  // are out there in the fjord network.
  _distantHorn(when) {
    const root = 73.42 * Math.pow(2, this._musicPitch / 12);
    // Random partial of the natural horn series (2, 3, or 4).
    const partial = 2 + (Math.random() * 3 | 0);
    this._lur(when, root * partial * 0.5, 2.5, 0.04);
  }

  // Raven caw: 2–3 quick filtered-noise bursts with downward pitch sweep.
  _raven(when, vol = 0.06) {
    const ctx = this.ctx;
    const count = 2 + (Math.random() < 0.4 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const t = when + i * 0.18;
      const n = this._noiseSrc(false);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(900 + Math.random() * 200, t);
      bp.frequency.exponentialRampToValueAtTime(380, t + 0.14);
      bp.Q.value = 12;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      n.connect(bp); bp.connect(g);
      this._send(g, 0.7);
      n.start(t); n.stop(t + 0.18);
    }
  }

  // Distant wave wash: pink noise through lowpass with a slow swell.
  _wave(when) {
    const ctx = this.ctx;
    const n = this._noiseSrc(true);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.045, when + 1.2);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 3.0);
    n.connect(lp); lp.connect(g);
    this._send(g, 0.5);
    n.start(when); n.stop(when + 3.2);
  }

  // --- music loop ------------------------------------------------------
  // D Phrygian (D Eb F G A Bb C). A long lur drone, frame-drum heartbeat,
  // tagelharpa melodic phrase, and a chant on alternating loops.
  startMusic() {
    this.ensure();
    if (!this.ctx || this.musicTimer) return;
    if (!this.ambientTimer) this._scheduleAmbient();

    const ROOT = 73.42;                                  // D2
    const SCALE = { D:1, Eb:1.0667, F:1.1852, G:1.3333, A:1.5, Bb:1.6, C:1.7778 };
    const BEAT = 0.72;          // slower tempo. feels more breath-heavy
    const BAR  = BEAT * 4;
    const LOOP = BAR * 4;

    // Sparser drum: heartbeat on 1 + 3 each bar, ghost on the "and of 4".
    // Replaces the previous 16-hit dum-tek that made the loop feel
    // mechanical. Real skaldic music breathes.
    const DRUM = [0, 2, 3.5, 4, 6, 7.5, 8, 10, 11.5, 12, 14, 15.5];
    // Melody is now half as dense. Only plays on EVEN loops (every
    // second cycle). On odd loops, the lur drone + drum + ambient hold
    // the space, then the tagelharpa returns. This is the single
    // biggest "feels like real music, not a loop" change.
    const MELODY = [
      [0,    "F",  2.0],
      [3,    "G",  2.0],
      [6,    "A",  2.5],
      [9.5,  "F",  1.5],
      [11,   "Eb", 1.5],
      [13,   "D",  3.0],
    ];
    const playLoop = () => {
      if (!this.musicTimer) return;
      const t0 = this.ctx.currentTime + 0.05;
      const diff = this._musicPitchTarget - this._musicPitch;
      if (Math.abs(diff) > 0.01) this._musicPitch += Math.sign(diff) * Math.min(Math.abs(diff), 1);
      const pitchMul = Math.pow(2, this._musicPitch / 12);
      const root = ROOT * pitchMul;
      // Long lur drone holds the root for the whole loop. quieter so
      // it sits under everything as the seabed of the music.
      this._lur(t0, root, LOOP, 0.075);
      // Tagelharpa melody only on EVEN loops. gives the music room
      // to breathe instead of beating you over the head with the same
      // phrase every 11.5 seconds.
      if ((this._beat % 2) === 0) {
        for (const [b, deg, dur] of MELODY) {
          this._tagelharpa(t0 + b * BEAT, root * 2 * SCALE[deg], dur * BEAT, 0.12);
        }
      }
      // Frame drum heartbeat.
      for (const b of DRUM) {
        const accent = (b % 4 === 0);
        this._drum(t0 + b * BEAT, accent ? 0.42 : 0.22);
      }
      // Chant on alternating ODD loops, vowel-shifting. Half-volume
      // compared to before so it doesn't compete with the melody.
      if ((this._beat % 4) === 1) {
        this._chant(t0 + 6 * BEAT, root * 2, 8 * BEAT, 0.06, "o");
      } else if ((this._beat % 4) === 3) {
        this._chant(t0 + 4 * BEAT, root * 2, 6 * BEAT, 0.05, "a");
      }
      // Distant lur call sometimes mid-loop. gives the world the
      // sense that other skalds are signalling across the fjord.
      if ((this._beat % 3) === 2) {
        this._lur(t0 + 8 * BEAT, root * 1.5, 3 * BEAT, 0.035);
      }
      this._beat++;
    };
    playLoop();
    this.musicTimer = setInterval(playLoop, LOOP * 1000);
  }

  stopMusic() {
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
  }

  // --- one-shots / SFX -------------------------------------------------
  // Back-compat: short sweep tone. Kept so any existing callers still work.
  blip(freq = 880, dur = 0.12, type = "triangle", vol = 0.12) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * 0.6), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // Boot stomp on packed earth + cloth swoosh.
  jump() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const k = this.ctx.createOscillator();
    const kg = this.ctx.createGain();
    k.type = "sine";
    k.frequency.setValueAtTime(140, t);
    k.frequency.exponentialRampToValueAtTime(55, t + 0.06);
    kg.gain.setValueAtTime(0.0001, t);
    kg.gain.exponentialRampToValueAtTime(0.18, t + 0.004);
    kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    k.connect(kg); kg.connect(this.master);
    k.start(t); k.stop(t + 0.14);
    const n = this._noiseSrc(true);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 1400; bp.Q.value = 1.2;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    n.connect(bp); bp.connect(ng); ng.connect(this.master);
    n.start(t); n.stop(t + 0.15);
  }

  // Leather scrape across packed snow.
  slide() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const n = this._noiseSrc(true);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 700; bp.Q.value = 4;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.10, t + 0.02);
    g.gain.linearRampToValueAtTime(0.06, t + 0.16);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    n.connect(bp); bp.connect(g); g.connect(this.master);
    n.start(t); n.stop(t + 0.34);
  }

  // Snow crunch lane-change tick. short, sharp, quiet.
  laneChange() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const n = this._noiseSrc(false);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 3800; bp.Q.value = 6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    n.connect(bp); bp.connect(g); g.connect(this.master);
    n.start(t); n.stop(t + 0.06);
  }

  // Mead pickup: wooden tap then short low gurgle.
  collect() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(420, t);
    o.frequency.exponentialRampToValueAtTime(280, t + 0.05);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.10, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    o.connect(og); this._send(og, 0.3);
    o.start(t); o.stop(t + 0.12);
    const t2 = t + 0.05;
    const n = this._noiseSrc(true);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.Q.value = 8;
    bp.frequency.setValueAtTime(180, t2);
    bp.frequency.linearRampToValueAtTime(320, t2 + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t2);
    g.gain.exponentialRampToValueAtTime(0.05, t2 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.18);
    n.connect(bp); bp.connect(g); g.connect(this.master);
    n.start(t2); n.stop(t2 + 0.2);
  }

  // Rune pickup: animal-horn bell + sub-bass swell.
  collectRune() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    this._bell(t, 660, 1.1, 0.16);
    this._bell(t + 0.02, 990, 0.9, 0.09);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(60, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.45);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o.connect(g); this._send(g, 0.5);
    o.start(t); o.stop(t + 0.6);
  }

  // Hit: wooden shield crack + low body impact.
  hit() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const n = this._noiseSrc(false);
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 1800;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.22, t + 0.004);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    n.connect(hp); hp.connect(ng); this._send(ng, 0.5);
    n.start(t); n.stop(t + 0.12);
    const o = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(36, t + 0.5);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.28, t + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 700;
    o.connect(lp); lp.connect(og); this._send(og, 0.6);
    o.start(t); o.stop(t + 0.6);
  }

  // Death: low descending lur wail with heavy reverb.
  death() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain(); out.gain.value = 0;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 1400;
    for (const det of [-10, 0, 9]) {
      const o = this.ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(55, t + 1.4);
      o.detune.value = det;
      o.connect(lp);
      o.start(t); o.stop(t + 1.6);
    }
    lp.connect(out);
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.28, t + 0.08);
    out.gain.linearRampToValueAtTime(0.22, t + 0.9);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    this._send(out, 0.7);
  }

  // Tiny faint thunder rumble for Mjölnir auto-strikes during the buff.
  thunderTick() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const n = this._noiseSrc(false);
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 600;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    n.connect(hp); hp.connect(g); this._send(g, 0.6);
    n.start(t); n.stop(t + 0.2);
  }

  // --- god power activation sounds -------------------------------------
  // One signature gesture per god, played the moment the orb is picked up.
  power(god) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    switch (god) {
      case "tyr": {
        // Shield bash + horn fanfare (war + horn = Tyr).
        const n = this._noiseSrc(false);
        const bp = this.ctx.createBiquadFilter();
        bp.type = "bandpass"; bp.frequency.value = 2400; bp.Q.value = 3;
        const ng = this.ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.exponentialRampToValueAtTime(0.16, t + 0.003);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.20);
        n.connect(bp); bp.connect(ng); this._send(ng, 0.7);
        n.start(t); n.stop(t + 0.22);
        this._lur(t + 0.04, 220, 0.7, 0.15);
        this._lur(t + 0.20, 293.66, 0.6, 0.15);
        break;
      }
      case "sleipnir": {
        // 4 hoofbeats + wind whoosh (Odin's 8-legged horse).
        for (let i = 0; i < 4; i++) {
          const ti = t + i * 0.08;
          const o = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          o.type = "sine";
          o.frequency.setValueAtTime(140 - i * 8, ti);
          o.frequency.exponentialRampToValueAtTime(50, ti + 0.07);
          g.gain.setValueAtTime(0.0001, ti);
          g.gain.exponentialRampToValueAtTime(0.20, ti + 0.003);
          g.gain.exponentialRampToValueAtTime(0.0001, ti + 0.10);
          o.connect(g); this._send(g, 0.4);
          o.start(ti); o.stop(ti + 0.12);
        }
        const n = this._noiseSrc(true);
        const bp = this.ctx.createBiquadFilter();
        bp.type = "bandpass"; bp.frequency.value = 1100; bp.Q.value = 1;
        const ng = this.ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.exponentialRampToValueAtTime(0.10, t + 0.12);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
        n.connect(bp); bp.connect(ng); ng.connect(this.master);
        n.start(t); n.stop(t + 0.6);
        break;
      }
      case "bragi": {
        // Harp arpeggio + open-vowel chant (god of poetry, immortalised deeds).
        const root = 220;
        const steps = [1, 1.1852, 1.3333, 1.5, 1.7778];
        for (let i = 0; i < steps.length; i++) {
          this._bell(t + i * 0.06, root * steps[i] * 2, 0.6, 0.09);
        }
        this._chant(t + 0.4, 220, 0.7, 0.09, "a");
        break;
      }
      case "freja": {
        // Bell + "ah" + high shimmer (Freja wept tears of red gold).
        this._bell(t, 880, 1.0, 0.14);
        this._chant(t + 0.05, 330, 1.1, 0.09, "a");
        for (let i = 0; i < 4; i++) {
          this._bell(t + 0.10 + i * 0.07, 1320 + i * 220, 0.5, 0.045);
        }
        break;
      }
      case "skidbladnir": {
        // Dragon roar + creaking wood (Freyr's magical longship).
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        const lp = this.ctx.createBiquadFilter();
        lp.type = "lowpass"; lp.frequency.value = 600;
        o.type = "sawtooth";
        o.frequency.setValueAtTime(60, t);
        o.frequency.linearRampToValueAtTime(120, t + 0.4);
        o.frequency.exponentialRampToValueAtTime(45, t + 0.9);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.30, t + 0.06);
        g.gain.linearRampToValueAtTime(0.20, t + 0.5);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
        o.connect(lp); lp.connect(g); this._send(g, 0.6);
        o.start(t); o.stop(t + 1.0);
        this._tagelharpa(t + 0.05, 120, 0.4, 0.10);
        break;
      }
      case "mjolnir": {
        // THUNDERCLAP. broadband noise + sub-bass shock + bell ring.
        const n = this._noiseSrc(false);
        const hp = this.ctx.createBiquadFilter();
        hp.type = "highpass"; hp.frequency.value = 300;
        const ng = this.ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.exponentialRampToValueAtTime(0.45, t + 0.002);
        ng.gain.exponentialRampToValueAtTime(0.08, t + 0.2);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        n.connect(hp); hp.connect(ng); this._send(ng, 0.9);
        n.start(t); n.stop(t + 0.95);
        const o = this.ctx.createOscillator();
        const og = this.ctx.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(80, t);
        o.frequency.exponentialRampToValueAtTime(30, t + 0.6);
        og.gain.setValueAtTime(0.0001, t);
        og.gain.exponentialRampToValueAtTime(0.40, t + 0.005);
        og.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
        o.connect(og); og.connect(this.master);
        o.start(t); o.stop(t + 0.75);
        this._bell(t + 0.05, 440, 1.2, 0.10);
        break;
      }
      case "odin": {
        // Two near raven caws + low ominous drone swell.
        this._raven(t, 0.10);
        this._raven(t + 0.45, 0.08);
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = "sawtooth";
        o.frequency.value = 73.42 / 2;
        const lp = this.ctx.createBiquadFilter();
        lp.type = "lowpass"; lp.frequency.value = 240;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.4);
        g.gain.linearRampToValueAtTime(0.12, t + 1.0);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
        o.connect(lp); lp.connect(g); this._send(g, 0.8);
        o.start(t); o.stop(t + 1.6);
        break;
      }
    }
  }
}

// ---------------- Noise (cheap deterministic 2D value noise) ----------------
function hash2(x, y) {
  let h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function smoothNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const v00 = hash2(xi, yi);
  const v10 = hash2(xi + 1, yi);
  const v01 = hash2(xi, yi + 1);
  const v11 = hash2(xi + 1, yi + 1);
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return (v00 * (1 - u) + v10 * u) * (1 - v) + (v01 * (1 - u) + v11 * u) * v;
}
function fbm(x, y) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < 4; i++) {
    sum += amp * smoothNoise(x * freq, y * freq);
    norm += amp;
    amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}
// Heightmap for ground: lanes (x in [-5..5]) stay near flat for playability.
function groundHeight(x, z) {
  // Path band stays flat; outside band, terrain rises
  const distFromPath = Math.max(0, Math.abs(x) - 6);
  const ridge = fbm(x * 0.04, z * 0.04) * 4 + fbm(x * 0.13, z * 0.13) * 1.4;
  const offsetMul = Math.min(1, distFromPath * 0.18);
  return ridge * offsetMul - 0.05;
}

// ---------------- Game ----------------
class Valhalla {
  constructor() {
    this.canvas = $("world");
    this.audio = new Audio();
    this.lane = 1;                // 0,1,2
    this.targetLaneX = LANES[1];
    this.playerY = 0;
    this.playerVy = 0;
    this.sliding = false;
    this.slideTimer = 0;
    this.sprint = false;

    this.distance = 0;
    this.score = 0;
    this.mead = 0;
    this.lives = 3;
    this.speed = BASE_SPEED;
    this.combo = 0;
    this.invuln = 0;

    this.running = false;
    this.paused = false;
    this.over = false;

    this.chunks = [];          // ground tiles
    this.obstacles = [];       // {mesh, lane, z, type, w, h}
    this.collectibles = [];    // {mesh, lane, z, type, ang}
    this.scenery = [];         // decorative trees etc with z
    this.mountains = [];

    // Active powerup state. each value is seconds remaining; 0 = inactive.
    // Internal keys are slot names; user-facing labels are Norse gods/relics.
    this.power = {
      shield: 0,  // Tyr's Aegis    . invuln (god of war, sacrificed his hand)
      speed:  0,  // Sleipnir        . Odin's 8-legged steed, gallop speed
      mult:   0,  // Bragi's Saga    . god of poetry, x2 score
      magnet: 0,  // Freja's Tears   . pulls mead (she wept tears of gold)
      ship:   0,  // Skíðblaðnir     . Freyr's magical longship, flight
      thor:   0,  // Mjölnir         . Thor's hammer, lightning clears obstacles
      odin:   0,  // Huginn & Muninn . Odin's ravens, foresight (slow-mo)
    };
    // Per-power max durations, used by HUD pill fill calculations.
    this.powerMax = { shield: 6, speed: 5, mult: 8, magnet: 6, ship: 6, thor: 4.5, odin: 6 };

    this.cognitiveState = "neutral";
    this.bpm = null;
    this.hrv = null;          // RMSSD ms. captured for advanced-mode panel
    this.focusLevel = null;   // 0..1. captured from EEG
    this.calmLevel = null;    // 0..1. captured from EEG
    // Bio session tracking. Every frame we accumulate time in each
    // useful state. Drives:
    //   * bio-gift spawn (12s in flow/focused/calm → free powerup)
    //   * end-of-run bio report (shown on game over)
    //   * always-visible bio HUD pill showing progress to next gift
    this.bioSession = {
      flowSec: 0, focusedSec: 0, calmSec: 0, berserkerSec: 0,
      meditationSec: 0,
      // Punish state tracking (loss aversion). Time in these is what
      // we surface in the menu nudge for "yesterday the storm took
      // you for Xs" warnings.
      stressSec: 0, fatigueSec: 0,
      sumHR: 0, hrSamples: 0, peakHR: 0,
      sumHRV: 0, hrvSamples: 0,
      giftAccumSec: 0,           // counts up while in a "good" state
      giftLossAccumSec: 0,       // counts up while in stress, drains giftAccumSec
      giftsEarned: 0,
      giftsLost: 0,              // count of gifts denied due to stress
      durationBonusApplied: 0,   // count of powerups extended by bio
    };

    // Biome / realm tracking. We walk through Midgard → Jötunheim →
    // Muspelheim → Asgard, then loop. Each biome runs ~500m; transitions
    // ease fog/sky/music over ~2s and fire a boss encounter (except
    // Midgard which is the spawn realm).
    this.biomeIdx = 0;
    this.biomeName = BIOMES[0].name;
    this.biomeCycle = 0;       // number of full loops through all biomes
    this._biomeFogColor = new THREE.Color(BIOMES[0].fog);
    this._biomeFogTarget = new THREE.Color(BIOMES[0].fog);
    this._biomeSkyTargets = BIOMES[0].sky.map(c => new THREE.Color(c));

    this._initThree();
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildWater();
    this._buildMountains();
    this._buildPlayer();
    this._buildSnow();
    this._buildScenery();
    // Atmospheric layers. god rays cutting through scene + drifting
    // mist at ground level. Cheap additive sprites, big realism win.
    this._buildGodRays();
    this._buildMist();
    this._buildHUD();
    // Each top-level boot stage independently wrapped so a single
    // throw doesn't cascade. User-reported 'buttons don't work +
    // unknown skald name' was caused by an early throw in _bindInput
    // killing _bindBio and _loadStats downstream.
    try { this._bindInput(); } catch (e) { console.error("[boot] _bindInput threw", e); }
    try { this._bindBio();   } catch (e) { console.error("[boot] _bindBio threw", e); }
    try { this._loadStats(); } catch (e) { console.error("[boot] _loadStats threw", e); }

    window.addEventListener("resize", () => this._resize());
    this._resize();

    this._renderOnce();
    // Hide loader using the actual CSS class ("hide", not "hidden") so the
    // fade transition fires. Then remove the element after the fade.
    const ldr = $("loader");
    if (ldr) {
      ldr.classList.add("hide");
      setTimeout(() => ldr.remove(), 500);
    }

    // Score popper container (DOM-based floating text)
    this._poppers = [];

    // Camera shake state
    this._shakeAmp = 0;
    this._shakeT = 0;
    this._timeScale = 1;     // for slow-mo on rune
    this._timeScaleTarget = 1;

    this._lastT = performance.now();
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);

    // Fire the first-run onboarding flow if this is the user's first
    // ever visit (no localStorage flag set).
    this._maybeShowIntro();
  }

  // First-run guided overlay. Three steps: world setup → controls →
  // bio integration. Skip / Next buttons advance. localStorage flag
  // prevents it from showing on subsequent visits.
  _maybeShowIntro() {
    try {
      if (localStorage.getItem("valhalla.seenIntro") === "1") return;
    } catch {}
    const overlay = document.getElementById("introOverlay");
    if (!overlay) return;
    overlay.style.display = "flex";
    let step = 1;
    const total = 3;
    const showStep = (n) => {
      step = n;
      for (const el of overlay.querySelectorAll(".intro-step")) {
        el.style.display = (parseInt(el.dataset.step, 10) === n) ? "block" : "none";
      }
      const dots = overlay.querySelectorAll(".intro-dots .dot");
      dots.forEach((d, i) => d.classList.toggle("on", i < n));
      const nextBtn = document.getElementById("introNext");
      if (nextBtn) nextBtn.textContent = (n === total) ? "Enter Valhalla" : "Next";
    };
    const dismiss = () => {
      overlay.style.opacity = "0";
      overlay.style.transition = "opacity .35s ease";
      setTimeout(() => { overlay.style.display = "none"; }, 350);
      try { localStorage.setItem("valhalla.seenIntro", "1"); } catch {}
    };
    document.getElementById("introNext")?.addEventListener("click", () => {
      if (step >= total) dismiss();
      else showStep(step + 1);
    });
    document.getElementById("introSkip")?.addEventListener("click", dismiss);
    showStep(1);
  }

  // ---------- three setup ----------
  _initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, powerPreference: "high-performance",
    });
    // pixelRatio HARD-CAPPED at 1.0. On retina this is 4x fewer pixels
    // than native. The scene is low-poly + flat-shaded + grain-overlaid
    // so the sharpness loss is invisible, but the perf win is the
    // single biggest one available. User has repeatedly reported lag
    // even after every other optimisation; this is the last lever.
    // ADAPTIVE QUALITY. auto-detect rough GPU tier so weak machines
    // get a downgrade path without forcing every user into 1980s mode.
    // GPU vendor sniffing via WEBGL_debug_renderer_info is the best
    // we can do in a browser. Default 'auto' falls back to 'high' on
    // anything modern (Apple Silicon, RTX, RX, AMD APUs); 'low' on
    // ancient Intel HD / mobile integrated.
    const qOverride = localStorage.getItem("valhalla.quality");  // 'high' | 'medium' | 'low'
    const quality = qOverride || this._detectGpuTier();
    this.quality = quality;
    // PixelRatio HARD CAPPED at 1.0 regardless of tier. The user has
    // repeatedly reported lag and DPR > 1 is the single biggest GPU
    // multiplier (4x pixels on retina!). Sharpness loss is hidden by
    // FXAA + grain + post-processing.
    this.renderer.setPixelRatio(1.0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    // SHADOWS. one directional sun caster, 1024² max even on high.
    // 2048² doubles the shader cost for marginal visual win at our
    // distances. Disabled entirely on 'low'.
    if (quality === "high" || quality === "medium") {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    } else {
      this.renderer.shadowMap.enabled = false;
    }
    console.log(`[Valhalla] graphics quality: ${quality} (override: ${qOverride || "auto"})`);

    this.scene = new THREE.Scene();
    // HEAVY OVERCAST FOG. Was 40-320 in a pale grey-blue; now 30-180
    // in a darker cold grey. References: opening of The Northman,
    // every fjord shot in Vikings season 1, the misty meadows in The
    // 13th Warrior. Sea mist + dense low cloud = you can see 50-100m
    // and beyond that is suggestion. That's the actual Norse-coastal
    // visibility, AND it hides the procedural geometry detail
    // limitations gracefully.
    const fogColor = new THREE.Color(0x6e7a86);
    this.scene.fog = new THREE.Fog(fogColor, 30, 180);
    this.scene.background = fogColor.clone();

    // Camera lifted higher (4.0 → 5.5) and tilted down more so the
    // player sees further down the lane. addresses "hard to see"
    // feedback. FOV widened 48° → 55° for more peripheral coverage.
    // Far clip extended to 50000 so the Sky.js skybox (sits at radius
    // 5000+) is inside the frustum.
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 50000);
    this.camera.position.set(0, 5.5, -12);
    this.camera.lookAt(0, 1.0, 28);

    // --- Postprocessing pipeline -------------------------------------
    // RenderPass → UnrealBloomPass → FXAA → screen.
    // Bloom is tuned so only material values > 0.85 actually bleed . 
    // strong on runes / mead / Mjölnir / Surtr's sword / aurora, but
    // doesn't wash out the snow.
    try {
      const w = window.innerWidth, h = window.innerHeight;
      this.composer = new EffectComposer(this.renderer);
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);

      const renderPass = new RenderPass(this.scene, this.camera);
      this.composer.addPass(renderPass);

      // SSAO disabled by default. It's the most expensive post pass
      // and the user has repeatedly reported lag. The cinematic LUT +
      // bloom + grain already carry the "lit world" feel without SSAO's
      // contact-shadow overhead. Re-enable via
      //   localStorage.setItem("valhalla.ssao", "1")
      if (localStorage.getItem("valhalla.ssao") === "1") {
        try {
          const ssao = new SSAOPass(this.scene, this.camera, w * 0.4, h * 0.4);
          ssao.kernelRadius = 6;
          ssao.minDistance = 0.002;
          ssao.maxDistance = 0.08;
          this.composer.addPass(ssao);
          this.ssaoPass = ssao;
        } catch (e) {
          console.warn("[Valhalla] SSAO init failed. continuing", e);
        }
      }

      // Bloom. strength 0.25 + threshold 0.95, only true emissives
      // bleed (Mjölnir / runes / fire / mead halo). Quarter-res buffer.
      const bloom = new UnrealBloomPass(new THREE.Vector2(w * 0.4, h * 0.4), 0.25, 0.5, 0.95);
      this.composer.addPass(bloom);
      this.bloomPass = bloom;

      // CINEMATIC LUT. custom shader pass that approximates the
      // Northman/Vikings colour grade: shadows pushed cool (cyan-blue),
      // highlights pushed warm (amber), midtones desaturated. Plus a
      // gentle film-curve contrast lift. This is the SAME function
      // every cinematic colourist runs in DaVinci Resolve as the
      // base grade for Nordic-period drama.
      const lutShader = {
        uniforms: {
          tDiffuse: { value: null },
          uShadowTint:   { value: new THREE.Color(0.78, 0.92, 1.10) },  // cool
          uHighlightTint:{ value: new THREE.Color(1.18, 1.02, 0.78) },  // warm
          uSaturation:   { value: 0.72 },                                 // desaturate
          uContrast:     { value: 1.08 },
          uLift:         { value: -0.02 },                                // crush blacks
        },
        vertexShader: `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform vec3 uShadowTint;
          uniform vec3 uHighlightTint;
          uniform float uSaturation;
          uniform float uContrast;
          uniform float uLift;
          varying vec2 vUv;
          void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
            // Split-toning: cool tint in shadows, warm tint in highlights.
            vec3 tint = mix(uShadowTint, uHighlightTint, smoothstep(0.0, 1.0, lum));
            c.rgb *= tint;
            // Saturation pull.
            c.rgb = mix(vec3(lum), c.rgb, uSaturation);
            // Contrast around 0.5, then black-lift offset.
            c.rgb = (c.rgb - 0.5) * uContrast + 0.5 + uLift;
            gl_FragColor = c;
          }
        `,
      };
      // LUT only on 'high'. it's a full-screen shader pass that adds
      // ~1ms on weak GPUs. ACES filmic + HDRI already give us the
      // cinematic colour grade; LUT is the cherry on top.
      if (this.quality === "high") {
        const lut = new ShaderPass(lutShader);
        this.composer.addPass(lut);
        this.lutPass = lut;
      }

      // FXAA last so it smooths the LUT output.
      const fxaa = new ShaderPass(FXAAShader);
      fxaa.material.uniforms["resolution"].value.set(
        1 / (w * this.renderer.getPixelRatio()),
        1 / (h * this.renderer.getPixelRatio())
      );
      this.composer.addPass(fxaa);
      this.fxaaPass = fxaa;
    } catch (e) {
      console.warn("[Valhalla] postprocessing init failed. falling back", e);
      this.composer = null;
    }

    // IBL is now driven by the Sky.js shader directly (see _buildSky . 
    // PMREM samples the procedural sky into an env map). No CDN
    // dependency, no GPU crash risk, env always matches the current
    // realm's atmosphere. The optional HDRI override stays as a flag
    // for users who want to test with a real captured sky.
    // HDRI environment OFF by default. perf trade-off after
    // repeated user lag reports. The PMREM prefilter + 1k HDR fetch
    // HDRI environment is ON BY DEFAULT now (the user's "looks 1980"
    // call). It's gated inside _loadEnvironment by this.quality; weak
    // GPUs detected by _detectGpuTier get 'low' and skip it. Force
    // disable via:  localStorage.setItem("valhalla.ibl", "0")
    if (localStorage.getItem("valhalla.ibl") !== "0") {
      this._loadEnvironment();
    }

    // --- WebGL context-loss handler ----------------------------------
    // If the GPU driver kills our context (happens on weaker hardware
    // when bloom + shaders + HDRI all push the limits), make sure the
    // page doesn't lock up. Prevent default so the browser will try to
    // restore it; on restore, the composer needs a re-render.
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      console.warn("[Valhalla] WebGL context lost. waiting for restore");
    }, false);
    this.canvas.addEventListener("webglcontextrestored", () => {
      console.warn("[Valhalla] WebGL context restored");
      // Three.js auto-rebuilds materials/textures on restore, but
      // re-render once to kick the composer back to life.
      this._renderOnce();
    }, false);
  }

  // Rough GPU tier from WEBGL_debug_renderer_info. Returns
  // 'high' / 'medium' / 'low'. We bias toward 'high' on anything
  // modern because the visual win from HDRI + shadows is huge and
  // we have the context-loss listener as a backstop.
  _detectGpuTier() {
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
      const r = String(renderer).toLowerCase();
      // Old Intel integrated → low (still gets HDRI off + no shadows)
      if (/intel.*hd graphics (3000|4000|520|530|620|630)/.test(r)) return "low";
      if (/intel.*uhd graphics (6|7|10)/.test(r)) return "low";
      // ONLY top-tier desktop / Apple Silicon Pro/Max gets 'high'.
      // 'high' really only differs in shadow map resolution; pixelRatio
      // is now capped everywhere. Mobile / mid-laptop GPUs marketed as
      // "RTX 3050 Mobile" or "Radeon Graphics integrated" really aren't
      // high tier. they're medium. Default everything else to medium.
      if (/apple.*(m1|m2|m3) (max|ultra|pro)/.test(r)) return "high";
      if (/rtx (40|30|20)([6-9]0)/.test(r)) return "high";    // RTX x060 and up
      if (/rx (6|7)[7-9]00/.test(r)) return "high";           // RX 6700+
      // Everything else → medium (sane default that still gets HDRI + shadows).
      return "medium";
    } catch { return "medium"; }
  }

  // REAL PBR TEXTURE LIBRARY. loads CC0 Polyhaven textures (snow,
  // stone, wood, iron) via their CDN. Each material gets albedo +
  // normal + roughness so flat-coloured procedural meshes suddenly
  // gain surface detail without any geometry change. Loaded once,
  // cached, reused everywhere we build a stone/wood/iron prop.
  //
  // Polyhaven serves CC0 textures from dl.polyhaven.org with proper
  // CORS. Pattern: /file/ph-assets/Textures/jpg/1k/{slug}/{slug}_{map}_1k.jpg
  // Maps used: diff (albedo), nor_gl (OpenGL normal), rough (roughness).
  // If any texture 404s the material just falls back to its colour . 
  // no breakage, just less detail.
  _loadPbrTextureLibrary() {
    // Polyhaven CDN URLs return 404 (their path structure changed).
    // Every texture load was failing and three.js was spamming
    // "Texture marked for update but no image data found" every
    // single frame, killing performance. Disabled entirely until
    // we have a verified CDN. Returns null; _pbrMaterial then falls
    // back to plain colour materials.
    return null;
  }

  // Build a coloured MeshStandardMaterial. Tries PBR textures first;
  // falls back to plain colour. Currently always colour-only because
  // the upstream PBR CDN is broken (see _loadPbrTextureLibrary).
  _pbrMaterial(libKey, opts = {}) {
    // Sensible default colours per material kind so callers don't
    // have to know what they're asking for.
    const fallback = {
      stone: 0x808080, wood: 0x4a3220, iron: 0x6a6e74, snow: 0xc8d4dc,
    };
    return new THREE.MeshStandardMaterial({
      color:     opts.color || fallback[libKey] || 0x808080,
      roughness: opts.roughness != null ? opts.roughness : 0.85,
      metalness: opts.metalness != null ? opts.metalness : (libKey === "iron" ? 0.85 : 0.05),
      flatShading: opts.flatShading !== false,
    });
  }

  // (old PBR path kept here as a noop so _loadPbrTextureLibrary refs
  // don't crash; remove these brackets entirely when PBR CDN returns.)
  _pbrMaterialOLD(libKey, opts = {}) {
    const lib = this._loadPbrTextureLibrary();
    const t = lib ? lib[libKey] : null;
    if (!t) return new THREE.MeshStandardMaterial({ color: opts.color || 0x808080 });
    const clone = (tex, repeat) => {
      const c = tex.clone(); c.needsUpdate = true;
      const r = repeat || 1; c.repeat.set(r, r);
      return c;
    };
    const repeat = opts.repeat || 1;
    return new THREE.MeshStandardMaterial({
      map:          clone(t.diff,  repeat),
      normalMap:    clone(t.nor,   repeat),
      roughnessMap: clone(t.rough, repeat),
      color:        opts.color || 0xffffff,
      metalness:    opts.metalness != null ? opts.metalness : (libKey === "iron" ? 0.85 : 0.05),
      roughness:    opts.roughness != null ? opts.roughness : 1.0,
      normalScale:  new THREE.Vector2(opts.normalScale || 1.0, opts.normalScale || 1.0),
      envMapIntensity: opts.envMapIntensity != null ? opts.envMapIntensity : 1.0,
      flatShading:  false,
    });
  }

  _loadEnvironment() {
    // HDRI environment. gives every PBR material (Soldier.glb, props,
    // armour) realistic reflections/ambient. This is the single
    // biggest visual upgrade from "1980 wireframe" to "modern
    // cinematic render". Skipped on 'low' to keep weak GPUs alive.
    if (this.quality === "low") return;
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      pmrem.compileEquirectangularShader();
      const loader = new RGBELoader();
      // moonless_golf_1k = overcast Nordic-ish sky; works for Vikings vibe.
      // Fallback to quarry_01_1k if moonless fails to load.
      const url = "https://threejs.org/examples/textures/equirectangular/moonless_golf_1k.hdr";
      const fallback = "https://threejs.org/examples/textures/equirectangular/quarry_01_1k.hdr";
      const tryLoad = (u, isRetry) => {
        loader.load(u, (tex) => {
          try {
            const env = pmrem.fromEquirectangular(tex).texture;
            this.scene.environment = env;
            tex.dispose();
            pmrem.dispose();
            console.log("[Valhalla] HDRI environment active");
          } catch (e) {
            console.warn("[Valhalla] HDRI PMREM bake failed", e);
          }
        }, undefined, (err) => {
          if (!isRetry) {
            console.warn("[Valhalla] HDRI load failed, trying fallback", err);
            tryLoad(fallback, true);
          } else {
            console.warn("[Valhalla] HDRI fallback also failed. IBL disabled", err);
          }
        });
      };
      tryLoad(url, false);
    } catch (e) {
      console.warn("[Valhalla] PMREM setup failed", e);
    }
  }

  _buildSky() {
    // REAL ATMOSPHERIC SKY. Three.js Sky uses the Hosek-Wilkie analytical
    // model for daytime sky radiance. Same physical model used in film
    // VFX. Sun position drives all colour automatically: at low sun
    // angle (winter Nordic afternoon) the horizon glows warm orange,
    // zenith stays deep blue, scattering hue varies with elevation.
    // Compared to the previous 4-stop gradient sphere, this is night
    // and day for realism.
    const sky = new Sky();
    // Three.js examples use 450000; we use 8000 to stay well inside the
    // camera far clip (50000) and avoid floating-point issues at depth.
    sky.scale.setScalar(8000);
    const u = sky.material.uniforms;
    // OVERCAST CINEMATIC Viking sky. Heavy turbidity (sea mist), low
    // Rayleigh (no deep blue zenith), high Mie (diffuse cloudy
    // horizon). The previous "golden hour" settings + bloom made the
    // sky bright white. References: The Northman, Vikings TV, The
    // 13th Warrior. all overcast, low contrast, oppressive weather.
    // That's the Nordic look the user actually wants.
    u["turbidity"].value        = 10.0;
    u["rayleigh"].value         = 0.5;
    u["mieCoefficient"].value   = 0.025;
    u["mieDirectionalG"].value  = 0.7;
    this.sky = sky;
    this.scene.add(sky);

    // Sun JUST below horizon for overcast diffuse skylight feel . 
    // no direct sun disk, no golden glare, just heavy cloudy sky.
    const elevation = 4;
    const azimuth   = 200;
    const phi   = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this.sunPos = new THREE.Vector3();
    this.sunPos.setFromSphericalCoords(1, phi, theta);
    u["sunPosition"].value.copy(this.sunPos);

    // Sky-driven IBL is opt-in. PMREMGenerator + cloned Sky shader
    // crashed the GPU context for some users (similar to the HDRI
    // path in round 9). The IBL is a "nice to have". the warm sun
    // + cold rim + warm bounce lighting setup in _buildLights already
    // gives good contrast without it. Enable via:
    //   localStorage.setItem("valhalla.sky_ibl", "1") and reload
    if (localStorage.getItem("valhalla.sky_ibl") === "1") {
      try {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const tmpScene = new THREE.Scene();
        tmpScene.add(sky.clone());
        const rt = pmrem.fromScene(tmpScene, 0);
        this.scene.environment = rt.texture;
        pmrem.dispose();
      } catch (e) {
        console.warn("[Valhalla] sky-driven IBL failed, continuing", e);
      }
    }

    return this._buildSkyExtras();
  }

  _buildSkyExtras() {
    const sunGeo = new THREE.SphereGeometry(14, 16, 12);
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xfff6d8, fog: false, transparent: true, opacity: 0.98,
      depthWrite: false,
    });
    this.sunDisc = new THREE.Mesh(sunGeo, sunMat);
    this.sunDisc.position.copy(this.sunPos).multiplyScalar(600);
    this.scene.add(this.sunDisc);

    const haloGeo = new THREE.SphereGeometry(60, 16, 12);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xffe9b0, fog: false, transparent: true, opacity: 0.26,
      depthWrite: false,
    });
    this.sunHalo = new THREE.Mesh(haloGeo, haloMat);
    this.sunHalo.position.copy(this.sunPos).multiplyScalar(600);
    this.scene.add(this.sunHalo);

    // Volumetric god ray: long cone pointing FROM the sun direction TOWARD
    // the player area, semi-transparent additive. Reads as light shafts
    // breaking through the cold air. This is the single biggest atmospheric
    // upgrade we can do without a real volumetric shader.
    const rayCone = new THREE.Mesh(
      new THREE.ConeGeometry(60, 320, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffe9a8, transparent: true, opacity: 0.10,
        side: THREE.DoubleSide, depthWrite: false, fog: false,
        blending: THREE.AdditiveBlending,
      })
    );
    // Orient cone tip at sun direction; base hangs down toward ground.
    const sunDir = this.sunPos.clone().normalize();
    rayCone.position.copy(sunDir).multiplyScalar(180);
    rayCone.lookAt(0, -40, 60);
    rayCone.rotateX(Math.PI / 2);
    this.scene.add(rayCone);
    this.godRay = rayCone;

    // Secondary fainter shaft for depth
    const ray2 = new THREE.Mesh(
      new THREE.ConeGeometry(120, 380, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xfff0c4, transparent: true, opacity: 0.04,
        side: THREE.DoubleSide, depthWrite: false, fog: false,
        blending: THREE.AdditiveBlending,
      })
    );
    ray2.position.copy(sunDir).multiplyScalar(170);
    ray2.lookAt(0, -40, 60);
    ray2.rotateX(Math.PI / 2);
    this.scene.add(ray2);
    this.godRay2 = ray2;
  }

  _buildLights() {
    // Lighting now plays alongside the Sky.js IBL. the env map gives
    // us full hemispheric sky-coloured ambient automatically, so we
    // can drop the hemi-light and rely on three punchy directional
    // sources: warm key, cold rim, soft fill. Higher contrast than
    // before, addresses "hard to see" + "looks washed out".

    // OVERCAST LIGHTING. cinematic Nordic overcast: soft warm-cool
    // hemisphere skylight + one directional sun (now with real
    // shadows on high/medium) + a cold rim for silhouette separation
    // against fog. References: The Northman, Vikings, 13th Warrior.
    // Lower hemisphere intensity (1.05 -> 0.72) for less flat-fill,
    // more contrast between lit and shadow side. Hyperreal scenes
    // have strong key + soft fill, not omnidirectional flat light.
    const hemi = new THREE.HemisphereLight(0xc4d2e0, 0x2a2a32, 0.72);
    this.scene.add(hemi);

    // Sun key light. Intensity raised from 0.55 -> 1.1 to match the
    // brighter exposure. Now casts a real shadow on medium/high tier.
    const sun = new THREE.DirectionalLight(0xfff0d8, 1.1);
    if (this.sunPos) sun.position.copy(this.sunPos).multiplyScalar(80);
    else sun.position.set(40, 50, -10);
    if (this.renderer.shadowMap.enabled) {
      sun.castShadow = true;
      // Shadow map sized by tier. 1024 on high, 512 on medium.
      // 'low' disables shadowMap entirely upstream.
      sun.shadow.mapSize.set(
        this.quality === "high" ? 1024 : 512,
        this.quality === "high" ? 1024 : 512
      );
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 90;
      // VERY tight frustum. only the play strip + a small buffer.
      // The old 35×30 was way too big; most of the shadow map was
      // wasted on areas the camera couldn't see. Now 18×20 = ~5x
      // higher effective resolution for the same map size, AND
      // fewer casters fall inside the frustum so the pass is faster.
      sun.shadow.camera.left   = -18;
      sun.shadow.camera.right  =  18;
      sun.shadow.camera.top    =  20;
      sun.shadow.camera.bottom = -20;
      sun.shadow.bias = -0.0005;
      sun.shadow.normalBias = 0.05;
    }
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);
    // Rim light removed. the HDRI + hemi + sun trio is enough now
    // that exposure is bumped. One less directional light = perf win.
  }

  // Real CC0 PBR texture loader. pulls colour + normal maps from
  // threejs.org's official examples CDN (stable, CORS-safe, won't
  // 404 next week). Loads async and swaps into the ground material
  // when ready. Procedural canvas texture is the immediate fallback
  // so the world looks intact from frame 1.
  _loadRealGroundTextures() {
    if (!this.chunkMat) return;
    try {
      const loader = new THREE.TextureLoader();
      // Threejs.org hosts a high-detail noise sheet at this stable URL.
      // Repurposed as snow micro-relief: when tinted cool-white via
      // material.color, the noise reads as wind-packed snow crystals.
      const colorURL = "https://threejs.org/examples/textures/terrain/grasslight-big.jpg";
      // (No separate normal map. the previous URL 404'd.)

      loader.load(colorURL, (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(14, 14);                  // tight tiling, no obvious seams
        tex.anisotropy = 8;
        tex.colorSpace = THREE.SRGBColorSpace;
        this.chunkMat.map = tex;
        // Tint the warm grass tones toward cold snow.
        this.chunkMat.color = new THREE.Color(0xc8d4dc);
        this.chunkMat.needsUpdate = true;
      }, undefined, (err) => {
        console.warn("[Valhalla] ground PBR colour map load failed (keeping procedural)", err);
      });

      // Normal-map URL I picked earlier (grasslight-big-nm.jpg) doesn't
      // exist on threejs.org and returned 404. Skipped. the existing
      // bumpMap fallback inside the procedural canvas texture already
      // gives surface relief. If a real PBR normal map ships later,
      // wire it in here.
    } catch (e) {
      console.warn("[Valhalla] ground texture loader setup failed", e);
    }
  }

  _buildGround() {
    // Higher tessellation so per-vertex displacement reads as actual snow
    // microrelief, not flat plane with paint. 40x52 segs = ~2000 verts
    // per chunk - still cheap.
    const segW = 40, segL = 52;
    const geo = new THREE.PlaneGeometry(GROUND_WIDTH, CHUNK_LENGTH, segW, segL);
    geo.rotateX(-Math.PI / 2);

    // PBR snow with sheen. real snow has a velvety sheen from sub-
    // surface scattering off ice crystals. MeshPhysicalMaterial.sheen
    // models exactly that. Combined with the procedural noise texture
    // as both colour and bump, the ground now reads as actual packed
    // snow instead of flat-shaded vertex paint. The sky-driven IBL
    // (set as scene.environment by _buildSky) gives it real sky-lit
    // ambient + reflections so the snow shifts colour with the time
    // of day.
    const tex = this._makeSnowTexture();
    const snowMat = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.78,           // snow is rough but not chalky
      metalness: 0.0,
      sheen: 0.6,                // velvety crystal scattering
      sheenColor: new THREE.Color(0xeaf4fb),
      sheenRoughness: 0.55,
      flatShading: false,
      map: tex,
      bumpMap: tex,
      bumpScale: 0.22,
      envMapIntensity: 1.2,      // pick up sky reflections strongly
    });

    this.chunkGeo = geo;
    this.chunkMat = snowMat;

    for (let i = 0; i < CHUNK_COUNT; i++) {
      const chunk = this._makeChunk(i * CHUNK_LENGTH);
      this.chunks.push(chunk);
      this.scene.add(chunk.mesh);
    }

    // Kick off async load of real PBR snow textures from threejs CDN.
    // The procedural canvas texture is already applied so the world
    // looks fine from frame 1; when the high-res maps land they swap
    // in and the ground gets real surface detail.
    this._loadRealGroundTextures();
  }

  _makeSnowTexture() {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    // Base off-white snow color
    ctx.fillStyle = "#e8edf2";
    ctx.fillRect(0, 0, size, size);
    // Multi-frequency noise: speckle of cool greys + faint blues for crystal
    // detail. Renders as a soft micro-noise texture that reads as snow grain.
    const img = ctx.getImageData(0, 0, size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const n = fbm(x * 0.06, y * 0.06) * 0.7 + fbm(x * 0.25, y * 0.25) * 0.3;
        const v = 220 + n * 35;
        const blue = 235 + n * 20;
        d[idx]     = v;
        d[idx + 1] = v + 2;
        d[idx + 2] = blue;
        d[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // Scatter sparkles (tiny brighter dots) for sunlit ice crystals
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (let i = 0; i < 90; i++) {
      ctx.fillRect((Math.random() * size) | 0, (Math.random() * size) | 0, 1, 1);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 8);
    tex.anisotropy = 4;
    return tex;
  }

  _makeChunk(zStart) {
    const geo = this.chunkGeo.clone();
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    // Layered palette - sunlit snow -> cool shadow -> mossy edge -> rock.
    // The blue-tinted shadow color is what makes snow read as SNOW
    // (frozen water) instead of white plastic.
    const sunSnow = new THREE.Color(0xf5f6f0);
    const shadowSnow = new THREE.Color(0xb4c4d4);
    const trodden = new THREE.Color(0xa7b3bd);
    const moss = new THREE.Color(0x435a3f);
    const rock = new THREE.Color(0x5a6068);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i) + zStart;
      const h = groundHeight(x, z);
      pos.setY(i, h);
      const distFromPath = Math.max(0, Math.abs(x) - 6);
      const t = Math.min(1, distFromPath / 18);
      const c = new THREE.Color();
      // Path band: trodden cool snow with two-tone noise for that
      // "footprints have been here" feel
      const pathNoise = fbm(x * 0.12, z * 0.08);
      if (Math.abs(x) < 5.2) {
        c.lerpColors(trodden, sunSnow, pathNoise * 0.8 + 0.2);
      } else {
        // Outside: snowy shadow blending into moss/rock
        c.lerpColors(shadowSnow, distFromPath > 14 ? rock : moss, t);
      }
      // Subtle multi-frequency variation so the surface never reads flat
      const n = fbm(x * 0.3, z * 0.3) * 0.5 + fbm(x * 0.06, z * 0.06) * 0.5;
      c.r *= 0.88 + n * 0.24;
      c.g *= 0.88 + n * 0.24;
      c.b *= 0.9 + n * 0.2;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.chunkMat);
    mesh.receiveShadow = true;
    mesh.position.set(0, 0, zStart + CHUNK_LENGTH / 2);
    // path stones: subtle stripe in center
    return { mesh, zStart, decor: this._populateChunk(zStart) };
  }

  _populateChunk(zStart) {
    // InstancedMesh-based decor. We allocate one Group per chunk that
    // contains four instanced meshes (trunk, lower foliage, upper foliage,
    // snowcap) plus a rocks instance. ~140 trees per chunk × 6 chunks = 840
    // trees rendered in ~5 draw calls total (vs. 930+ before).
    const decor = new THREE.Group();
    const tmp = new THREE.Object3D();

    const TREE_COUNT = 140;
    // Trunk now uses a LatheGeometry from a tapered+jagged profile . 
    // breaks the perfect cylinder silhouette that screamed "procedural".
    // Slight bark roughness on the radius gives the trunk a real edge
    // contour when backlit.
    const trunkPoints = [];
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const baseR = 0.22 - t * 0.06;            // tapers from 0.22 → 0.16
      const jitter = (Math.sin(i * 1.7) + Math.cos(i * 2.3)) * 0.012;
      trunkPoints.push(new THREE.Vector2(Math.max(0.05, baseR + jitter), t * 1.5));
    }
    const trunkGeo = new THREE.LatheGeometry(trunkPoints, 8);
    // Foliage cones get per-vertex displacement so each instance still
    // shares one geometry but no longer looks like a perfect cone.
    // Noise applied at build time, baked into vertex positions.
    const noisyCone = (radius, height, segs) => {
      const g = new THREE.ConeGeometry(radius, height, segs);
      const pos = g.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
        // Don't displace the tip (creates a clean point) or the very
        // bottom edge (keeps the base ring tidy).
        if (Math.abs(y - height / 2) < 0.05 || Math.abs(y + height / 2) < 0.05) continue;
        const n = Math.sin(x * 11.2 + z * 7.4) * 0.06 + Math.cos(y * 5.1) * 0.04;
        pos.setXYZ(v, x + n * x, y, z + n * z);
      }
      pos.needsUpdate = true;
      g.computeVertexNormals();
      return g;
    };
    const lowGeo = noisyCone(1.3, 1.5, 8);  lowGeo.translate(0, 1.4 + 0.45, 0);
    const midGeo = noisyCone(1.0, 1.5, 8);  midGeo.translate(0, 1.4 + 0.85 + 0.45, 0);
    const topGeo = noisyCone(0.7, 1.5, 8);  topGeo.translate(0, 1.4 + 1.7 + 0.45, 0);
    const capGeo = new THREE.ConeGeometry(0.4, 0.5, 8);
    capGeo.translate(0, 1.4 + 3.0, 0);

    // Slight variation between layers so the canopy reads as 3 distinct
    // tone bands of needles (real conifers have this exact look).
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x2e1c0c, roughness: 0.95, flatShading: false });
    const lowMat = new THREE.MeshStandardMaterial({ color: 0x18301f, roughness: 0.92, flatShading: true });
    const midMat = new THREE.MeshStandardMaterial({ color: 0x223e2c, roughness: 0.88, flatShading: true });
    const topMat = new THREE.MeshStandardMaterial({ color: 0x305a44, roughness: 0.82, flatShading: true });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xf6f9fc, roughness: 0.35, flatShading: true });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, TREE_COUNT);
    const lows = new THREE.InstancedMesh(lowGeo, lowMat, TREE_COUNT);
    const mids = new THREE.InstancedMesh(midGeo, midMat, TREE_COUNT);
    const tops = new THREE.InstancedMesh(topGeo, topMat, TREE_COUNT);
    const caps = new THREE.InstancedMesh(capGeo, capMat, TREE_COUNT);
    for (const m of [trunks, lows, mids, tops, caps]) {
      m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
    }

    for (let i = 0; i < TREE_COUNT; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const farBand = Math.random() < 0.55;
      const x = side * (farBand ? 24 + Math.random() * 31 : 8 + Math.random() * 16);
      const z = zStart + Math.random() * CHUNK_LENGTH;
      // Non-uniform scale per instance: independent height + girth
      // variance. Real conifer stands have huge variance in both axes
      // and that's the single visual cue that turns "field of clones"
      // into "real forest". Slight tilt rotation too (wind-shaped).
      const baseS = (farBand ? 1.1 : 0.85) + Math.random() * 0.9;
      const heightMul = 0.7 + Math.random() * 0.6;   // 0.7-1.3
      const girthMul = 0.75 + Math.random() * 0.5;   // 0.75-1.25
      const tilt = (Math.random() - 0.5) * 0.12;
      const y = groundHeight(x, z) - 0.1;
      tmp.position.set(x, y, z);
      tmp.rotation.set(tilt, Math.random() * Math.PI * 2, tilt * 0.5);
      tmp.scale.set(baseS * girthMul, baseS * heightMul, baseS * girthMul);
      tmp.updateMatrix();
      trunks.setMatrixAt(i, tmp.matrix);
      lows.setMatrixAt(i, tmp.matrix);
      mids.setMatrixAt(i, tmp.matrix);
      tops.setMatrixAt(i, tmp.matrix);
      caps.setMatrixAt(i, tmp.matrix);
    }
    trunks.instanceMatrix.needsUpdate = true;
    lows.instanceMatrix.needsUpdate = true;
    mids.instanceMatrix.needsUpdate = true;
    tops.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
    decor.add(trunks, lows, mids, tops, caps);

    // Rocks. vertex-displaced icosahedron, much more organic than the
    // perfect dodecahedron. Each instance gets a unique random rotation
    // so the same geometry reads as a hundred different rocks.
    const ROCK_COUNT = 26;
    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    const rPos = rockGeo.attributes.position;
    for (let v = 0; v < rPos.count; v++) {
      const x = rPos.getX(v), y = rPos.getY(v), z = rPos.getZ(v);
      const n = Math.sin(x * 4.7 + z * 3.1) * 0.18
              + Math.cos(y * 5.3 + x * 2.2) * 0.14
              + (Math.random() - 0.5) * 0.08;
      const l = Math.sqrt(x * x + y * y + z * z);
      const f = 1 + n;
      rPos.setXYZ(v, x / l * f, y / l * f, z / l * f);
    }
    rPos.needsUpdate = true;
    rockGeo.computeVertexNormals();
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x5f656e, roughness: 0.98, flatShading: true,
    });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, ROCK_COUNT);
    rocks.castShadow = false; rocks.receiveShadow = false; rocks.frustumCulled = false;
    for (let i = 0; i < ROCK_COUNT; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * (6.5 + Math.random() * 26);
      const z = zStart + Math.random() * CHUNK_LENGTH;
      // Non-uniform rock scale. boulders are oblate not spherical.
      const r = 0.5 + Math.random() * 1.6;
      const sx = r * (0.7 + Math.random() * 0.6);
      const sy = r * (0.5 + Math.random() * 0.7);
      const sz = r * (0.7 + Math.random() * 0.6);
      tmp.position.set(x, groundHeight(x, z) + sy * 0.4, z);
      tmp.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI * 2, Math.random() * Math.PI);
      tmp.scale.set(sx, sy, sz);
      tmp.updateMatrix();
      rocks.setMatrixAt(i, tmp.matrix);
    }
    rocks.instanceMatrix.needsUpdate = true;
    decor.add(rocks);

    // Runestone - keep as single mesh (rare, individual character).
    if (Math.random() < 0.55) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * (5.6 + Math.random() * 1.4);
      const z = zStart + 10 + Math.random() * (CHUNK_LENGTH - 20);
      const rune = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 2.6, 0.32),
        new THREE.MeshStandardMaterial({ color: 0x52575e, roughness: 0.88, flatShading: true })
      );
      rune.position.set(x, groundHeight(x, z) + 1.3, z);
      rune.rotation.y = (Math.random() - 0.5) * 0.4;
      rune.castShadow = true;
      decor.add(rune);
    }

    this.scene.add(decor);
    return decor;
  }

  _buildWater() {
    // Two long fjord strips far to the sides, with the real Water
    // shader. Procedural normal map as immediate fallback so the
    // water looks correct from frame 1; real high-quality normals
    // from threejs CDN load async and swap in.
    const waterGeo = new THREE.PlaneGeometry(60, VIEW_DEPTH);
    const fallbackNormals = this._makeRippleTexture();
    const makeWater = () => new Water(waterGeo, {
      textureWidth: 256, textureHeight: 256,
      waterNormals: fallbackNormals,
      sunDirection: this.sunPos.clone().normalize(),
      sunColor: 0xfff2d4,
      waterColor: 0x1a2030,         // deeper Nordic fjord blue-grey
      distortionScale: 2.2,         // more ripple detail
      fog: true,
      // alpha < 1 lets the dark water colour show through reflection
      // for that deep-fjord look (full reflection looks like a chrome
      // sheet which breaks the misty atmosphere).
      alpha: 0.95,
    });
    const left = makeWater();
    left.rotation.x = -Math.PI / 2;
    left.position.set(-58, -2.4, VIEW_DEPTH / 2);
    this.scene.add(left);
    const right = makeWater();
    right.rotation.x = -Math.PI / 2;
    right.position.set(58, -2.4, VIEW_DEPTH / 2);
    this.scene.add(right);
    this.water = [left, right];

    // Real water normal map. swap in over the procedural one for
    // proper photographic ripples. threejs.org/examples ships this
    // texture; same CORS path as Soldier.glb and Horse.glb.
    try {
      new THREE.TextureLoader().load(
        "https://threejs.org/examples/textures/waternormals.jpg",
        (tex) => {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          for (const w of this.water) {
            w.material.uniforms["normalSampler"].value = tex;
          }
          console.log("[Valhalla] real water normals loaded");
        }
      );
    } catch (e) { console.warn("[Valhalla] water normals load failed", e); }
  }

  // GOD RAYS. cheap, beautiful. Six additive radial-gradient planes
  // anchored to the sun direction, fading by distance. Reads as
  // sunlight cutting through the canopy / mist without needing the
  // expensive GodRaysPass shader.
  _buildGodRays() {
    if (this.quality === "low") return;
    const grp = new THREE.Group();
    // Radial-gradient texture: warm core fading to transparent.
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0,    "rgba(255,234,196,0.50)");
    g.addColorStop(0.4,  "rgba(255,210,150,0.18)");
    g.addColorStop(1,    "rgba(255,200,140,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, side: THREE.DoubleSide,
    });
    // 6 elongated rays at decreasing scale + opacity
    for (let i = 0; i < 6; i++) {
      const ray = new THREE.Mesh(new THREE.PlaneGeometry(40, 80), mat.clone());
      ray.material.opacity = 0.18 - i * 0.02;
      ray.position.set(
        (Math.random() - 0.5) * 30,
        18 + i * 4,
        20 + i * 10
      );
      // Rotate to point roughly from sun toward camera
      ray.rotation.x = -Math.PI / 4 + (Math.random() - 0.5) * 0.2;
      ray.rotation.z = Math.PI / 6 + (Math.random() - 0.5) * 0.4;
      ray.userData.driftSpeed = 0.05 + Math.random() * 0.08;
      ray.userData.phase = Math.random() * Math.PI * 2;
      grp.add(ray);
    }
    this.godRays = grp;
    this.scene.add(grp);
  }

  // Per-frame: drift rays slowly and follow the camera so they always
  // read against the sun direction.
  _updateGodRays(dt) {
    if (!this.godRays) return;
    const t = performance.now() * 0.001;
    this.godRays.position.z = this.distance + 60;
    this.godRays.position.x = this.player ? this.player.position.x * 0.3 : 0;
    for (const ray of this.godRays.children) {
      const u = ray.userData;
      // Subtle breathing. opacity fluctuates 0.6-1.0 of baseline so
      // the rays feel alive (like light pulsing through moving clouds).
      ray.material.opacity = (ray.material.opacity || 0.1) *
        (0.7 + 0.3 * (0.5 + 0.5 * Math.sin(t * u.driftSpeed * 4 + u.phase)));
      // Cap so it doesn't drift toward 0 over many frames.
      if (ray.material.opacity < 0.005) ray.material.opacity = 0.01;
    }
  }

  // VOLUMETRIC MIST. drifting low ground sprites. 12 quads with a
  // soft-edged white-grey texture, alpha-blended, scrolling slowly.
  // Cheap atmospheric depth.
  _buildMist() {
    if (this.quality === "low") return;
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
    g.addColorStop(0,   "rgba(220,225,232,0.55)");
    g.addColorStop(0.6, "rgba(200,210,220,0.22)");
    g.addColorStop(1,   "rgba(200,210,220,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, fog: true,
      side: THREE.DoubleSide, opacity: 0.65,
    });
    const grp = new THREE.Group();
    const count = this.quality === "high" ? 14 : 8;
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(18, 6), mat.clone());
      m.position.set(
        (Math.random() - 0.5) * 40,
        0.4 + Math.random() * 1.2,
        i * 25 + Math.random() * 12
      );
      m.rotation.x = -Math.PI / 2 + 0.05;
      m.rotation.y = (Math.random() - 0.5) * 0.6;
      m.material.opacity = 0.35 + Math.random() * 0.2;
      m.userData.drift = 0.5 + Math.random() * 0.4;
      grp.add(m);
    }
    this.mist = grp;
    this.scene.add(grp);
  }

  _updateMist(dt) {
    if (!this.mist) return;
    for (const m of this.mist.children) {
      // Drift sideways slowly (wind direction).
      m.position.x += m.userData.drift * dt * 0.3;
      if (m.position.x > 30) m.position.x = -30;
      // Recycle when far behind camera.
      if (m.position.z < this.distance - 30) m.position.z += 14 * 25;
    }
  }

  _makeRippleTexture() {
    // Procedural normal-ish texture for water
    const size = 128;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const n = fbm(x * 0.06, y * 0.06);
        data[i] = 120 + n * 60;
        data[i + 1] = 120 + (1 - n) * 60;
        data[i + 2] = 220;
        data[i + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 12);
    tex.needsUpdate = true;
    return tex;
  }

  _buildMountains() {
    // Three layers of mountains for proper depth.
    // - Near ridge (~80-120m): big, dark, dramatic silhouettes
    // - Far ridge (~180-260m): smaller, lighter, almost lost in haze
    // - Sentinel peaks ahead in the distance for the "into the unknown" feel
    // Using InstancedMesh per ring so we keep this cheap.
    const tmp = new THREE.Object3D();

    const makeRing = (count, sideRadius, baseDistAhead, distSpan, heightRange, opts) => {
      const baseMat = new THREE.MeshStandardMaterial({
        color: opts.color, roughness: 1.0, flatShading: true,
      });
      const snowMat = new THREE.MeshStandardMaterial({
        color: opts.snow, roughness: 0.7, flatShading: true,
      });
      const baseGeo = new THREE.ConeGeometry(1, 1, 6);
      const snowGeo = new THREE.ConeGeometry(0.42, 0.32, 6);
      // Snow cap geo's "0" is at base center; translate up so it sits near tip
      snowGeo.translate(0, 0.84, 0);
      const bases = new THREE.InstancedMesh(baseGeo, baseMat, count);
      const snows = new THREE.InstancedMesh(snowGeo, snowMat, count);
      bases.frustumCulled = false; snows.frustumCulled = false;
      for (let i = 0; i < count; i++) {
        const tFrac = i / count;
        const z = baseDistAhead + tFrac * distSpan + (Math.random() - 0.5) * distSpan * 0.4;
        const side = (i & 1) === 0 ? -1 : 1;
        const lateral = sideRadius + (Math.random() - 0.5) * sideRadius * 0.7;
        const x = side * lateral;
        const h = heightRange[0] + Math.random() * (heightRange[1] - heightRange[0]);
        const r = h * (0.32 + Math.random() * 0.18);
        tmp.position.set(x, h / 2 - 3, z);
        tmp.rotation.set(0, Math.random() * Math.PI * 2, 0);
        tmp.scale.set(r, h, r);
        tmp.updateMatrix();
        bases.setMatrixAt(i, tmp.matrix);
        // Snow uses same transform; cap sits at top of cone
        tmp.scale.set(r, h, r);
        tmp.updateMatrix();
        snows.setMatrixAt(i, tmp.matrix);
      }
      bases.instanceMatrix.needsUpdate = true;
      snows.instanceMatrix.needsUpdate = true;
      const grp = new THREE.Group();
      grp.add(bases, snows);
      return grp;
    };

    this.mountainRing = new THREE.Group();
    // Near ridge - closer and taller so it dominates the horizon rather
    // than fading into haze. This is the "we're in a real place with real
    // scale" shot.
    this.mountainRing.add(makeRing(20, 55, -30, 220, [75, 140], {
      color: 0x4a525e, snow: 0xf2f6fa,
    }));
    // Mid ridge - the haze layer, smaller and lighter
    this.mountainRing.add(makeRing(18, 130, 0, 320, [100, 180], {
      color: 0x6a7480, snow: 0xeaf0f5,
    }));
    // Sentinel peaks ahead - three or four giants emerging from the fog
    // dead center, drawing the eye forward.
    this.mountainRing.add(makeRing(5, 22, 180, 140, [150, 240], {
      color: 0x525c69, snow: 0xf5f8fb,
    }));
    this.scene.add(this.mountainRing);
  }

  _buildPlayer() {
    const grp = new THREE.Group();

    // Body silhouette upgraded from stacked boxes to capsule + cone
    // geometry. CapsuleGeometry is just a cylinder with hemispheres on
    // both ends. gives a continuous shoulder-to-hip volume that reads
    // as a real human torso instead of "minecraft figure". Materials
    // stay non-emissive earthy wool (madder/woad/walnut palette).
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.36, 0.65, 6, 14),
      new THREE.MeshStandardMaterial({ color: 0x5a4838, roughness: 0.95, flatShading: false })
    );
    body.position.y = 1.05;
    grp.add(body);

    // Over-tunic / surcoat. a slightly wider lower band in darker wool.
    const tunic = new THREE.Mesh(
      new THREE.CylinderGeometry(0.40, 0.46, 0.45, 14),
      new THREE.MeshStandardMaterial({ color: 0x36281c, roughness: 0.95, flatShading: false })
    );
    tunic.position.y = 0.62;
    grp.add(tunic);

    // Tooled leather belt. torus reads as a real cinched belt.
    const belt = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.06, 8, 18),
      new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 0.55, metalness: 0.25 })
    );
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 0.85;
    grp.add(belt);
    // Iron belt buckle.
    const buckle = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.10, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x6c707a, metalness: 0.85, roughness: 0.4 })
    );
    buckle.position.set(0, 0.85, 0.42);
    grp.add(buckle);

    // Head. sphere, slightly elongated, weathered skin tone.
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.30, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xcfa07b, roughness: 0.7, flatShading: false })
    );
    head.scale.set(0.95, 1.08, 1.0);
    head.position.y = 1.78;
    grp.add(head);

    // Auburn beard. capsule shape so it actually wraps the jaw.
    const beard = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.16, 0.10, 4, 10),
      new THREE.MeshStandardMaterial({ color: 0x6a3214, roughness: 0.95, flatShading: false })
    );
    beard.scale.set(1.4, 1.0, 0.7);
    beard.position.set(0, 1.55, 0.18);
    grp.add(beard);

    // Helmet. historically-accurate spangenhelm style. NO HORNS (the
    // horned-helmet image is a 19th-century Wagner-opera invention; no
    // Viking-age helmet ever had them). Weathered iron with a centre
    // ridge and a nose-guard for that real-world Norse silhouette.
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.36, 10, 7, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.55, metalness: 0.7, flatShading: true })
    );
    helmet.position.y = 2.02;
    helmet.castShadow = true;
    grp.add(helmet);
    // Centre ridge band. iron strip running front-to-back across the crown.
    const helmRidge = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.04, 0.74),
      new THREE.MeshStandardMaterial({ color: 0x2a2d32, roughness: 0.4, metalness: 0.8 })
    );
    helmRidge.position.y = 2.22;
    grp.add(helmRidge);
    const noseGuard = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.30, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.7, roughness: 0.55 })
    );
    noseGuard.position.set(0, 1.84, 0.30);
    grp.add(noseGuard);

    // Arms. capsules so shoulders + elbows + hands read as one volume.
    const armMat = new THREE.MeshStandardMaterial({ color: 0x5a4838, roughness: 0.95, flatShading: false });
    const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.55, 4, 10), armMat);
    armL.position.set(-0.48, 1.05, 0);
    grp.add(armL);
    const armR = armL.clone();
    armR.position.x = 0.48;
    grp.add(armR);

    // Trouser legs. capsules in darker wool / oiled leather tone.
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.95, flatShading: false });
    const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.5, 4, 10), legMat);
    legL.position.set(-0.18, 0.4, 0);
    grp.add(legL);
    const legR = legL.clone();
    legR.position.x = 0.18;
    grp.add(legR);
    // Cross-bound leg wraps (winningas). three thin dark stripes per
    // shin so the legs read as Viking-age dress.
    const wrapMat = new THREE.MeshStandardMaterial({ color: 0x0e0805, roughness: 1.0 });
    for (const lx of [-0.18, 0.18]) {
      for (let i = 0; i < 3; i++) {
        const wrap = new THREE.Mesh(
          new THREE.TorusGeometry(0.15, 0.018, 6, 14),
          wrapMat
        );
        wrap.rotation.x = Math.PI / 2;
        wrap.position.set(lx, 0.20 + i * 0.10, 0);
        grp.add(wrap);
      }
    }

    // Axe in right hand
    const axeHandle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.7, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a2418, roughness: 0.9 })
    );
    axeHandle.position.set(0.62, 1.3, 0.05);
    axeHandle.rotation.z = -0.3;
    grp.add(axeHandle);
    const axeHead = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.28, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x808890, metalness: 0.85, roughness: 0.25, flatShading: true })
    );
    axeHead.position.set(0.78, 1.55, 0.05);
    axeHead.rotation.z = -0.3;
    grp.add(axeHead);

    // Shield on back. weathered linden-wood planks with iron rim and
    // iron boss. Wood pigment is desaturated ochre, not the cartoonish
    // red it was previously (Viking shields WERE often painted, but
    // saturated arcade-red reads as "game prop" not "weathered gear").
    const shield = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.45, 0.06, 18),
      new THREE.MeshStandardMaterial({ color: 0x6a4528, roughness: 0.95, flatShading: true })
    );
    shield.rotation.x = Math.PI / 2;
    shield.position.set(0, 1.05, -0.32);
    grp.add(shield);
    // Plank seams. three thin dark stripes across the face for texture.
    for (let i = -1; i <= 1; i++) {
      const seam = new THREE.Mesh(
        new THREE.BoxGeometry(0.86, 0.018, 0.02),
        new THREE.MeshStandardMaterial({ color: 0x1d130a, roughness: 1.0 })
      );
      seam.position.set(0, 1.05 + i * 0.18, -0.36);
      grp.add(seam);
    }
    const shieldRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.46, 0.035, 6, 28),
      new THREE.MeshStandardMaterial({ color: 0x1a1208, metalness: 0.65, roughness: 0.55 })
    );
    shieldRim.rotation.x = Math.PI / 2;
    shieldRim.position.set(0, 1.05, -0.32);
    grp.add(shieldRim);
    const shieldBoss = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x4a4d52, metalness: 0.8, roughness: 0.5 })
    );
    shieldBoss.position.set(0, 1.05, -0.36);
    grp.add(shieldBoss);

    // Save references for animation. `procPlayer` holds the procedural
    // mesh assembly we just built. it's the placeholder shown until
    // the real GLB rigged character loads from CDN. Same parent group
    // is reused so all the bio aura / shield glow / Mjölnir aura code
    // keeps working without any rewire.
    this.player = grp;
    this.procPlayer = new THREE.Group();
    // Cast shadows from all procedural body parts so the player has
    // ground contact even when the GLB hasn't loaded yet.
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    // Move all the existing procedural children into procPlayer so we
    // can hide/show that whole sub-tree atomically when the GLB lands.
    while (grp.children.length > 0) {
      this.procPlayer.add(grp.children[0]);
    }
    grp.add(this.procPlayer);
    this.playerParts = { armL, armR, legL, legR, head, helmet, body };
    this.scene.add(grp);

    // Kick off async load of the real character. Game runs with the
    // procedural placeholder until this resolves; on success we swap
    // the GLB in and hide the placeholder. If the load fails (CDN
    // down, CORS, etc), we just stay with the procedural figure.
    this._loadRealPlayer();

    // Player shadow disc (cheap)
    const shadowDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.7, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 })
    );
    shadowDisc.rotation.x = -Math.PI / 2;
    shadowDisc.position.y = 0.02;
    this.shadowDisc = shadowDisc;
    this.scene.add(shadowDisc);

    // Footprint trail - ring of tiny circles cycled behind the player.
    // Adds tangible "I'm leaving tracks in the snow" feedback that sells
    // the snow surface as real.
    this.footprints = [];
    const fpGeo = new THREE.CircleGeometry(0.18, 8);
    const fpMat = new THREE.MeshBasicMaterial({
      color: 0x4a5868, transparent: true, opacity: 0.45, depthWrite: false,
    });
    for (let i = 0; i < 24; i++) {
      const fp = new THREE.Mesh(fpGeo, fpMat.clone());
      fp.rotation.x = -Math.PI / 2;
      fp.position.y = 0.025;
      fp.visible = false;
      fp.userData.side = i % 2 === 0 ? -0.18 : 0.18;
      this.scene.add(fp);
      this.footprints.push(fp);
    }
    this._fpIdx = 0;
    this._fpAccum = 0;

    // BREATH PUFFS. small Points cloud rising + drifting back from the
    // player's mouth. In a cold Norse realm you can see your own breath.
    // This single detail does more for "I'm a living person in this
    // world" than any HUD element. 24 reusable particles cycling.
    const breathCount = 24;
    const breathPos = new Float32Array(breathCount * 3);
    const breathLife = new Float32Array(breathCount); // 0..1 age
    for (let i = 0; i < breathCount; i++) breathLife[i] = -1; // inactive
    const breathGeo = new THREE.BufferGeometry();
    breathGeo.setAttribute("position", new THREE.BufferAttribute(breathPos, 3));
    const breathMat = new THREE.PointsMaterial({
      color: 0xf6f9fc, size: 0.42, transparent: true, opacity: 0.0,
      depthWrite: false, fog: true, sizeAttenuation: true,
    });
    const breath = new THREE.Points(breathGeo, breathMat);
    breath.frustumCulled = false;
    grp.add(breath);
    this._breath = { points: breath, life: breathLife, lastEmit: 0 };

    // Bio aura. a soft glowing sphere wrapped around the player whose
    // colour is driven by the cognitive state. Starts invisible; comes
    // on the moment a biosignal is active. This is the player's visible
    // proof that the body/mind is actually doing something to the game.
    const auraMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.BackSide,
    });
    const bioAura = new THREE.Mesh(new THREE.SphereGeometry(1.5, 18, 12), auraMat);
    bioAura.position.y = 1.1;
    grp.add(bioAura);
    this._bioAura = bioAura;
    this._bioAuraTargetColor = new THREE.Color(0xffffff);
    this._bioAuraTargetOpacity = 0;
  }

  // Async-load a real rigged 3D human from threejs.org's CC0 model
  // library and swap him in for the procedural capsule placeholder.
  // Soldier.glb is a complete human with built-in walk/run/idle
  // animations. once it lands the player goes from "stack of
  // capsules" to "actual person", which is the single biggest
  // "looks like real Earth" upgrade available without an asset
  // pipeline of our own.
  _loadRealPlayer() {
    const URL = "https://threejs.org/examples/models/gltf/Soldier.glb";
    try {
      const loader = new GLTFLoader();
      loader.load(URL, (gltf) => {
        try {
          // Use gltf.scene directly. We never load Soldier twice, so
          // we don't need SkeletonUtils.clone. that was only required
          // when re-using a rigged model. Direct use preserves the
          // bone bindings the AnimationMixer needs.
          const model = gltf.scene;
          // Soldier.glb is ~1.8 units tall facing -Z. Our procedural
          // player is ~2.0 tall facing +Z. Scale + rotate to match.
          model.scale.setScalar(1.05);
          model.rotation.y = Math.PI;            // face forward (+Z)
          // VIKING RESKIN. Soldier.glb ships modern military fatigues
          // (camo / nylon / black boots). We override every mesh's
          // material with Viking-era tones so the rig + animations
          // stay but the character reads as a Norse warrior, not a
          // soldier. Detect by mesh name heuristics; bone count
          // matters more than what the texture said.
          model.traverse((o) => {
            if (!o.isMesh) return;
            o.frustumCulled = false;
            // Cast shadows (the sun light renders them on medium/high).
            o.castShadow = true;
            o.receiveShadow = true;
            // Clone the material so we don't mutate cached/shared maps.
            const original = o.material;
            // No 'skinning' option. that's not a MeshStandardMaterial
            // property in modern Three.js (the mesh's isSkinnedMesh
            // flag controls skinning automatically). Setting it
            // emitted a warning per traversed mesh.
            const m = new THREE.MeshStandardMaterial({
              roughness: 0.92, metalness: 0.05,
              envMapIntensity: 0.85,
              flatShading: false,
            });
            const name = (o.name || "").toLowerCase();
            // Map every typical Soldier mesh into a Viking palette.
            if (/head|face|hair/.test(name)) {
              m.color = new THREE.Color(0xcaa380);             // weathered skin
              m.roughness = 0.78;
            } else if (/helm|hat|cap/.test(name)) {
              m.color = new THREE.Color(0x3a3d42);             // weathered iron
              m.metalness = 0.7; m.roughness = 0.5;
            } else if (/torso|body|chest|shirt|jacket|vest/.test(name)) {
              m.color = new THREE.Color(0x5a4a36);             // undyed wool
              m.roughness = 0.97;
            } else if (/arm|hand|sleeve/.test(name)) {
              m.color = new THREE.Color(0x4a3c2a);             // darker wool sleeve
              m.roughness = 0.97;
            } else if (/leg|pant|trouser|boot|foot|shoe/.test(name)) {
              m.color = new THREE.Color(0x2a1d14);             // oiled leather
              m.roughness = 0.85;
            } else if (/belt|strap/.test(name)) {
              m.color = new THREE.Color(0x1a1208);             // dark leather
              m.roughness = 0.7;
            } else {
              // Default to wool. better than military camo for anything
              // we couldn't classify.
              m.color = new THREE.Color(0x5a4838);
              m.roughness = 0.95;
            }
            // Preserve any normal/AO map the original had. gives micro-detail
            // even though we override the colour.
            if (original) {
              if (original.normalMap)   { m.normalMap   = original.normalMap;   m.normalScale = new THREE.Vector2(0.8, 0.8); }
              if (original.aoMap)       { m.aoMap       = original.aoMap;       m.aoMapIntensity = 0.9; }
              // (skinning prop removed. see comment above)
            }
            o.material = m;
          });
          // Hide the procedural placeholder, add the real character.
          if (this.procPlayer) this.procPlayer.visible = false;
          this.player.add(model);
          this._realPlayer = model;
          // VIKING GEAR. round shield (back), single-handed axe (right
          // hip), fur cloak (shoulders). Attached to the model root so
          // they move with the running animation as a unit. Anatomically
          // not bone-locked (which would need rigid-bone lookup) but
          // close enough at the camera distance + speed of play.
          try { this._equipSoldierGear(model); }
          catch (e) { console.warn("[Valhalla] gear attach failed", e); }
          // Set up animation mixer + grab the Run clip (Soldier has
          // Idle/Walk/Run baked in). We'll switch clips dynamically
          // later (idle on menu, run while playing).
          this._mixer = new THREE.AnimationMixer(model);
          const clips = gltf.animations || [];
          const findClip = (name) => clips.find(c =>
            c.name.toLowerCase().includes(name.toLowerCase()));
          this._anims = {
            idle: findClip("Idle"),
            walk: findClip("Walk"),
            run:  findClip("Run"),
          };
          this._setPlayerAnim("run");
          console.log("[Valhalla] real player model loaded");
        } catch (e) {
          console.warn("[Valhalla] GLB swap-in failed, keeping procedural", e);
        }
      }, undefined, (err) => {
        console.warn("[Valhalla] real player model load failed (using procedural)", err);
      });
    } catch (e) {
      console.warn("[Valhalla] GLTFLoader setup failed", e);
    }
  }

  // Switch the active animation clip on the real player. Cross-fades
  // smoothly between previous and new clip so transitions don't pop.
  _setPlayerAnim(name) {
    if (!this._mixer || !this._anims) return;
    const clip = this._anims[name];
    if (!clip) return;
    const next = this._mixer.clipAction(clip);
    next.reset().setEffectiveWeight(1).play();
    if (this._activeAnim && this._activeAnim !== next) {
      this._activeAnim.crossFadeTo(next, 0.25, false);
    }
    this._activeAnim = next;
  }

  // Build and attach procedural Viking gear to the loaded Soldier
  // model. Items are parented to the model root (not bones) so they
  // ride along with the run animation as a unit. At gameplay distance
  // + speed this reads as "the Viking has gear" without needing
  // per-bone IK that Soldier.glb doesn't ship animation tracks for.
  _equipSoldierGear(model) {
    if (!model) return;
    // --- Round shield strapped to the back ----------------------------
    const shield = new THREE.Group();
    const woodMat = new THREE.MeshStandardMaterial({
      color: 0x4a2e1c, roughness: 0.95, flatShading: true,
    });
    const ironMat = new THREE.MeshStandardMaterial({
      color: 0x2a2e34, metalness: 0.7, roughness: 0.45, flatShading: true,
    });
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.08, 24), woodMat);
    disc.rotation.z = Math.PI / 2;
    shield.add(disc);
    // Iron centre boss (umbo)
    const boss = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), ironMat);
    boss.position.x = 0.05;
    shield.add(boss);
    // Iron rim band
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.035, 8, 32),
      ironMat
    );
    rim.rotation.y = Math.PI / 2;
    shield.add(rim);
    // Cross-pattern carved stripes
    for (let i = 0; i < 4; i++) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 0.85, 0.04),
        new THREE.MeshStandardMaterial({ color: 0x6c2620, roughness: 0.9, flatShading: true })
      );
      stripe.rotation.x = (Math.PI / 4) * i;
      stripe.position.x = 0.045;
      shield.add(stripe);
    }
    shield.position.set(0, 1.05, -0.18);   // on the back, ~mid-torso height
    shield.rotation.y = Math.PI;             // facing rearward
    model.add(shield);

    // --- Hand axe at the right hip ------------------------------------
    const axe = new THREE.Group();
    const haft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.028, 0.55, 8),
      new THREE.MeshStandardMaterial({ color: 0x1f1208, roughness: 0.9, flatShading: true })
    );
    haft.rotation.z = Math.PI / 2.2;       // hangs at hip-angle
    axe.add(haft);
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.22, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.85, roughness: 0.3, flatShading: true })
    );
    head.position.set(0.22, 0.07, 0);
    axe.add(head);
    // Bevel edge. slightly brighter strip
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.18, 0.061),
      new THREE.MeshStandardMaterial({ color: 0xe8edf2, metalness: 0.9, roughness: 0.15 })
    );
    edge.position.set(0.31, 0.07, 0);
    axe.add(edge);
    axe.position.set(0.28, 0.85, 0);        // right hip
    model.add(axe);

    // --- Fur cloak draped over shoulders ------------------------------
    // A trapezoid plane behind the shoulders with a furry colour. Uses
    // double-sided so it doesn't disappear when the camera angles past.
    const cloakShape = new THREE.Shape();
    cloakShape.moveTo(-0.42, 0);
    cloakShape.lineTo(0.42, 0);
    cloakShape.lineTo(0.58, -1.1);
    cloakShape.lineTo(-0.58, -1.1);
    cloakShape.lineTo(-0.42, 0);
    const cloakGeo = new THREE.ShapeGeometry(cloakShape);
    const cloak = new THREE.Mesh(
      cloakGeo,
      new THREE.MeshStandardMaterial({
        color: 0x3a2a20, roughness: 1.0, flatShading: false,
        side: THREE.DoubleSide,
      })
    );
    cloak.position.set(0, 1.55, -0.18);
    cloak.rotation.x = -0.12;               // hangs slightly back
    model.add(cloak);
    // Fur collar. short white-grey roll across shoulders
    const collar = new THREE.Mesh(
      new THREE.TorusGeometry(0.32, 0.07, 8, 16, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0xb8a89a, roughness: 1.0, flatShading: true })
    );
    collar.position.set(0, 1.55, -0.04);
    collar.rotation.x = Math.PI / 2;
    collar.rotation.z = Math.PI;
    model.add(collar);
  }

  // ANIMATE longships: slow forward drift along the fjord so the
  // distant water doesn't feel static. Each ship has its own speed and
  // wraps around to the back of the playable range when it sails past.
  _updateLongships(dt) {
    if (!this.scenery) return;
    for (const s of this.scenery) {
      if (!s.isLongship) continue;
      s.mesh.position.z -= (s.sailSpeed || 0.6) * dt;
      // Wrap to behind the player when sailed past visible range.
      if (s.mesh.position.z < this.distance - 80) {
        s.mesh.position.z = this.distance + 300;
      }
      // Hull bob + sail ripple.
      s.mesh.position.y = s.baseY + Math.sin(performance.now() * 0.0011 + s.phase) * 0.18;
      s.mesh.rotation.z = Math.sin(performance.now() * 0.0008 + s.phase) * 0.05;
    }
  }

  // RUNESTONES. heavy carved granite monoliths flanking the road at
  // intervals. Built once at world init; the chunked terrain handles
  // their wraparound by relative-z scrolling.
  _buildRunestones() {
    if (!this.runestones) this.runestones = new THREE.Group();
    // REAL PBR STONE. Polyhaven aerial_rocks_02 tinted toward weathered
    // granite. Adds genuine surface detail (cracks, lichen, micro-
    // shading) to what were previously flat-colour boxes.
    const stoneMat = this._pbrMaterial("stone", {
      color: new THREE.Color(0x6a6660), repeat: 1.4, normalScale: 1.3,
    });
    const carvedMat = new THREE.MeshStandardMaterial({
      color: 0x1a1814, emissive: 0x806340, emissiveIntensity: 0.5,
      roughness: 0.9, flatShading: true,
    });
    // 8 stones (was 16), alternating sides, every ~140m with subtle
    // randomness. Density halved for perf + less roadside spam.
    for (let i = 0; i < 8; i++) {
      const stone = new THREE.Group();
      const h = 2.6 + Math.random() * 1.4;
      const w = 0.7 + Math.random() * 0.3;
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, 0.5),
        stoneMat
      );
      body.position.y = h / 2;
      stone.add(body);
      // Top notch. chipped corner so it doesn't look mass-produced.
      const notch = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.5, 0.3, 0.5),
        stoneMat
      );
      notch.position.set(w * 0.2, h - 0.05, 0);
      stone.add(notch);
      // Carved rune. small emissive vertical stroke
      const rune = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.1, h * 0.5, 0.05),
        carvedMat
      );
      rune.position.set(0, h * 0.55, 0.27);
      stone.add(rune);
      // Cross-stroke for variety on alternate stones
      if (i % 2 === 0) {
        const cross = new THREE.Mesh(
          new THREE.BoxGeometry(w * 0.3, h * 0.06, 0.05),
          carvedMat
        );
        cross.position.set(0, h * 0.65, 0.27);
        stone.add(cross);
      }
      const side = i % 2 === 0 ? -1 : 1;
      stone.position.set(side * (7.5 + Math.random() * 1.5), 0, i * 140);
      stone.rotation.y = (Math.random() - 0.5) * 0.3;
      this.runestones.add(stone);
    }
    this.scene.add(this.runestones);
  }

  // Recycle runestones behind the camera back to ahead, so they appear
  // to extend infinitely down the road.
  _updateRunestones() {
    if (!this.runestones) return;
    for (const stone of this.runestones.children) {
      if (stone.position.z < this.distance - 30) {
        stone.position.z += 8 * 140;        // jump 8 slots ahead
      }
    }
  }

  // FIRE PITS. glowing fire stacks at intervals along the roadside.
  // Each pit has a stone ring, a flame cone (additive), and a soft
  // point-light glow. Recycled like runestones for endless scroll.
  _buildFirePits() {
    if (!this.firePits) this.firePits = new THREE.Group();
    // PBR stone for the fire ring (looks like real soot-blackened rock)
    const stoneRingMat = this._pbrMaterial("stone", {
      color: new THREE.Color(0x2a2620), repeat: 0.8, normalScale: 1.2,
    });
    const flameInnerMat = new THREE.MeshBasicMaterial({
      color: 0xffb050, transparent: true, opacity: 0.9, depthWrite: false,
    });
    const flameOuterMat = new THREE.MeshBasicMaterial({
      color: 0xff6020, transparent: true, opacity: 0.5, depthWrite: false,
    });
    // 8 pits, alternating sides, every ~140m, offset from runestones.
    // 4 pits not 8. WebGL caps useful dynamic lights at ~4; we use NONE
    // here. emissive materials read as fire without the per-pixel
    // shader cost. Flame meshes are additive sprites that sell the
    // warmth visually without ever touching the lighting pipeline.
    for (let i = 0; i < 4; i++) {
      const pit = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.6, 0.18, 6, 12),
        stoneRingMat
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.18;
      pit.add(ring);
      // Inner bright flame (emissive. no light needed)
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.35, 1.2, 8, 1, true),
        flameInnerMat
      );
      flame.position.y = 0.8;
      pit.add(flame);
      // Outer halo
      const halo = new THREE.Mesh(
        new THREE.ConeGeometry(0.65, 1.7, 8, 1, true),
        flameOuterMat
      );
      halo.position.y = 0.9;
      pit.add(halo);
      pit.userData = { flame, halo, phase: Math.random() * Math.PI * 2 };
      const side = i % 2 === 0 ? 1 : -1;
      // Wider spacing (280m) since there are fewer of them.
      pit.position.set(side * (9 + Math.random() * 1), 0, 120 + i * 280);
      this.firePits.add(pit);
    }
    this.scene.add(this.firePits);
  }

  _updateFirePits(dt) {
    if (!this.firePits) return;
    const t = performance.now() * 0.001;
    for (const pit of this.firePits.children) {
      const u = pit.userData;
      if (!u) continue;
      if (pit.position.z < this.distance - 30) {
        pit.position.z += 4 * 280;
      }
      // Flicker via scale only. no light to update.
      const flick = 0.85 + Math.sin(t * 8 + u.phase) * 0.12;
      u.flame.scale.set(flick, 0.9 + Math.sin(t * 6 + u.phase) * 0.15, flick);
      u.halo.scale.set(flick * 1.1, 0.95 + Math.cos(t * 4 + u.phase) * 0.15, flick * 1.1);
    }
  }

  // PINE FOREST. 12 conifers lining the far meadow on both sides.
  // Each is a stacked-cone silhouette (3 cones, dark green) on a PBR
  // wood-textured trunk. Cheap geometry, lots of presence. the
  // single biggest "this is a real Nordic forest" cue.
  _buildPineForest() {
    if (!this.pines) this.pines = new THREE.Group();
    const trunkMat = this._pbrMaterial("wood", {
      color: new THREE.Color(0x4a3220), repeat: 0.6, normalScale: 1.2,
    });
    // Deep evergreen with subtle variation per tree (set after clone).
    const baseNeedleMat = new THREE.MeshStandardMaterial({
      color: 0x1c3a1e, roughness: 0.85, metalness: 0.0,
      flatShading: true, envMapIntensity: 0.5,
    });
    for (let i = 0; i < 12; i++) {
      const tree = new THREE.Group();
      const h = 5.5 + Math.random() * 2.5;       // 5.5–8m tall
      // Trunk
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.28, h * 0.45, 7),
        trunkMat
      );
      trunk.position.y = h * 0.225;
      tree.add(trunk);
      // Three stacked cones of decreasing radius. classic pine shape.
      const needleMat = baseNeedleMat.clone();
      // Slight per-tree colour variation so the forest doesn't look mass-produced.
      needleMat.color.offsetHSL(
        (Math.random() - 0.5) * 0.04,
        (Math.random() - 0.5) * 0.1,
        (Math.random() - 0.5) * 0.05
      );
      for (let k = 0; k < 3; k++) {
        const r = 1.6 - k * 0.45;
        const conh = h * 0.36;
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(r, conh, 8),
          needleMat
        );
        cone.position.y = h * 0.45 + k * conh * 0.6;
        tree.add(cone);
      }
      // SNOW CAP. single small white cone on the top crown so every
      // pine has the wind-driven snow accumulation classic of every
      // Nordic forest reference shot. Cheap (one mesh per tree) and
      // dramatically lifts the realism.
      const snowMat = new THREE.MeshStandardMaterial({
        color: 0xf0f4f8, roughness: 0.9, metalness: 0.0,
        flatShading: true, envMapIntensity: 0.4,
      });
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.7, 0.9, 8), snowMat);
      cap.position.y = h * 0.45 + 3 * (h * 0.36) * 0.6 - 0.1;
      tree.add(cap);
      // Far side of the road, well past the runestone strip so they
      // read as distant forest not roadside obstacle.
      const side = i % 2 === 0 ? -1 : 1;
      tree.position.set(
        side * (15 + Math.random() * 8),
        0,
        i * 80 + (Math.random() - 0.5) * 30
      );
      tree.rotation.y = Math.random() * Math.PI * 2;
      this.pines.add(tree);
    }
    this.scene.add(this.pines);
  }

  _updatePineForest() {
    if (!this.pines) return;
    for (const tree of this.pines.children) {
      if (tree.position.z < this.distance - 40) {
        tree.position.z += 12 * 80;
      }
    }
  }

  // HUGINN & MUNINN. Odin's two ravens, always circling above the
  // player. Replaces the older 5-wing scenery with two named birds
  // each made of body + 2 wings + tail. They orbit at different
  // radii and heights so they read as distinct individuals.
  _buildOdinsRavens() {
    // Remove old generic ravens scenery if it exists.
    if (this.ravens) {
      this.scene.remove(this.ravens);
      this.ravens = null;
    }
    this.odinRavens = new THREE.Group();
    // Procedural placeholder shells. these stay visible immediately
    // while the real Stork.glb loads async. The same orbit code in
    // _updateOdinsRavens drives both.
    const bodyMatHuginn = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a, roughness: 0.7, metalness: 0.1, flatShading: true,
    });
    const bodyMatMuninn = new THREE.MeshStandardMaterial({
      color: 0x18141a, roughness: 0.75, metalness: 0.1, flatShading: true,
    });
    const beakMat = new THREE.MeshStandardMaterial({
      color: 0x60564a, roughness: 0.6, metalness: 0.2, flatShading: true,
    });
    const mkRaven = (mat, opts) => {
      const grp = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), mat);
      body.scale.set(1, 0.6, 1.5);
      grp.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), mat);
      head.position.set(0, 0.05, 0.42);
      grp.add(head);
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 4), beakMat);
      beak.rotation.x = Math.PI / 2;
      beak.position.set(0, 0.04, 0.6);
      grp.add(beak);
      const wingL = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.22), mat);
      wingL.position.set(-0.5, 0, 0);
      grp.add(wingL);
      const wingR = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.22), mat);
      wingR.position.set(0.5, 0, 0);
      grp.add(wingR);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.35), mat);
      tail.position.set(0, 0, -0.4);
      grp.add(tail);
      grp.userData = { wingL, wingR, isProc: true, ...opts };
      return grp;
    };
    this._huginn = mkRaven(bodyMatHuginn, {
      name: "Huginn", radius: 8, height: 9, speed: 0.7, phase: 0,
    });
    this.odinRavens.add(this._huginn);
    this._muninn = mkRaven(bodyMatMuninn, {
      name: "Muninn", radius: 13, height: 12, speed: 0.45, phase: Math.PI,
    });
    this.odinRavens.add(this._muninn);
    this.scene.add(this.odinRavens);
    // Kick off async upgrade to real Stork.glb model with flapping anim.
    this._loadRealRavens();
  }

  // Load real animated Stork.glb (threejs CDN) and use two clones as
  // Huginn + Muninn. Stork has a fly animation baked in. perfect for
  // the orbit. Tinted dark for raven plumage. If load fails we keep
  // the procedural shells, no breakage.
  _loadRealRavens() {
    try {
      const loader = new GLTFLoader();
      loader.load(
        "https://threejs.org/examples/models/gltf/Stork.glb",
        (gltf) => {
          try {
            const mkReal = (existingShell, tint) => {
              // SkeletonUtils.clone would be best for rigged models,
              // but Stork.glb's animation is morph/keyframe so a deep
              // scene clone is fine and avoids the import.
              const model = gltf.scene.clone(true);
              model.scale.setScalar(0.18);    // Stork is huge by default
              // Override material to dark raven-feather. Traverse all meshes.
              model.traverse((o) => {
                if (!o.isMesh) return;
                o.castShadow = false; o.receiveShadow = false;
                o.frustumCulled = false;
                o.material = new THREE.MeshStandardMaterial({
                  color: tint,
                  roughness: 0.75,
                  metalness: 0.08,
                  envMapIntensity: 0.6,
                });
              });
              // Each raven gets its own animation mixer playing the
              // flap clip at its own speed.
              const mixer = new THREE.AnimationMixer(model);
              const clip = gltf.animations[0];
              if (clip) {
                const action = mixer.clipAction(clip);
                action.play();
              }
              return { model, mixer };
            };
            const huginnReal = mkReal(this._huginn, 0x0a0a0a);
            const muninnReal = mkReal(this._muninn, 0x1a1418);
            // Swap procedurals OUT and reals IN at the same orbit slot.
            this._huginn.clear();    // drop the placeholder boxes
            this._muninn.clear();
            this._huginn.add(huginnReal.model);
            this._muninn.add(muninnReal.model);
            // Stash mixers on userData so _updateOdinsRavens can tick them.
            this._huginn.userData.mixer = huginnReal.mixer;
            this._muninn.userData.mixer = muninnReal.mixer;
            this._huginn.userData.isProc = false;
            this._muninn.userData.isProc = false;
            console.log("[Valhalla] real Stork ravens loaded");
          } catch (e) {
            console.warn("[Valhalla] raven swap-in failed", e);
          }
        },
        undefined,
        (err) => console.warn("[Valhalla] Stork.glb load failed. keeping procedural ravens", err)
      );
    } catch (e) {
      console.warn("[Valhalla] raven loader setup failed", e);
    }
  }

  _updateOdinsRavens(dt) {
    if (!this.odinRavens || !this._huginn || !this._muninn) return;
    const tt = performance.now() * 0.001;
    this.odinRavens.position.set(
      this.player ? this.player.position.x : 0,
      0,
      this.distance
    );
    for (const raven of [this._huginn, this._muninn]) {
      const u = raven.userData;
      const ang = u.phase + tt * u.speed;
      raven.position.set(
        Math.cos(ang) * u.radius,
        u.height,
        Math.sin(ang) * u.radius
      );
      // Face direction of motion. Stork model is oriented +X by default,
      // we want it heading along the tangent (orbit direction).
      raven.rotation.y = -ang + Math.PI / 2;
      if (u.isProc) {
        // Procedural placeholder: flap via wing rotation.
        const flap = Math.sin(tt * 8 + u.phase * 2) * 0.5;
        u.wingL.rotation.z = -flap;
        u.wingR.rotation.z = flap;
      } else if (u.mixer) {
        // Real Stork: drive its baked fly animation. Scale playback
        // speed by orbit speed so faster Huginn flaps faster.
        u.mixer.update(dt * (u.speed > 0.5 ? 1.4 : 1.0));
      }
    }
  }

  // Load real animated Horse.glb (threejs CDN) and scatter 3 horses
  // in the distant meadows. Vikings rode horses. this single addition
  // sells "real Viking world" more than any procedural box ever will.
  _loadRealHorses() {
    try {
      const loader = new GLTFLoader();
      loader.load(
        "https://threejs.org/examples/models/gltf/Horse.glb",
        (gltf) => {
          try {
            this._horses = [];
            const clip = gltf.animations[0];
            for (let i = 0; i < 3; i++) {
              const horse = gltf.scene.clone(true);
              horse.scale.setScalar(0.015);    // Horse.glb is big
              // Material override: weathered brown/grey coat
              const coats = [0x4a3220, 0x2a1c14, 0x6a5040];
              horse.traverse((o) => {
                if (!o.isMesh) return;
                o.castShadow = true;
                o.receiveShadow = false;
                o.frustumCulled = false;
                o.material = new THREE.MeshStandardMaterial({
                  color: coats[i % coats.length],
                  roughness: 0.85,
                  metalness: 0.0,
                  envMapIntensity: 0.7,
                });
              });
              // Position: far meadow on alternating sides, spread out.
              const side = i % 2 === 0 ? -1 : 1;
              horse.position.set(side * (22 + Math.random() * 8), 0, 60 + i * 90);
              horse.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
              // Each horse has its own mixer playing the gallop loop.
              const mixer = new THREE.AnimationMixer(horse);
              if (clip) mixer.clipAction(clip).play();
              this.scene.add(horse);
              this._horses.push({
                mesh: horse, mixer,
                sideZ: 80,           // spacing for recycle wrap
                speed: 4 + Math.random() * 2,    // m/s along the road
              });
            }
            console.log("[Valhalla] real horses loaded");
          } catch (e) {
            console.warn("[Valhalla] horse setup failed", e);
          }
        },
        undefined,
        (err) => console.warn("[Valhalla] Horse.glb load failed", err)
      );
    } catch (e) {
      console.warn("[Valhalla] horse loader setup failed", e);
    }
  }

  // Per-frame horse update. animate gallop + recycle behind→ahead so
  // the meadows always have life moving through them.
  _updateRealHorses(dt) {
    if (!this._horses) return;
    for (const h of this._horses) {
      if (h.mixer) h.mixer.update(dt);
      // Horses canter forward at their own speed (relative to ground).
      h.mesh.position.z += h.speed * dt;
      // Wrap when they pass beyond visible range.
      if (h.mesh.position.z - this.distance > 220) {
        h.mesh.position.z = this.distance - 80;
      }
    }
  }

  // BATTLE HELMS. load DamagedHelmet (Khronos glTF reference asset)
  // and scatter 4 around the meadow as battlefield mementos. The
  // model is THE PBR reference asset. every metalness/roughness
  // pixel was authored; reads as authentic battered metal under our
  // HDRI environment. Same async/fallback pattern as Horse/Stork.
  _loadBattleHelms() {
    try {
      const loader = new GLTFLoader();
      // Try the threejs CDN copy first (proven to work for other GLBs).
      // The Khronos sample-models repo also serves a copy via jsdelivr
      // as a fallback, but jsdelivr's not guaranteed for that repo.
      const urls = [
        "https://threejs.org/examples/models/gltf/DamagedHelmet/glTF/DamagedHelmet.gltf",
        "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models@master/2.0/DamagedHelmet/glTF-Binary/DamagedHelmet.glb",
      ];
      const tryUrl = (i) => {
        if (i >= urls.length) {
          console.warn("[Valhalla] no battle helm CDN reachable");
          return;
        }
        loader.load(urls[i], (gltf) => {
          try {
            this._battleHelms = [];
            for (let k = 0; k < 4; k++) {
              const helm = gltf.scene.clone(true);
              helm.scale.setScalar(0.55);
              helm.traverse((o) => {
                if (!o.isMesh) return;
                o.castShadow = true;
                o.receiveShadow = false;
                o.frustumCulled = false;
              });
              const side = k % 2 === 0 ? -1 : 1;
              helm.position.set(
                side * (10 + Math.random() * 5),
                0.45,
                100 + k * 220
              );
              helm.rotation.y = Math.random() * Math.PI * 2;
              helm.rotation.z = (Math.random() - 0.5) * 0.4;     // toppled angle
              this.scene.add(helm);
              this._battleHelms.push({ mesh: helm });
            }
            console.log(`[Valhalla] battle helms loaded from ${urls[i]}`);
          } catch (e) {
            console.warn("[Valhalla] helm setup failed", e);
          }
        }, undefined, () => tryUrl(i + 1));
      };
      tryUrl(0);
    } catch (e) {
      console.warn("[Valhalla] helm loader setup failed", e);
    }
  }

  // Recycle battle helms behind→ahead like other scenery.
  _updateBattleHelms() {
    if (!this._battleHelms) return;
    for (const h of this._battleHelms) {
      if (h.mesh.position.z - this.distance < -30) {
        h.mesh.position.z += 4 * 220;
      }
    }
  }

  // CC0 VIKING-ERA PROPS. real authored GLB models from the
  // Polygonal Mind medieval-fair pack, served via jsdelivr CDN with
  // proper CORS (verified). This is the actual leap from procedural
  // boxes to authored 3D scenery.
  //
  // Loaded:
  //   * Tabern.glb      . Viking longhouse silhouette in the meadow
  //   * Barrel.glb      . mead barrels clustered around fire pits
  //   * Cart.glb        . abandoned wooden cart on the path
  //   * Lamp.glb        . torch posts lining the road
  //   * SignPost.glb    . wooden waymarkers
  //
  // Each loader is independent so partial failures don't take down
  // the whole set. Configurable count + placement strategy per type.
  _loadVikingProps() {
    const loader = new GLTFLoader();
    const cdnBase = "https://cdn.jsdelivr.net/gh/ToxSam/cc0-models-Polygonal-Mind@main/projects/medieval-fair/";
    this._vikingProps = { tabern: [], barrel: [], cart: [], lamp: [], signpost: [] };

    // Tabern. 3 Viking longhouses far in the meadow background.
    loader.load(cdnBase + "Tabern.glb", (gltf) => {
      try {
        for (let i = 0; i < 3; i++) {
          const t = gltf.scene.clone(true);
          t.scale.setScalar(2.8);
          t.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = false;     // far background. no shadow cost
            o.receiveShadow = true;
            o.frustumCulled = false;
          });
          const side = i % 2 === 0 ? -1 : 1;
          t.position.set(side * (30 + Math.random() * 6), 0, 180 + i * 380);
          t.rotation.y = Math.random() * Math.PI * 2;
          this.scene.add(t);
          this._vikingProps.tabern.push(t);
        }
        console.log("[Valhalla] Tabern loaded (Viking longhouses)");
      } catch (e) { console.warn("[Valhalla] Tabern setup failed", e); }
    }, undefined, (err) => console.warn("[Valhalla] Tabern.glb failed", err));

    // Barrels. clusters of 2-3 near each fire pit-ish location.
    loader.load(cdnBase + "Barrel.glb", (gltf) => {
      try {
        for (let i = 0; i < 10; i++) {
          const b = gltf.scene.clone(true);
          b.scale.setScalar(1.1);
          b.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = true;
            o.receiveShadow = false;
            o.frustumCulled = false;
          });
          const side = i % 2 === 0 ? -1 : 1;
          b.position.set(side * (8 + Math.random() * 4), 0, 80 + i * 95 + (Math.random() - 0.5) * 30);
          b.rotation.y = Math.random() * Math.PI * 2;
          this.scene.add(b);
          this._vikingProps.barrel.push(b);
        }
        console.log("[Valhalla] Barrels loaded");
      } catch (e) { console.warn("[Valhalla] Barrel setup failed", e); }
    }, undefined, (err) => console.warn("[Valhalla] Barrel.glb failed", err));

    // Carts. 2 abandoned wooden carts at roadside intervals.
    loader.load(cdnBase + "Cart.glb", (gltf) => {
      try {
        for (let i = 0; i < 2; i++) {
          const c = gltf.scene.clone(true);
          c.scale.setScalar(1.3);
          c.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = true;
            o.receiveShadow = false;
            o.frustumCulled = false;
          });
          const side = i % 2 === 0 ? -1 : 1;
          c.position.set(side * (10 + Math.random() * 3), 0, 150 + i * 460);
          c.rotation.y = (Math.random() - 0.5) * Math.PI;
          this.scene.add(c);
          this._vikingProps.cart.push(c);
        }
        console.log("[Valhalla] Carts loaded");
      } catch (e) { console.warn("[Valhalla] Cart setup failed", e); }
    }, undefined, (err) => console.warn("[Valhalla] Cart.glb failed", err));

    // Lamps. torch posts dense along the road, 6 of them.
    loader.load(cdnBase + "Lamp.glb", (gltf) => {
      try {
        for (let i = 0; i < 6; i++) {
          const l = gltf.scene.clone(true);
          l.scale.setScalar(1.5);
          l.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = true;
            o.receiveShadow = false;
            o.frustumCulled = false;
          });
          const side = i % 2 === 0 ? -1 : 1;
          l.position.set(side * 7.2, 0, 60 + i * 140);
          this.scene.add(l);
          this._vikingProps.lamp.push(l);
        }
        console.log("[Valhalla] Lamps loaded");
      } catch (e) { console.warn("[Valhalla] Lamp setup failed", e); }
    }, undefined, (err) => console.warn("[Valhalla] Lamp.glb failed", err));

    // SignPosts. 4 waymarkers between major realm transitions.
    loader.load(cdnBase + "SignPost.glb", (gltf) => {
      try {
        for (let i = 0; i < 4; i++) {
          const s = gltf.scene.clone(true);
          s.scale.setScalar(1.3);
          s.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = true;
            o.receiveShadow = false;
            o.frustumCulled = false;
          });
          const side = i % 2 === 0 ? 1 : -1;     // opposite side from lamps
          s.position.set(side * 9, 0, 110 + i * 230);
          s.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
          this.scene.add(s);
          this._vikingProps.signpost.push(s);
        }
        console.log("[Valhalla] SignPosts loaded");
      } catch (e) { console.warn("[Valhalla] SignPost setup failed", e); }
    }, undefined, (err) => console.warn("[Valhalla] SignPost.glb failed", err));
  }

  // VIKING NPC WARRIORS. clone Soldier.glb for 4 NPCs standing at
  // longhouse positions with varied material tints. Each gets the
  // idle animation from the model. Brings the longhouse area to life.
  _loadVikingNPCs() {
    try {
      const loader = new GLTFLoader();
      loader.load("https://threejs.org/examples/models/gltf/Soldier.glb", (gltf) => {
        try {
          this._vikingNPCs = [];
          // Find the idle animation (Soldier.glb has Idle/Walk/Run)
          const idleClip = gltf.animations.find(c => /idle/i.test(c.name)) || gltf.animations[0];
          // 4 NPCs with different coats. clan colours
          const variants = [
            { coat: 0x3a2818, fur: 0x6a5040, name: "Bjorn" },     // dark brown leather + tan fur
            { coat: 0x2a1818, fur: 0x4a3030, name: "Eirik" },     // wine-leather + ruddy fur
            { coat: 0x1a2a3a, fur: 0x5a6a7a, name: "Sigrun" },    // sea-blue leather + grey fur
            { coat: 0x2a2a2a, fur: 0x5a5050, name: "Olaf" },      // black leather + smoke fur
          ];
          for (let i = 0; i < variants.length; i++) {
            const v = variants[i];
            const npc = gltf.scene.clone(true);
            npc.scale.setScalar(1.2);
            // Tint the materials per variant
            npc.traverse((o) => {
              if (!o.isMesh) return;
              o.castShadow = true;
              o.receiveShadow = false;
              o.frustumCulled = false;
              if (o.material) {
                o.material = new THREE.MeshStandardMaterial({
                  color: i % 2 === 0 ? v.coat : v.fur,
                  roughness: 0.82, metalness: 0.0,
                  envMapIntensity: 0.6,
                });
              }
            });
            // Position near each longhouse (taberns are at ~180 + i*380).
            const side = i % 2 === 0 ? -1 : 1;
            npc.position.set(
              side * (22 + Math.random() * 5),
              0,
              200 + i * 380 + (Math.random() - 0.5) * 30
            );
            npc.rotation.y = Math.random() * Math.PI * 2;
            // Idle animation, randomised offset so they don't all
            // breathe in unison.
            const mixer = new THREE.AnimationMixer(npc);
            if (idleClip) {
              const action = mixer.clipAction(idleClip);
              action.time = Math.random() * idleClip.duration;
              action.play();
            }
            this.scene.add(npc);
            this._vikingNPCs.push({ mesh: npc, mixer });
          }
          console.log("[Valhalla] Viking NPCs loaded (4 warriors)");
        } catch (e) { console.warn("[Valhalla] NPC setup failed", e); }
      }, undefined, (err) => console.warn("[Valhalla] NPC Soldier.glb failed", err));
    } catch (e) { console.warn("[Valhalla] NPC loader setup failed", e); }
  }

  _updateVikingNPCs(dt) {
    if (!this._vikingNPCs) return;
    for (const n of this._vikingNPCs) {
      if (n.mixer) n.mixer.update(dt);
      // Recycle behind→ahead so the world is always populated.
      if (n.mesh.position.z - this.distance < -30) {
        n.mesh.position.z += 4 * 380;
      }
    }
  }

  // Recycle Viking props behind→ahead per type-specific spacing.
  _updateVikingProps() {
    if (!this._vikingProps) return;
    const wrap = (arr, span) => {
      for (const m of arr) {
        if (m.position.z - this.distance < -30) m.position.z += arr.length * span;
      }
    };
    wrap(this._vikingProps.tabern,   380);
    wrap(this._vikingProps.barrel,    95);
    wrap(this._vikingProps.cart,     460);
    wrap(this._vikingProps.lamp,     140);
    wrap(this._vikingProps.signpost, 230);
  }

  _buildSnow() {
    // Two layers of snow particles:
    // 1. CLOSE flakes - small count, big, very visible, RIGHT in front of
    //    the camera. This is what sells "weather". Without these the world
    //    feels static.
    // 2. FAR flakes - many small, drifting in middle distance for depth.

    // Snow particles use a REAL snowflake sprite texture from threejs's
    // CDN. The procedural square-pixel look the user kept complaining
    // about is replaced with a soft circular flake silhouette.
    const flakeURL = "https://threejs.org/examples/textures/sprites/snowflake1.png";
    const flakeTex = new THREE.TextureLoader().load(flakeURL,
      undefined, undefined,
      (err) => console.warn("[Valhalla] snowflake sprite failed (keeping square dots)", err)
    );

    // Close snow. orig 350 → repeatedly halved → now 20. Floor.
    {
      const count = 10;     // halved from 20. atmosphere not snowstorm
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 36;
        positions[i * 3 + 1] = Math.random() * 14;
        positions[i * 3 + 2] = (Math.random() - 0.4) * 30; // slightly biased ahead
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xfafcff, size: 0.55, transparent: true, opacity: 0.92,
        depthWrite: false, fog: true, sizeAttenuation: true,
        map: flakeTex,        // real snowflake sprite (loaded above)
        alphaTest: 0.01,
      });
      this.snowClose = new THREE.Points(geo, mat);
      this.scene.add(this.snowClose);
    }

    // Far layer orig 1800 → now 120. Floor.
    {
      const count = 60;     // halved from 120. atmosphere not snowstorm
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 140;
        positions[i * 3 + 1] = Math.random() * 60;
        positions[i * 3 + 2] = Math.random() * VIEW_DEPTH;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xffffff, size: 0.28, transparent: true, opacity: 0.7,
        depthWrite: false, fog: true,
        map: flakeTex,
        alphaTest: 0.01,
      });
      this.snow = new THREE.Points(geo, mat);
      this.scene.add(this.snow);
    }
  }

  _buildScenery() {
    // LONGSHIP FLEET. 3 ships (was 6) drifting down the fjord. Halved
    // for perf + visual breathing room: 60 meshes was crowding both the
    // GPU and the eye. Each gets its own sail speed so they don't move
    // in lockstep.
    // Pre-build PBR materials shared across all 3 ships (same texture
    // sample, different tints). Far cheaper than 3× the GPU memory.
    const hullPbr = this._pbrMaterial("wood", {
      color: new THREE.Color(0x6a3a1c), repeat: 2.5, normalScale: 1.0,
    });
    const keelPbr = this._pbrMaterial("wood", {
      color: new THREE.Color(0x3a200f), repeat: 2.0, normalScale: 1.2,
    });
    for (let i = 0; i < 3; i++) {
      const ship = new THREE.Group();
      // Tapered hull. curved bow + stern via cylinder + box hybrid.
      const hull = new THREE.Mesh(new THREE.BoxGeometry(9, 1.5, 2.8), hullPbr);
      ship.add(hull);
      const keel = new THREE.Mesh(new THREE.BoxGeometry(7, 0.6, 2.4), keelPbr);
      keel.position.y = -0.85;
      ship.add(keel);
      // Dragon-head prow. small triangular wedge at front
      const prow = new THREE.Mesh(
        new THREE.ConeGeometry(0.55, 1.2, 4),
        new THREE.MeshStandardMaterial({ color: 0x4a2e1a, roughness: 0.85, flatShading: true })
      );
      prow.rotation.z = -Math.PI / 2;
      prow.position.set(4.7, 0.4, 0);
      ship.add(prow);
      // Stern post. vertical curved board
      const stern = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 1.8, 0.6),
        new THREE.MeshStandardMaterial({ color: 0x4a2e1a, roughness: 0.85, flatShading: true })
      );
      stern.position.set(-4.6, 0.9, 0);
      ship.add(stern);
      // Mast
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 5.5, 6),
        new THREE.MeshStandardMaterial({ color: 0x2a1a10 })
      );
      mast.position.y = 2.6;
      ship.add(mast);
      // Sail. square with horizontal red stripe (classic Norse pattern)
      const sailColours = [0xd8d4c8, 0xe2dcd0, 0xc8c0b0];
      const sail = new THREE.Mesh(
        new THREE.PlaneGeometry(5.0, 3.6),
        new THREE.MeshStandardMaterial({
          color: sailColours[i % sailColours.length],
          roughness: 0.95, side: THREE.DoubleSide,
        })
      );
      sail.position.y = 2.8;
      sail.rotation.y = Math.PI / 2;
      ship.add(sail);
      // Red stripe on sail
      const stripe = new THREE.Mesh(
        new THREE.PlaneGeometry(5.0, 0.7),
        new THREE.MeshStandardMaterial({ color: 0x9c2a26, side: THREE.DoubleSide })
      );
      stripe.position.set(0, 2.8 + (Math.random() - 0.5) * 0.8, 0);
      stripe.rotation.y = Math.PI / 2;
      ship.add(stripe);
      // Shield rack along the side. six small disks
      for (let k = 0; k < 6; k++) {
        const shield = new THREE.Mesh(
          new THREE.CylinderGeometry(0.35, 0.35, 0.04, 12),
          new THREE.MeshStandardMaterial({
            color: [0xa83020, 0x2a4878, 0xa07028, 0xa83020][k % 4],
            roughness: 0.85, flatShading: true,
          })
        );
        shield.rotation.x = Math.PI / 2;
        shield.position.set(-2.2 + k * 0.9, 0.4, 1.45);
        ship.add(shield);
      }
      const side = i % 2 === 0 ? -1 : 1;
      ship.position.set(side * (50 + Math.random() * 12), -1.2, 40 + i * 80);
      ship.rotation.y = side * Math.PI / 2 + (Math.random() - 0.5) * 0.15;
      this.scene.add(ship);
      this.scenery.push({
        mesh: ship, baseY: -1.2, phase: Math.random() * Math.PI * 2,
        isLongship: true,
        sailSpeed: 0.4 + Math.random() * 0.6,    // each ship its own pace
      });
    }

    // PINE FOREST. scattered pines lining the far meadow. The Nordic
    // world without pines is wrong (every Northman/Vikings reference
    // shot has them silhouetted against the fjord). Pre-built once,
    // recycled by per-frame z-wrap.
    this._buildPineForest();
    // RUNESTONES along the roadside (Task #15)
    this._buildRunestones();
    // FIRE PITS along the roadside (Task #16)
    this._buildFirePits();
    // HUGINN + MUNINN. Odin's ravens circling the player (Task #17)
    this._buildOdinsRavens();
    // REAL HORSES. async load 3 animated Horse.glb instances and
    // scatter them in the distant meadows. Vikings rode horses; this
    // is the single biggest "real Viking world" cue.
    this._loadRealHorses();
    // BATTLE HELMS. DamagedHelmet.glb scattered on the road as a
    // memento mori (fallen warrior left their helmet behind). Real
    // high-quality PBR model with worn metal + leather straps + dents
    //. reads as authentic Viking-age helm and shows off the HDRI
    // environment lighting / reflections.
    this._loadBattleHelms();
    // CC0 VIKING-ERA PROPS. verified via jsdelivr CDN with proper
    // CORS (ToxSam/cc0-models-Polygonal-Mind medieval-fair pack).
    // Real authored GLB models replace key procedural scenery:
    //   * Tabern.glb    . full Viking longhouse silhouette
    //   * Barrel.glb    . mead barrels around fire pits
    //   * Cart.glb      . abandoned wooden cart on the road
    //   * Lamp.glb      . wooden torch posts lining the path
    //   * SignPost.glb  . wooden waymarkers
    this._loadVikingProps();
    // VIKING NPC WARRIORS. cloned Soldier.glb (already-loaded model)
    // with varied material tints standing around the longhouses. Real
    // animated Viking NPCs populating the world; uses the model we
    // know works (the player), so no extra CDN risk.
    this._loadVikingNPCs();

    // SHADOW PASS. ONLY enable receiveShadow on scenery. Casting is
    // the expensive operation (re-renders the scene from sun POV).
    // The procedural Player + Soldier + in-game obstacles cast (set
    // elsewhere); scenery only receives. This drops the shadow caster
    // list from ~180 to ~30. the main cause of the user's reported
    // lag after enabling shadows last commit.
    const recvOn = (root) => {
      if (!root) return;
      root.traverse((o) => {
        if (!o.isMesh) return;
        const isAdditive = o.material && (o.material.transparent && !o.material.depthWrite);
        if (isAdditive) return;
        o.castShadow = false;
        o.receiveShadow = true;
      });
    };
    for (const s of this.scenery) recvOn(s.mesh);
    recvOn(this.runestones);
    recvOn(this.firePits);
    recvOn(this.pines);
  }

  _buildHUD() {
    this.hud = {
      score: $("hScore"), dist: $("hDist"), lives: $("hLives"),
      mult: $("hMult"),
      flash: $("flash"), glory: $("glory"), vignette: $("vignette"),
      bioRow: $("bioRow"),
      bpmChip: $("bpmChip"), bpmTxt: $("bpmTxt"),
      stateChip: $("stateChip"), stateTxt: $("stateTxt"),
      combo: $("combo"), comboN: $("comboN"),
      pauseOverlay: $("pauseOverlay"),
      touch: $("touch"),
    };
  }

  _updateMultiplier(state) {
    const mults = { flow: 2.0, berserker: 1.5, focused: 1.4 };
    const m = mults[state];
    if (m && this.running) {
      this.hud.mult.textContent = `${m}×`;
      this.hud.mult.className = "mult on " + state;
    } else {
      this.hud.mult.className = "mult";
    }
    // Bio aura colour + intensity per state. Targets are eased toward in
    // _updateBioAura each frame so transitions are smooth, not jarring.
    const PALETTE = {
      flow:        { hex: 0xa0ecff, opacity: 0.42 },  // cyan-white. peak performance
      berserker:   { hex: 0xff6048, opacity: 0.55 },  // red. rage
      focused:     { hex: 0xa0c0ff, opacity: 0.32 },  // calm blue. locked-in
      meditation:  { hex: 0x70e8a8, opacity: 0.28 },  // soft green. restorative
      frantic:     { hex: 0xff80e0, opacity: 0.42 },  // magenta. chaotic
      aroused:     { hex: 0xffb060, opacity: 0.32 },  // orange. charged
      calm:        { hex: 0x80d0e0, opacity: 0.22 },  // pale cyan. at peace
      distracted:  { hex: 0x808898, opacity: 0.18 },  // grey. drift
      neutral:     { hex: 0xffffff, opacity: 0.00 },  // off
    };
    const p = PALETTE[state] || PALETTE.neutral;
    if (this._bioAura) {
      this._bioAuraTargetColor.setHex(p.hex);
      // No aura on the menu; only when actually playing.
      this._bioAuraTargetOpacity = this.running ? p.opacity : 0;
    }
    // Body-level CSS class drives the full-screen vignette tint.
    if (state && state !== "neutral") {
      document.body.dataset.bioState = state;
    } else {
      delete document.body.dataset.bioState;
    }
    // Brief screen flash on state CHANGE (not on every refresh).
    if (state && state !== "neutral" && state !== this._lastFlashedState) {
      this._lastFlashedState = state;
      this._bioStateFlash(p.hex);
    } else if (!state || state === "neutral") {
      this._lastFlashedState = null;
    }
  }

  // TAB info panel. info on demand. The always-visible HUD shows only
  // distance + lives + active powers + biome banner; everything else
  // (score, BPM, state, controls, legend) lives in this panel. Press
  // TAB to open/close. Auto-pauses gameplay while open so the player
  // can read at their own pace.
  _toggleInfoPanel() {
    const open = !document.body.classList.contains("info-open");
    if (open) {
      // Populate fields fresh on open.
      const $$ = (id) => document.getElementById(id);
      $$("infoBiome").textContent = this.biomeName + (this.biomeCycle > 0 ? "  ·  ×" + (this.biomeCycle + 1) : "");
      $$("infoDist").textContent  = Math.round(this.distance) + " m";
      $$("infoScore").textContent = Math.floor(this.score).toLocaleString();
      $$("infoBpm").textContent   = this.bpm ? this.bpm + " bpm" : ". ";
      $$("infoState").textContent = this.cognitiveState && this.cognitiveState !== "neutral"
        ? (this.cognitiveState.charAt(0).toUpperCase() + this.cognitiveState.slice(1))
        : ". ";
      // Auto-pause if playing.
      if (this.running && !this.over && !this.paused) {
        this._wasPlayingBeforeInfo = true;
        this.paused = true;
      } else {
        this._wasPlayingBeforeInfo = false;
      }
      document.body.classList.add("info-open");
    } else {
      document.body.classList.remove("info-open");
      if (this._wasPlayingBeforeInfo) {
        this.paused = false;
        this._wasPlayingBeforeInfo = false;
        this._lastT = performance.now();   // skip the pause delta
      }
    }
  }

  // Heartbeat pulse. paces a soft visual pulse to the player's BPM so
  // the world physically beats with their body. The rPPG sensor reports
  // BPM ~4×/sec, not per-beat, so we INFER the next-beat timing from
  // BPM (60/bpm seconds between beats) and schedule a chain of pulses
  // that runs until the next BPM update overrides it. Each pulse:
  //   * adds a brief vignette darkening (systole compression)
  //   * gives a tiny camera punch via the existing _shake system
  //   * tints the bio aura saturation up for ~120ms
  _scheduleHeartbeatPulse() {
    if (!this.bpm || this.bpm < 30 || this.bpm > 220) return;
    if (this._hbTimer) clearTimeout(this._hbTimer);
    const interval = 60 / this.bpm; // seconds between beats
    const tick = () => {
      this._heartbeatPulse();
      // Re-schedule for the next beat at current BPM. If BPM updates
      // mid-chain, this timer will be cleared and replaced.
      this._hbTimer = setTimeout(tick, interval * 1000);
    };
    // First pulse immediately, then chain.
    tick();
  }
  _heartbeatPulse() {
    if (!this.running) return;
    // Tiny camera kick. magnitude 0.06 is just barely perceptible,
    // exactly the feeling of feeling your own pulse in the world.
    this._shake(0.06, 0.08);
    // Brief darkening pulse via a reused overlay element.
    let el = this._heartbeatEl;
    if (!el) {
      el = document.createElement("div");
      el.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:8;"
        + "background:radial-gradient(ellipse at center,transparent 50%,rgba(0,0,0,.18) 100%);"
        + "opacity:0;transition:opacity .12s ease;";
      document.body.appendChild(el);
      this._heartbeatEl = el;
    }
    el.style.opacity = "1";
    clearTimeout(this._heartbeatT);
    this._heartbeatT = setTimeout(() => { el.style.opacity = "0"; }, 110);
  }

  // One-shot fullscreen colour flash when bio cognitive state changes.
  // Uses a CSS-driven overlay (added once, reused) so it doesn't burn GC.
  _bioStateFlash(hex) {
    let el = this._bioFlashEl;
    if (!el) {
      el = document.createElement("div");
      el.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:33;"
        + "opacity:0;transition:opacity .22s ease;mix-blend-mode:screen;";
      document.body.appendChild(el);
      this._bioFlashEl = el;
    }
    const css = "#" + ("000000" + hex.toString(16)).slice(-6);
    el.style.background = `radial-gradient(ellipse at center,${css}55 0%,${css}10 60%,transparent 100%)`;
    el.style.opacity = "1";
    clearTimeout(this._bioFlashT);
    this._bioFlashT = setTimeout(() => { el.style.opacity = "0"; }, 280);
  }

  // --- biomes / realms ------------------------------------------------
  // Map an absolute run distance to a biome index. The biome cycle wraps
  // so the run is endless; each loop bumps biomeCycle for scoring later.
  _currentBiomeIndex(distance) {
    const inCycle = ((distance % BIOME_CYCLE_LENGTH) + BIOME_CYCLE_LENGTH) % BIOME_CYCLE_LENGTH;
    let acc = 0;
    for (let i = 0; i < BIOMES.length; i++) {
      acc += BIOMES[i].length;
      if (inCycle < acc) return i;
    }
    return 0;
  }

  // Ease scene colours toward the active biome's palette each frame.
  // Detects biome transitions and fires the entrance encounter.
  _updateBiome(dt) {
    if (!this.running) return;
    const cycle = Math.floor(this.distance / BIOME_CYCLE_LENGTH);
    if (cycle !== this.biomeCycle) this.biomeCycle = cycle;
    const idx = this._currentBiomeIndex(this.distance);
    if (idx !== this.biomeIdx) this._transitionBiome(idx);
    // Lerp fog colour toward target. Sky shader uniforms get the same
    // treatment so the gradient eases too.
    if (this.scene.fog) {
      this.scene.fog.color.lerp(this._biomeFogTarget, Math.min(1, dt * 0.6));
      this.scene.background.lerp(this._biomeFogTarget, Math.min(1, dt * 0.6));
    }
    // Sky.js uniforms. ease toward the active biome's atmospheric
    // settings. Different realms have radically different atmospheres
    // and the Hosek-Wilkie shader handles colour fully procedurally
    // from those four numbers, no manual gradient stops needed.
    if (this.sky && this.sky.material && this.sky.material.uniforms && this._skyTarget) {
      const u = this.sky.material.uniforms;
      const ease = Math.min(1, dt * 0.6);
      u["turbidity"].value       += (this._skyTarget.turbidity       - u["turbidity"].value)       * ease;
      u["rayleigh"].value        += (this._skyTarget.rayleigh        - u["rayleigh"].value)        * ease;
      u["mieCoefficient"].value  += (this._skyTarget.mieCoefficient  - u["mieCoefficient"].value)  * ease;
      u["mieDirectionalG"].value += (this._skyTarget.mieDirectionalG - u["mieDirectionalG"].value) * ease;
      // Sun elevation can swing too. Asgard high noon, Helheim low.
      if (this._skySunTarget) {
        u["sunPosition"].value.lerp(this._skySunTarget, ease);
      }
    }
  }

  _transitionBiome(newIdx) {
    const prev = this.biomeIdx;
    this.biomeIdx = newIdx;
    const b = BIOMES[newIdx];
    this.biomeName = b.name;
    this._biomeFogTarget.setHex(b.fog);
    this._biomeSkyTargets = b.sky.map(c => new THREE.Color(c));
    // Sky.js parameter targets per biome. these drive the atmosphere
    // through Hosek-Wilkie scattering for radically different looks.
    // All four realms on the SAME overcast baseline. Asgard had
    // rayleigh 0.6 + sun elev 12° which Sky.js rendered as bright
    // white = "I can see nothing" whiteout. Now Asgard is just a
    // warmer / lighter overcast, not a snowstorm. All four are
    // similar mid-greys with subtle temperature shifts.
    const SKY_PARAMS = {
      Midgard:    { turbidity: 12, rayleigh: 0.4, mieCoefficient: 0.030, mieDirectionalG: 0.70, sunElev: 5, sunAz: 200 },
      "Jötunheim":{ turbidity: 14, rayleigh: 0.3, mieCoefficient: 0.035, mieDirectionalG: 0.65, sunElev: 3, sunAz: 220 },
      Muspelheim: { turbidity: 18, rayleigh: 0.4, mieCoefficient: 0.060, mieDirectionalG: 0.85, sunElev: 3, sunAz: 180 },
      Asgard:     { turbidity: 11, rayleigh: 0.4, mieCoefficient: 0.028, mieDirectionalG: 0.75, sunElev: 5, sunAz: 220 },
    };
    const sp = SKY_PARAMS[b.name] || SKY_PARAMS.Midgard;
    this._skyTarget = sp;
    const phi = THREE.MathUtils.degToRad(90 - sp.sunElev);
    const theta = THREE.MathUtils.degToRad(sp.sunAz);
    this._skySunTarget = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    // Aurora visible only in Asgard. Build lazily on first entry, then
    // toggle visibility per biome.
    this._setAuroraVisible(b.name === "Asgard");
    // Re-pitch the music loop to the biome's modal centre.
    if (this.audio && typeof this.audio.setBiomePitch === "function") {
      this.audio.setBiomePitch(b.pitch);
    }
    this._showBiomeBanner(b.name);
    this._updateBiomeChip();
    // Score reward for crossing. scales with cycle count.
    const reward = 300 + this.biomeCycle * 200;
    this.score += reward;
    this._popText(`+${reward}`, "gold", 0, -50);
    // Spawn the entrance encounter. a giant boss mesh that scrolls past
    // and a curated obstacle pattern. Skips Midgard (the spawn realm).
    //
    // ODIN. climactic 5th-realm boss. On every Asgard entry from
    // cycle >= 4, replace the standard Valkyrie blessing with the
    // All-Father himself. Real saga-ending encounter.
    let bossType = b.boss;
    if (b.name === "Asgard" && (this.biomeCycle || 0) >= 4) {
      bossType = "odin";
    }
    if (bossType) this._spawnBoss(bossType);
  }

  // Persistent realm chip in the HUD top-bar so the player always knows
  // which realm they're in (the banner is transient. this is the
  // permanent indicator).
  // Aurora borealis. two huge curved ribbon planes above the player,
  // animated via a custom shader. Built lazily on first Asgard entry
  // and shown/hidden via setVisible. Uses additive blending + emissive
  // colours > 1.0 so the bloom pass turns it into real sky-light.
  _setAuroraVisible(visible) {
    if (!this._aurora && visible) this._buildAurora();
    if (this._aurora) {
      for (const m of this._aurora) m.visible = visible;
    }
  }

  _buildAurora() {
    this._aurora = [];
    // Custom GLSL was causing shader-link failures on some GPUs.
    // Safer approach: two large MeshBasicMaterial planes with vertex
    // colours baked into a curved geometry, plus mild additive blend
    // and a slow per-frame UV scroll via texture rotation. No custom
    // shader, no risk of compile error.
    const palettes = [
      { hex: 0x40ffb0 },   // jade green
      { hex: 0xa060ff },   // violet pink
    ];
    for (let i = 0; i < 2; i++) {
      const geo = new THREE.PlaneGeometry(260, 70, 60, 8);
      const pos = geo.attributes.position;
      // Bake vertex colours: bright in middle band, dark at top/bottom.
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color(palettes[i].hex);
      for (let v = 0; v < pos.count; v++) {
        const x = pos.getX(v);
        const yn = (pos.getY(v) / 35 + 1) * 0.5; // 0..1 vertical
        // Curve the plane so it drapes like a ribbon.
        pos.setZ(v, Math.sin(x * 0.014) * 14);
        const band = Math.min(1, Math.max(0, 1 - Math.abs(yn - 0.55) * 2.4));
        colors[v * 3]     = c.r * band * 2.2;
        colors[v * 3 + 1] = c.g * band * 2.2;
        colors[v * 3 + 2] = c.b * band * 2.2;
      }
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      pos.needsUpdate = true;
      geo.computeVertexNormals();

      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true, opacity: 0.75,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, 75 + i * 22, 170);
      mesh.rotation.y = i === 0 ? 0.18 : -0.22;
      mesh.visible = false;
      mesh.userData.basePhase = i;
      this.scene.add(mesh);
      this._aurora.push(mesh);
    }
  }

  _updateBiomeChip() {
    let el = this._biomeChipEl;
    if (!el) {
      el = document.createElement("div");
      el.style.cssText =
        // Cinzel inscription, no card, just text. Centred top.
        "position:fixed;top:calc(env(safe-area-inset-top,18px) + 4px);left:50%;" +
        "transform:translateX(-50%);z-index:11;pointer-events:none;" +
        "font:600 11px/1 'Cinzel',serif;letter-spacing:.32em;" +
        "text-transform:uppercase;text-shadow:0 2px 14px rgba(0,0,0,.9);" +
        "transition:opacity .4s ease,color .5s ease";
      document.body.appendChild(el);
      this._biomeChipEl = el;
    }
    const b = BIOMES[this.biomeIdx];
    el.textContent = b.name + (this.biomeCycle > 0 ? "  ·  ×" + (this.biomeCycle + 1) : "");
    // Bronze stays constant across realms. keeps the inscription
    // legible regardless of fog colour. Realm identity comes from
    // the actual sky + fog colour shift, not the text colour.
    el.style.color = "rgba(201,165,92,0.86)";
    el.style.opacity = this.running ? "1" : "0";
  }

  _showBiomeBanner(name) {
    let el = this._biomeBannerEl;
    if (!el) {
      el = document.createElement("div");
      el.style.cssText =
        "position:fixed;top:30%;left:50%;transform:translate(-50%,-50%);" +
        "font:800 38px/1 'Cinzel',serif;color:#fff;letter-spacing:.08em;" +
        "text-transform:uppercase;text-shadow:0 4px 30px rgba(0,0,0,.8),0 0 18px rgba(255,255,255,.4);" +
        "pointer-events:none;z-index:36;opacity:0;transition:opacity .6s ease,transform .6s ease;" +
        "text-align:center;line-height:1.2";
      document.body.appendChild(el);
      this._biomeBannerEl = el;
    }
    el.innerHTML = `<div style="font-size:13px;font-weight:600;letter-spacing:.2em;opacity:.7;margin-bottom:6px">ENTERING</div>${name}`;
    el.style.opacity = "1";
    el.style.transform = "translate(-50%, -50%) translateY(0)";
    clearTimeout(this._biomeBannerT);
    this._biomeBannerT = setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translate(-50%, -50%) translateY(-18px)";
    }, 2600);
    // SAGA NARRATION. fire the Skald's line a beat after the banner
    // settles. Different line each biome; special line on full saga
    // cycle (Midgard re-entry after Asgard).
    setTimeout(() => this._showSkaldNarration(name), 700);
  }

  // SKALD NARRATION. italic poetic line shown below the biome banner.
  // Curated text per realm, with a special "saga reborn" line when the
  // player returns to Midgard after completing a full cycle.
  _showSkaldNarration(biomeName) {
    let el = this._skaldEl;
    if (!el) {
      el = document.createElement("div");
      el.style.cssText =
        "position:fixed;bottom:25%;left:50%;transform:translate(-50%,0);" +
        "font:italic 600 19px/1.4 'Cinzel',serif;color:#f4d49a;" +
        "letter-spacing:.04em;text-align:center;max-width:min(700px,80vw);" +
        "text-shadow:0 4px 24px rgba(0,0,0,.95),0 0 14px rgba(244,212,154,.25);" +
        "pointer-events:none;z-index:35;opacity:0;transition:opacity 1.2s ease,transform 1s ease";
      document.body.appendChild(el);
      this._skaldEl = el;
    }
    // SAGA LINES. curated Norse-flavoured one-liners per realm.
    // Different first-cycle vs returning lines so the saga has arc.
    const FIRST = {
      Midgard:    "Midgard. Where every Skald begins.",
      "Jötunheim":"Jötunheim. Home of the frost giants. Tread lightly. Ymir's children do not forgive.",
      Muspelheim: "Muspelheim. Surtr's flame. The road runs through the source of the world's ending.",
      Asgard:     "Asgard. Bifröst opens for those who proved themselves on the road.",
    };
    const RETURN = {
      Midgard:    `Midgard again. Saga ${this.biomeCycle + 1}. the gods have not forgotten you.`,
      "Jötunheim":"Jötunheim. Frost knows your name now.",
      Muspelheim: "Muspelheim. The flame remembers your last passing.",
      Asgard:     "Asgard. Odin watches. Walk well.",
    };
    const line = (this.biomeCycle > 0 ? RETURN : FIRST)[biomeName] || `${biomeName}.`;
    el.textContent = `"${line}"`;
    el.style.opacity = "0";
    el.style.transform = "translate(-50%, 10px)";
    // Fade in over 1.2s
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translate(-50%, 0)";
    });
    clearTimeout(this._skaldT);
    this._skaldT = setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translate(-50%, -8px)";
    }, 5200);
  }

  // Boss encounter. A large character mesh appears ~80m ahead and scrolls
  // past the player as the world moves. The mesh is decorative. the
  // actual "encounter" is a curated obstacle pattern spawned alongside,
  // tuned to the boss's specialty (lane-pressure, slide-walls, fly-bys).
  // Surviving the pattern is the implicit win condition.
  _spawnBoss(type) {
    // 30m ahead at BASE_SPEED 22 = ~1.4s after banner fires. Player
    // immediately sees the boss looming.
    const ahead = this.distance + 30;
    const grp = new THREE.Group();
    let label = "BOSS";
    if (type === "jotunn") {
      label = "JÖTUNN";
      // Frost giant. towering blocky humanoid in pale-blue.
      const skin = new THREE.MeshStandardMaterial({
        color: 0x9eb8d0, roughness: 0.85, flatShading: true,
        emissive: 0x304050, emissiveIntensity: 0.25,
      });
      const torso = new THREE.Mesh(new THREE.BoxGeometry(3.5, 5, 2.2), skin);
      torso.position.y = 4.2; grp.add(torso);
      const head = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), skin);
      head.position.y = 7.7; grp.add(head);
      for (const sx of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4.5, 1.2), skin);
        arm.position.set(sx * 2.4, 4.5, 0); grp.add(arm);
      }
      for (const sx of [-0.7, 0.7]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(1.4, 3.6, 1.4), skin);
        leg.position.set(sx, 1.4, 0); grp.add(leg);
      }
      // Frost crown
      for (let i = 0; i < 5; i++) {
        const spike = new THREE.Mesh(
          new THREE.ConeGeometry(0.3, 1.2, 6),
          new THREE.MeshStandardMaterial({ color: 0xe8f4ff, flatShading: true, emissive: 0x80a0c0, emissiveIntensity: 0.3 })
        );
        spike.position.set((i - 2) * 0.45, 9, 0); grp.add(spike);
      }
      grp.position.set(0, 0, ahead);
    } else if (type === "surtr") {
      label = "SURTR";
      // Fire jötunn. full humanoid silhouette (not just torso+head
      // which user was correctly reporting as "a red block"). Same
      // proportions as Jötunn but darker stone with molten cracks
      // glowing through. ALL the body parts now.
      const stone = new THREE.MeshStandardMaterial({
        color: 0x301810, roughness: 1.0, flatShading: true,
        emissive: 0xff4010, emissiveIntensity: 0.5,
      });
      const torso = new THREE.Mesh(new THREE.BoxGeometry(3.5, 5, 2.2), stone);
      torso.position.y = 4.2; grp.add(torso);
      const head = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), stone);
      head.position.y = 7.7; grp.add(head);
      // Arms. same as Jötunn proportions, tagged so we can animate
      // them swinging during idle (held above the head with the sword).
      const armL = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4.5, 1.2), stone);
      armL.position.set(-2.4, 4.5, 0); grp.add(armL);
      const armR = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4.5, 1.2), stone);
      armR.position.set(2.4, 4.5, 0); grp.add(armR);
      // Legs
      for (const sx of [-0.7, 0.7]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(1.4, 3.6, 1.4), stone);
        leg.position.set(sx, 1.4, 0); grp.add(leg);
      }
      // Glowing eyes. twin emissive dots on the head.
      for (const sx of [-0.35, 0.35]) {
        const eye = new THREE.Mesh(
          new THREE.SphereGeometry(0.18, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xffe040 })
        );
        eye.position.set(sx, 7.8, 1.05); grp.add(eye);
      }
      // Flaming sword raised in right arm (offset to sit in the hand).
      const sword = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 6, 0.4),
        new THREE.MeshBasicMaterial({ color: 0xffb030, transparent: true, opacity: 0.95 })
      );
      sword.position.set(2.4, 10, 0); grp.add(sword);
      const swordGlow = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 6.6, 1.2),
        new THREE.MeshBasicMaterial({ color: 0xff4010, transparent: true, opacity: 0.35, depthWrite: false })
      );
      swordGlow.position.set(2.4, 10, 0); grp.add(swordGlow);
      grp.position.set(0, 0, ahead);
    } else if (type === "valkyrie") {
      label = "VALKYRIE";
      // Winged blessing. not a fight. Golden silhouette with outspread wings.
      const gold = new THREE.MeshStandardMaterial({
        color: 0xf0d090, roughness: 0.3, metalness: 0.8,
        emissive: 0xffb060, emissiveIntensity: 0.6,
      });
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 3, 0.8), gold);
      body.position.y = 6.5; grp.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), gold);
      head.position.y = 8.5; grp.add(head);
      for (const sx of [-1, 1]) {
        const wing = new THREE.Mesh(
          new THREE.PlaneGeometry(4, 2),
          new THREE.MeshStandardMaterial({ color: 0xfff0c0, side: THREE.DoubleSide, emissive: 0xfff0c0, emissiveIntensity: 0.5 })
        );
        wing.position.set(sx * 2, 7, 0);
        wing.rotation.y = sx * 0.4;
        grp.add(wing);
      }
      grp.position.set(0, 0, ahead);
      // Valkyrie blesses the player: a 5s 3x score multiplier window.
      this._activatePowerup("mult", 5);
    } else if (type === "odin") {
      // ODIN. All-Father. Climactic 5th-cycle Asgard encounter.
      // Towering robed figure: dark cloak, two ravens at his shoulders,
      // Gungnir (spear) raised, single glowing eye (he gave up the other).
      label = "ODIN";
      const robe = new THREE.MeshStandardMaterial({
        color: 0x1a1218, roughness: 0.9, flatShading: true,
        emissive: 0x4030a0, emissiveIntensity: 0.18,
      });
      const skin = new THREE.MeshStandardMaterial({
        color: 0x705848, roughness: 0.85, flatShading: true,
      });
      // Torso. long robe taper
      const torso = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 3.0, 6.5, 8), robe);
      torso.position.y = 4.5; grp.add(torso);
      // Cloak shoulders. flared trapezoid
      const cloak = new THREE.Mesh(new THREE.ConeGeometry(3.3, 2.2, 8, 1, true), robe);
      cloak.position.y = 7.2; grp.add(cloak);
      // Head
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.85, 12, 8), skin);
      head.position.y = 8.8; grp.add(head);
      // Beard. long pointed cone
      const beard = new THREE.Mesh(
        new THREE.ConeGeometry(0.55, 1.4, 8),
        new THREE.MeshStandardMaterial({ color: 0xc8c0b0, roughness: 0.95, flatShading: true })
      );
      beard.position.set(0, 8.0, 0.6);
      beard.rotation.x = Math.PI;
      grp.add(beard);
      // Hat brim. wide flat disc (broad-brimmed hat / wanderer's hat)
      const hat = new THREE.Mesh(
        new THREE.CylinderGeometry(1.6, 1.6, 0.15, 12),
        new THREE.MeshStandardMaterial({ color: 0x0a0a14, roughness: 0.95, flatShading: true })
      );
      hat.position.y = 9.5; grp.add(hat);
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(0.9, 1.5, 8),
        new THREE.MeshStandardMaterial({ color: 0x0a0a14, roughness: 0.95, flatShading: true })
      );
      crown.position.y = 10.4; grp.add(crown);
      // Single glowing eye
      const eye = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0x80c0ff })
      );
      eye.position.set(0.25, 8.85, 0.78);
      grp.add(eye);
      // The other socket. dark hollow
      const socket = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
      );
      socket.position.set(-0.25, 8.85, 0.78);
      grp.add(socket);
      // Gungnir. long spear raised in right hand
      const spear = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.10, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.7, flatShading: true })
      );
      spear.position.set(2.8, 8, 0);
      grp.add(spear);
      const spearTip = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, 1.2, 6),
        new THREE.MeshStandardMaterial({
          color: 0xe0e8f0, roughness: 0.2, metalness: 0.95,
          emissive: 0x8090ff, emissiveIntensity: 0.4,
        })
      );
      spearTip.position.set(2.8, 12.2, 0);
      grp.add(spearTip);
      // Two raven companions at the shoulders (Huginn + Muninn)
      for (const sx of [-1.5, 1.5]) {
        const r = new THREE.Mesh(
          new THREE.SphereGeometry(0.3, 8, 6),
          new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.8, flatShading: true })
        );
        r.position.set(sx, 8.3, 0.3);
        r.scale.set(1, 0.7, 1.5);
        grp.add(r);
      }
      grp.position.set(0, 0, ahead);
      // Tag the boss group so per-frame anim can animate ravens / glow
      grp.userData.odinFx = { eye, spearTip, t0: performance.now() };
    }
    this.scene.add(grp);
    // Banner mesh above the boss naming them.
    const bossLabel = this._makeTextSprite(label, 0xffd060);
    bossLabel.position.set(0, 12, 0);
    bossLabel.scale.set(6, 1.5, 1);
    grp.add(bossLabel);

    // Boss has HP. Player damages it by surviving hazards in the encounter
    // pattern, collecting runes during the fight, and being in Flow state
    // (the bio path to victory). Valkyrie is the only non-combat boss . 
    // she gives a blessing, doesn't fight.
    const HP_BY_TYPE = { jotunn: 100, surtr: 130, valkyrie: 1, odin: 300 };
    const hpMax = HP_BY_TYPE[type] || 100;

    // HP bar. two stacked planes (background + foreground fill).
    // Floats above the boss as a sprite so it always faces camera.
    const hpBg = new THREE.Mesh(
      new THREE.PlaneGeometry(5.0, 0.35),
      new THREE.MeshBasicMaterial({ color: 0x100804, transparent: true, opacity: 0.85, depthWrite: false })
    );
    hpBg.position.set(0, 10.6, 0);
    grp.add(hpBg);
    const hpFill = new THREE.Mesh(
      new THREE.PlaneGeometry(4.85, 0.22),
      new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.95, depthWrite: false })
    );
    hpFill.position.set(0, 10.6, 0.01);
    grp.add(hpFill);

    // Track everything we need for the per-frame fight loop.
    this._bossActor = {
      mesh: grp, spawnAt: ahead, type,
      hp: hpMax, hpMax,
      hpFill, hpFillBaseWidth: 4.85,
      defeated: false, escaped: false,
      // For the slow rocking idle animation.
      idle: 0,
    };

    // Curated obstacle pattern. Each successfully-dodged obstacle inside
    // this encounter applies damage in the per-frame collision branch
    // (see _update. checks o.encounterBoss).
    const patternZ = ahead + 14;
    const tag = (o) => { if (o) o.encounterBoss = true; };
    if (type === "jotunn") {
      tag(this._spawnObstacleAt(0, patternZ));
      tag(this._spawnObstacleAt(2, patternZ + 12));
      tag(this._spawnObstacleAt(1, patternZ + 24));
      tag(this._spawnObstacleAt(0, patternZ + 36));
      tag(this._spawnObstacleAt(2, patternZ + 48));
    } else if (type === "surtr") {
      this._spawnBeam(patternZ);            tag(this.obstacles[this.obstacles.length - 1]);
      this._spawnFirePit(1, patternZ + 14); tag(this.obstacles[this.obstacles.length - 1]);
      this._spawnBeam(patternZ + 28);       tag(this.obstacles[this.obstacles.length - 1]);
      this._spawnFirePit(0, patternZ + 42); tag(this.obstacles[this.obstacles.length - 1]);
    } else if (type === "valkyrie") {
      for (let i = 0; i < 5; i++) {
        this._spawnRune(i % 3, patternZ + i * 8);
      }
      // No combat. kill her HP immediately so we don't show a bar.
      this._bossActor.hpMax = 0;
      hpBg.visible = false; hpFill.visible = false;
    } else if (type === "odin") {
      // ODIN. climactic, longer pattern, all hazard types mixed.
      // Beams to slide under, fire pits to jump, lane obstacles, and
      // a final dense rune cluster (the only way to reliably hit the
      // 300 HP threshold within the encounter window).
      this._spawnBeam(patternZ);            tag(this.obstacles[this.obstacles.length - 1]);
      tag(this._spawnObstacleAt(2, patternZ + 12));
      this._spawnFirePit(0, patternZ + 24); tag(this.obstacles[this.obstacles.length - 1]);
      tag(this._spawnObstacleAt(1, patternZ + 36));
      this._spawnBeam(patternZ + 48);       tag(this.obstacles[this.obstacles.length - 1]);
      tag(this._spawnObstacleAt(0, patternZ + 60));
      this._spawnFirePit(2, patternZ + 72); tag(this.obstacles[this.obstacles.length - 1]);
      // Rune storm. Odin's runes are how you actually take him down.
      for (let i = 0; i < 6; i++) {
        this._spawnRune(i % 3, patternZ + 84 + i * 7);
      }
    }

    // Show the 4s tutorial popup. explicit "how to kill this boss"
    // hint that even a first-timer can grok. Valkyrie gets a friendlier
    // variant since she's a blessing, not a fight.
    this._showBossTutorial(label, hpMax, type);
  }

  // Big-text popup that briefly explains how to deal damage to the boss
  // currently on-stage. Auto-dismisses after 4s. Idempotent. replacing
  // a popup before it finishes resets the timer.
  _showBossTutorial(label, hpMax, type) {
    const el = document.getElementById("bossTutorial");
    if (!el) return;
    const nameEl = document.getElementById("bossTutorialName");
    const hpEl = document.getElementById("bossTutorialHp");
    if (nameEl) nameEl.textContent = label;
    if (hpEl) hpEl.textContent = hpMax > 0 ? `HP ${hpMax}` : "BLESSING";
    // Valkyrie variant. swap the "how to damage" rows for a single
    // "collect her runes" line so users don't try to attack her.
    // Reach into the popup's body rows (the .col flex container).
    const rows = el.querySelector("div[style*='flex-direction:column']");
    if (rows) {
      if (type === "valkyrie") {
        rows.innerHTML = `
          <div><span style="color:#60d0ff;font-weight:700">ᚱ Collect her runes</span> &nbsp;<span style="color:rgba(255,255,255,.55)">to receive her gift</span></div>
          <div><span style="color:#ffd066;font-weight:700">3× score multiplier</span> &nbsp;<span style="color:rgba(255,255,255,.55)">active for 5 seconds</span></div>
        `;
      } else {
        rows.innerHTML = `
          <div><span style="color:#60d0ff;font-weight:700">ᚱ Collect runes</span> &nbsp;<span style="color:rgba(255,255,255,.55)">+40 damage each</span></div>
          <div><span style="color:#ffd066;font-weight:700">⚠ Dodge his attacks</span> &nbsp;<span style="color:rgba(255,255,255,.55)">+25 damage each</span></div>
          <div><span style="color:#7ad9ff;font-weight:700">🌊 Stay in Flow</span> &nbsp;<span style="color:rgba(255,255,255,.55)">+5 damage / second</span></div>
        `;
      }
    }
    el.style.display = "block";
    // Force reflow so the opacity transition actually plays from 0→1.
    void el.offsetWidth;
    el.style.opacity = "1";
    el.style.transform = "translate(-50%,-50%) scale(1)";
    // Cancel any in-flight dismiss timer.
    if (this._bossTutorialTimer) { clearTimeout(this._bossTutorialTimer); this._bossTutorialTimer = null; }
    this._bossTutorialTimer = setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translate(-50%,-50%) scale(0.96)";
      setTimeout(() => { if (el.style.opacity === "0") el.style.display = "none"; }, 350);
      this._bossTutorialTimer = null;
    }, 4000);
  }

  // _spawnObstacle but returns the obstacle record so the boss code can
  // tag it as part of an encounter.
  _spawnObstacleAt(lane, zWorld) {
    this._spawnObstacle(lane, zWorld);
    return this.obstacles[this.obstacles.length - 1];
  }

  // Called when the player successfully dodges/jumps/slides an obstacle
  // tagged with encounterBoss. Damages the active boss; if HP hits 0
  // triggers the death sequence + big reward.
  _damageBoss(amount, source) {
    const b = this._bossActor;
    if (!b || b.defeated || b.escaped || b.hpMax <= 0) return;
    b.hp = Math.max(0, b.hp - amount);
    // Update HP bar fill width.
    if (b.hpFill) {
      const pct = b.hp / b.hpMax;
      b.hpFill.scale.x = Math.max(0.001, pct);
      // Flash brighter on hit.
      b.hpFill.material.color.setHex(0xff8030);
      setTimeout(() => { if (b.hpFill) b.hpFill.material.color.setHex(0xff3030); }, 120);
    }
    // Floating damage number near the boss (in-world sprite).
    this._popText(`-${Math.round(amount)}`, "rune", 0, -50);
    // Screen-space damage float on the HP bar. bigger, colour-coded by
    // source so the player can SEE which input is hurting the boss.
    // Continuous flow/berserker damage accumulates into integer chunks
    // so we don't spam tiny "+0.08" floats every frame.
    this._accumBossDmg(amount, source);
    if (b.hp <= 0) this._killBoss(source);
  }

  // Coalesces sub-integer DPS into one float per integer of damage, so
  // the HP bar floats stay readable (one big "+5" per second of Flow
  // rather than 60 "+0.08"s).
  _accumBossDmg(amount, source) {
    if (!this._bossDmgAccum) this._bossDmgAccum = { rune: 0, dodge: 0, flow: 0, berserker: 0 };
    if (amount >= 5) {
      // Discrete big hit. show immediately and don't touch the accumulator.
      this._spawnBossDmgFloat(Math.round(amount), source);
      return;
    }
    const key = (source in this._bossDmgAccum) ? source : "flow";
    this._bossDmgAccum[key] = (this._bossDmgAccum[key] || 0) + amount;
    if (this._bossDmgAccum[key] >= 5) {
      const whole = Math.floor(this._bossDmgAccum[key]);
      this._bossDmgAccum[key] -= whole;
      this._spawnBossDmgFloat(whole, key);
    }
  }

  // Append a "+N" element to the HP bar's float layer. CSS animation
  // lifts it up and fades it out, then we GC the node after 700ms.
  _spawnBossDmgFloat(n, source) {
    const layer = document.getElementById("bossBannerDmgFloats");
    if (!layer) return;
    const colour = source === "rune"      ? "#60d0ff"
                 : source === "dodge"     ? "#ffd066"
                 : source === "flow"      ? "#7ad9ff"
                 : source === "berserker" ? "#ff8c5a"
                                          : "#ffffff";
    const icon = source === "rune"      ? "ᚱ"
               : source === "dodge"     ? "⚠"
               : source === "flow"      ? "🌊"
               : source === "berserker" ? "⚔"
                                        : "";
    const el = document.createElement("div");
    el.textContent = `${icon} +${n}`;
    // Random horizontal position across the bar so back-to-back floats
    // don't overlap. Anchored above the bar (-22px) and animates up.
    const xPct = 20 + Math.random() * 60;
    el.style.cssText = `position:absolute;left:${xPct}%;top:-22px;transform:translate(-50%,0);font:700 16px/1 'Cinzel',serif;color:${colour};text-shadow:0 2px 8px rgba(0,0,0,.85),0 0 12px ${colour}80;pointer-events:none;white-space:nowrap;animation:bossDmgFloat .7s ease-out forwards`;
    layer.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch {} }, 750);
  }

  _killBoss(source) {
    const b = this._bossActor;
    if (!b || b.defeated) return;
    b.defeated = true;
    // Track for lifetime/daily stats + PER-BOSS kill counts (drives
    // the boss roster on the menu).
    this.runBossKills = (this.runBossKills || 0) + 1;
    try {
      const st = Store.load();
      st.bossKills = st.bossKills || {};
      st.bossKills[b.type] = (st.bossKills[b.type] || 0) + 1;
      // Daily-quest progress hook for "Slay 2 bosses today".
      if (st.dailyQuest && st.dailyQuest.id === "bossKill2" && !st.dailyQuest.done) {
        st.dailyQuest.progress = (st.dailyQuest.progress || 0) + 1;
        if (st.dailyQuest.progress >= 2) { st.dailyQuest.done = true; this.score += 500; }
      }
      Store.save(st);
    } catch (e) { console.warn("[boss kill stats]", e); }
    // Big reward scaling with biome cycle.
    const reward = 1000 + this.biomeCycle * 500;
    this.score += reward;
    this._popText(`${b.type.toUpperCase()} SLAIN +${reward}`, "rune", 0, -40);
    this._shake(0.9, 0.6);
    this.hud.glory.classList.add("on");
    setTimeout(() => this.hud.glory.classList.remove("on"), 600);
    if (this.audio?.power) this.audio.power("mjolnir");
    // Death animation. boss tilts and falls. Real removal happens
    // when the per-frame update sees defeated + far enough behind.
    b.fallTimer = 0;
  }

  _bossEscaped() {
    const b = this._bossActor;
    if (!b || b.escaped) return;
    b.escaped = true;
    if (b.hpFill) b.hpFill.visible = false;
    this._popText(`${b.type.toUpperCase()} ESCAPES`, "combo", 0, -20);
  }

  // BIO SESSION TRACKER. the visible value prop of the Elata SDK.
  // Accumulates per-frame: time in each cognitive state, HR samples,
  // and progress toward the next "gift". Every 12 seconds of
  // continuous flow/focused/calm earns the player a free powerup
  //. direct cause and effect, no abstract score multiplier.
  // Drives the always-visible bio pill in the HUD and the end-of-run
  // report. This is THE feedback loop that justifies the SDK.
  _updateBioSession(dt) {
    const s = this.bioSession;
    if (!s) return;
    // HR + HRV sampling. running average + peak.
    if (this.bpm && this.bpm > 30) {
      s.sumHR += this.bpm * dt;
      s.hrSamples += dt;
      if (this.bpm > s.peakHR) s.peakHR = this.bpm;
    }
    if (this.hrv && this.hrv > 5) {
      s.sumHRV += this.hrv * dt;
      s.hrvSamples += dt;
    }
    // Per-state time accumulation, now including punish states.
    const cs = this.cognitiveState;
    if (cs === "flow")        s.flowSec       += dt;
    if (cs === "focused")     s.focusedSec    += dt;
    if (cs === "calm")        s.calmSec       += dt;
    if (cs === "berserker")   s.berserkerSec  += dt;
    if (cs === "meditation")  s.meditationSec += dt;
    if (cs === "stress")      s.stressSec     += dt;
    if (cs === "fatigue")     s.fatigueSec    += dt;

    // GIFT CYCLE with LOSS AVERSION. Positive states advance the meter;
    // PUNISH states actively drain it. The user feels the cost of
    // tensing up, not just the reward of relaxing. This is what makes
    // the bio integration actually motivate behavioural change.
    const positive = (cs === "flow")    ? 1.8
                   : (cs === "focused") ? 1.3
                   : (cs === "calm")    ? 1.0
                   : (cs === "meditation") ? 0.6
                   : 0;
    const drain = (cs === "stress")     ? 1.4    // stress drains FASTER than calm builds
                : (cs === "fatigue")    ? 0.8
                : (cs === "frantic")    ? 0.5
                : (cs === "distracted") ? 0.3
                : 0;
    if (positive > 0) {
      s.giftAccumSec += dt * positive;
      if (s.giftAccumSec >= 12) {
        s.giftAccumSec = 0;
        s.giftsEarned++;
        this._spawnBioGift(cs);
      }
    } else if (drain > 0) {
      const before = s.giftAccumSec;
      s.giftAccumSec = Math.max(0, s.giftAccumSec - dt * drain);
      s.giftLossAccumSec += (before - s.giftAccumSec);
      // If a near-full meter was just emptied by stress, count it as
      // a lost gift and tell the user EXPLICITLY (loss aversion is
      // strongest when the loss is visible).
      if (before > 10 && s.giftAccumSec < before - 1.5) {
        s.giftsLost++;
        if (cs === "stress" && !this._stressWarnedAt || (performance.now() - (this._stressWarnedAt || 0)) > 8000) {
          this._stressWarnedAt = performance.now();
          this._popText("WOLF AT THE DOOR", "combo", 0, 30);
        }
      }
    }
    // Drive the bio status pill HUD.
    this._updateBioStatusPill();
  }

  // Bio-triggered gift spawn. free powerup ahead of the player as
  // direct reward for biological self-regulation. Picks a gift
  // appropriate to the state.
  _spawnBioGift(state) {
    // Tier the gift to the state: flow gets the heavy hitters,
    // focused gets utility, calm gets the helpers.
    const POOLS = {
      flow:    ["thor",   "odin", "ship",   "shield"],
      focused: ["mult",   "ship", "shield", "magnet"],
      calm:    ["speed",  "mult", "magnet"],
    };
    const pool = POOLS[state] || POOLS.calm;
    const t = pool[(Math.random() * pool.length) | 0];
    const lane = (Math.random() * 3) | 0;
    const z = this.distance + 40;
    this._spawnPowerup(t, lane, z);
    // Big floating announcement in the world.
    this._popText("GIFT FROM " + state.toUpperCase(), "rune", 0, -40);
    if (this.audio?.power) this.audio.power("bragi");
  }

  // Always-visible bio status pill in the top-right under the lives.
  // Shows: current state + progress to next gift + cumulative gifts.
  // Only present when a sensor is active.
  // State-first bio dashboard. Hierarchy:
  //   1. BIG state name (FLOW / CALM / FOCUSED…) in plain English
  //   2. One-line plain-English meaning the player can actually feel
  //   3. Time-in-state counter (how long you've held this state)
  //   4. Gift meter (the always-on reward feedback loop)
  //   5. Tally of earned gifts
  //   6. Advanced toggle (⚙) reveals raw numbers. hidden by default
  //
  // The previous version led with BPM and crammed mechanic-speak
  // ("+35% gift duration") on the second line. Normal users have no
  // mental model for any of that. Now the panel says things like:
  //   "FLOW · The world bends around you · 23s held · Next gift 78%"
  _updateBioStatusPill() {
    let el = this._bioPillEl;
    if (!el) {
      el = document.createElement("div");
      // pointer-events:none on the container so it doesn't block game
      // clicks; the gear button below overrides this for itself.
      el.style.cssText =
        "position:fixed;right:14px;top:calc(env(safe-area-inset-top,14px) + 68px);" +
        "z-index:11;pointer-events:none;text-align:left;" +
        "min-width:180px;max-width:210px;" +
        "background:rgba(14,10,6,.72);border:1px solid rgba(212,173,106,.22);" +
        "border-radius:8px;padding:10px 12px 9px;" +
        "backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);" +
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;" +
        "color:#fff;opacity:0;transition:opacity .4s ease;" +
        "box-shadow:0 4px 22px rgba(0,0,0,.45)";
      el.innerHTML =
        // Header row: eyebrow + gear toggle
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
          '<div style="font-size:9px;letter-spacing:.22em;color:rgba(212,173,106,.55);text-transform:uppercase;font-weight:600">Your state</div>' +
          '<button class="advancedToggle" title="Show raw numbers" style="pointer-events:auto;background:none;border:1px solid rgba(212,173,106,.25);color:rgba(212,173,106,.6);width:18px;height:18px;border-radius:3px;cursor:pointer;font-size:9px;padding:0;line-height:1;display:flex;align-items:center;justify-content:center" aria-label="Toggle advanced mode">⚙</button>' +
        '</div>' +
        // STATE. colour dot + name on one line, NOT a big Cinzel headline
        '<div style="display:flex;align-items:center;gap:7px;margin-bottom:3px">' +
          '<span class="stateDot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#d4ad6a;box-shadow:0 0 8px #d4ad6a"></span>' +
          '<span class="stateName" style="font-size:13.5px;font-weight:700;color:#f4d49a;letter-spacing:.04em;text-transform:uppercase"></span>' +
        '</div>' +
        // Meaning. small body type
        '<div class="stateMeaning" style="font-size:11.5px;color:rgba(255,255,255,.72);line-height:1.35;margin-bottom:9px;min-height:1.35em"></div>' +
        // Gift meter
        '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">' +
          '<div style="font-size:9px;letter-spacing:.18em;color:rgba(212,173,106,.55);text-transform:uppercase;font-weight:600">Next gift</div>' +
          '<div class="giftpct" style="font-size:10px;color:rgba(244,212,154,.85);font-weight:600;font-variant-numeric:tabular-nums"></div>' +
        '</div>' +
        '<div style="height:3px;background:rgba(201,165,92,.15);border-radius:2px;overflow:hidden">' +
          '<div class="meter-fill" style="height:100%;width:0%;background:linear-gradient(90deg,#c9a55c,#f4d49a);transition:width .3s ease"></div>' +
        '</div>' +
        '<div class="tally" style="font-size:10px;letter-spacing:.01em;color:rgba(255,255,255,.5);margin-top:7px;min-height:1em"></div>' +
        '<div class="advancedBox" style="display:none;margin-top:8px;padding-top:8px;border-top:1px dashed rgba(212,173,106,.15);font-size:10px;color:rgba(255,255,255,.55);font-variant-numeric:tabular-nums">' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 10px">' +
            '<div>HR <span class="bhBpm" style="color:#ff8a7a;font-weight:600">. </span></div>' +
            '<div>HRV <span class="bhHrv" style="color:#80d0e0;font-weight:600">. </span></div>' +
            '<div>Focus <span class="bhFocus" style="color:#a3b8ff;font-weight:600">. </span></div>' +
            '<div>Calm <span class="bhCalm" style="color:#80d0e0;font-weight:600">. </span></div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(el);
      this._bioPillEl = el;
      // Restore advanced-mode pref from localStorage.
      this._advancedMode = localStorage.getItem("valhalla.advancedMode") === "1";
      const toggle = el.querySelector(".advancedToggle");
      toggle.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        this._advancedMode = !this._advancedMode;
        localStorage.setItem("valhalla.advancedMode", this._advancedMode ? "1" : "0");
        el.querySelector(".advancedBox").style.display = this._advancedMode ? "block" : "none";
        toggle.style.background = this._advancedMode ? "rgba(212,173,106,.3)" : "none";
      });
      if (this._advancedMode) {
        el.querySelector(".advancedBox").style.display = "block";
        toggle.style.background = "rgba(212,173,106,.3)";
      }
    }
    const live = document.body.classList.contains("bio-live");
    el.style.opacity = (live && this.running) ? "1" : "0";
    if (!live || !this.running) return;

    const s = this.bioSession;
    const cs = this.cognitiveState || "neutral";

    // STATE display. Viking-saga voice. Two REWARD states, two
    // NEUTRAL states, three PUNISH states. Loss aversion: stress and
    // panic actively cost the player (slower scoring, lost meters,
    // reduced gift cycle). Reward states give bonuses. The user only
    // sees the kenning name + one short consequence line, never
    // numbers (unless advanced mode is on).
    const STATE_UI = {
      flow:       { name: "DEEP FLOW",   meaning: "The path widens. Score swells, bosses bleed.",        colour: "#7ad9ff", penalty: false },
      focused:    { name: "KEEN EYE",    meaning: "Aim is true. Gifts come faster.",                      colour: "#a3b8ff", penalty: false },
      calm:       { name: "STILL WATER", meaning: "The breath holds steady. The gods watch and approve.", colour: "#80d0e0", penalty: false },
      meditation: { name: "DEEP HALL",   meaning: "The road slows for you. Hazards softer.",              colour: "#c5a3ff", penalty: false },
      berserker:  { name: "BLOOD-WROTH", meaning: "Fury wakes. Score doubles, boss-iron yields.",         colour: "#ff8c5a", penalty: false },
      aroused:    { name: "QUICKENED",   meaning: "Pulse climbs. Speed rises, hazards bite harder.",      colour: "#ffaa70", penalty: false },
      frantic:    { name: "STORM-HEART", meaning: "Heart races. Each point counts double, but watch the road.", colour: "#ff7060", penalty: false },
      stress:     { name: "WOLF-WORRY",  meaning: "The wolf in your chest. Gift-meter falls back.",       colour: "#c84030", penalty: true },
      fatigue:    { name: "OAR-WEARY",   meaning: "Your blood runs slow. Multiplier weakens.",            colour: "#7a5040", penalty: true },
      distracted: { name: "WIND-MINDED", meaning: "Thought scatters. No gifts find you yet.",             colour: "#998a78", penalty: true },
      neutral:    { name: "WALKING",     meaning: "Find calm or sharp mind. Gifts answer both.",          colour: "#d4ad6a", penalty: false },
    };
    const warming = !live || (!this.bpm && cs === "neutral");
    const ui = warming
      ? { name: "READING", meaning: "The gods are taking your measure. Sit still. Face the light.", colour: "#d4ad6a", penalty: false }
      : (STATE_UI[cs] || STATE_UI.neutral);

    const stateEl = el.querySelector(".stateName");
    stateEl.textContent = ui.name;
    stateEl.style.color = ui.colour;
    const dotEl = el.querySelector(".stateDot");
    if (dotEl) {
      dotEl.style.background = ui.colour;
      dotEl.style.boxShadow = `0 0 8px ${ui.colour}`;
    }
    el.querySelector(".stateMeaning").textContent = ui.meaning;

    // Gift meter.
    const pct = Math.min(100, (s.giftAccumSec / 12) * 100);
    el.querySelector(".meter-fill").style.width = pct + "%";
    el.querySelector(".giftpct").textContent = (pct | 0) + "%";

    // Tally.
    const tallyParts = [];
    if (s.giftsEarned)          tallyParts.push("🎁 " + s.giftsEarned);
    if (s.durationBonusApplied) tallyParts.push("⏱ " + s.durationBonusApplied);
    if (s.flowSec >= 1)         tallyParts.push("🌊 " + s.flowSec.toFixed(0) + "s");
    el.querySelector(".tally").textContent = tallyParts.length
      ? "Earned: " + tallyParts.join(" · ")
      : "Hold a state to earn rewards";

    // ADVANCED NUMBERS. only update if visible.
    if (this._advancedMode) {
      const bhBpm = el.querySelector(".bhBpm");
      const bhHrv = el.querySelector(".bhHrv");
      const bhFocus = el.querySelector(".bhFocus");
      const bhCalm = el.querySelector(".bhCalm");
      bhBpm.textContent   = this.bpm ? Math.round(this.bpm) : ". ";
      bhHrv.textContent   = this.hrv != null ? Math.round(this.hrv) + "ms" : ". ";
      bhFocus.textContent = (this.focusLevel != null) ? Math.round(this.focusLevel * 100) + "%" : ". ";
      bhCalm.textContent  = (this.calmLevel != null)  ? Math.round(this.calmLevel * 100) + "%"  : ". ";
    }
  }

  // WORLD-SPACE MARKERS. HTML icons projected to the screen
  // position of every active obstacle/powerup/mead/rune so the
  // player CANNOT confuse them. Bypasses all the 3D shader
  // ambiguity that's been confusing the user for many rounds.
  //   ⚠ red over dangers
  //   ⭐ gold over powerups (with god initial)
  //   🪙 over mead
  //   ᚱ blue over runestones
  // Reuses a pool of div nodes keyed by stable obstacle/collectible
  // index so we don't thrash the DOM.
  _updateWorldMarkers(dt) {
    const host = document.getElementById("worldMarkers");
    if (!host) return;
    if (!this.running) {
      // Clear all on menu/over so they don't ghost.
      if (host.children.length) host.innerHTML = "";
      return;
    }
    const W = window.innerWidth, H = window.innerHeight;
    const cam = this.camera;
    // Build a list of (worldPos, label, color, key) for each thing.
    const items = [];
    const tmp = this._mkTmp || (this._mkTmp = new THREE.Vector3());

    const POW_INITIAL = { shield:"T", speed:"S", mult:"B", magnet:"F",
                          ship:"S", thor:"M", odin:"O" };

    // CLUTTER PASS. previously every visible obstacle and collectible
    // got an emoji marker, turning the screen into an arcade UI ribbon.
    // First-principles: markers only earn their place when the 3D
    // silhouette is genuinely ambiguous. So we now show only:
    //   * Boss-encounter obstacles (the player NEEDS to know to dodge
    //     these to damage the boss. context matters)
    //   * Powerups (the unique visual that's hardest to parse at speed . 
    //     the player must distinguish god-gift powerups from mead/runes)
    //   * Runestones during an active boss fight (they're the ranged attack)
    // Regular obstacles + mead + non-fight runes get NO marker; the
    // 3D shapes are clear enough.
    const inFight = this._bossActor && !this._bossActor.defeated && !this._bossActor.escaped;
    for (let i = 0; i < this.obstacles.length; i++) {
      const o = this.obstacles[i];
      if (o._consumed) continue;
      const sz = o.spawnAt - this.distance;
      if (sz < 4 || sz > 60) continue;
      // Only mark boss-encounter obstacles. Regular hazards: 3D is enough.
      if (!o.encounterBoss) continue;
      const lane = o.lane === -1 ? this.lane : o.lane;
      items.push({
        x: LANES[lane], y: (o.h || 2) + 0.6, z: sz,
        text: "⚠", color: "#ff3030", key: "o" + i,
        bg: "rgba(60,8,8,.85)", size: 22,
      });
    }
    for (let i = 0; i < this.collectibles.length; i++) {
      const c = this.collectibles[i];
      const sz = c.spawnAt - this.distance;
      if (sz < 4 || sz > 60) continue;
      // Mead never gets a marker. gold horns are obvious.
      if (c.type === "mead") continue;
      // Runes only when there's a boss fight (they're the attack).
      if (c.type === "rune" && !inFight) continue;
      let text = "ᚱ", color = "#60d0ff", bg = "rgba(10,30,50,.85)", size = 22;
      if (c.type === "powerup") { text = POW_INITIAL[c.pwType] || "⭐"; color = "#ffd066"; bg = "rgba(50,38,10,.92)"; size = 24; }
      items.push({
        x: LANES[c.lane], y: (c.baseY || 1.2) + 1.0, z: sz,
        text, color, key: "c" + i, bg, size,
      });
    }

    // Sync DOM children to items. Simple "wipe and rebuild". fewer
    // than ~15 markers at any time so the cost is negligible.
    let html = "";
    for (const it of items) {
      tmp.set(it.x, it.y, it.z + this.distance);
      // Distance-from-player so we can scale further markers down.
      const distFromPlayer = it.z;
      tmp.project(cam);
      // Cull anything off-screen or behind the camera.
      if (tmp.z > 1 || tmp.x < -1.05 || tmp.x > 1.05 || tmp.y < -1.05 || tmp.y > 1.05) continue;
      const sx = (tmp.x * 0.5 + 0.5) * W;
      const sy = (-tmp.y * 0.5 + 0.5) * H;
      // Scale size with distance. closer markers are bigger.
      const scale = Math.max(0.55, Math.min(1, 25 / Math.max(8, distFromPlayer)));
      const fontSize = (it.size * scale) | 0;
      html += `<div style="position:absolute;left:${sx | 0}px;top:${sy | 0}px;`
            + `transform:translate(-50%,-100%);`
            + `background:${it.bg};color:${it.color};`
            + `font:700 ${fontSize}px/1 'Cinzel',serif;`
            + `padding:4px 9px;border-radius:6px;`
            + `border:1px solid ${it.color}80;`
            + `text-shadow:0 0 6px ${it.color}80;`
            + `white-space:nowrap;pointer-events:none">`
            + it.text + `</div>`;
    }
    host.innerHTML = html;
  }

  // Breath puffs. emit one new particle ~every 0.6s from the
  // player's "mouth" (y ≈ 1.7 in player-local space, slightly forward).
  // Each particle ages over ~1.4s: rises, drifts back, expands, fades.
  // 24 particles in a ring buffer; reuse the slot once a particle dies.
  _updateBreath(dt) {
    const b = this._breath;
    if (!b || !this.running) return;
    const pos = b.points.geometry.attributes.position;
    const life = b.life;
    b.lastEmit += dt;
    // Emit faster when sprint / higher HR. breathing harder.
    const interval = 0.55 / Math.max(0.7, this.speed / BASE_SPEED);
    if (b.lastEmit >= interval) {
      b.lastEmit = 0;
      for (let i = 0; i < life.length; i++) {
        if (life[i] < 0) {
          // Player-local emission point: slightly left/right of mouth.
          const ox = (Math.random() - 0.5) * 0.10;
          const oy = 1.72 + (Math.random() - 0.5) * 0.04;
          const oz = 0.30 + Math.random() * 0.06;
          pos.setXYZ(i, ox, oy, oz);
          life[i] = 1;
          break;
        }
      }
    }
    // Age + animate all active particles.
    for (let i = 0; i < life.length; i++) {
      if (life[i] < 0) continue;
      life[i] -= dt * 0.7;       // ~1.4s lifetime
      if (life[i] < 0) {
        pos.setXYZ(i, 0, -100, 0);  // hide
        continue;
      }
      // Drift up + back (away from camera which is behind player).
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      pos.setXYZ(i, x, y + dt * 0.6, z - dt * 1.2);
    }
    pos.needsUpdate = true;
    // Material opacity fades the whole cloud out gently.
    b.points.material.opacity = 0.6;
  }

  // Ease bio aura colour + opacity toward targets each frame so state
  // changes feel like a breath, not a flicker. Called from _update.
  _updateBioAura(dt) {
    if (!this._bioAura) return;
    const mat = this._bioAura.material;
    // Opacity ease.
    mat.opacity += (this._bioAuraTargetOpacity - mat.opacity) * Math.min(1, dt * 3);
    // Colour ease. Color.lerp gives perceptual mid-tones.
    mat.color.lerp(this._bioAuraTargetColor, Math.min(1, dt * 2.5));
    // Subtle breathing pulse at ~0.4 Hz so the aura feels alive.
    if (this._bioAuraTargetOpacity > 0.01) {
      const pulse = 1 + Math.sin(performance.now() * 0.0025) * 0.06;
      this._bioAura.scale.setScalar(pulse);
    }
  }

  _popText(text, cls = "", offsetX = 0, offsetY = 0) {
    const el = document.createElement("div");
    el.className = "popper " + cls;
    el.textContent = text;
    const v = new THREE.Vector3(this.player.position.x, 1.6 + this.playerY, this.player.position.z + 1);
    v.project(this.camera);
    const sx = (v.x * 0.5 + 0.5) * window.innerWidth + offsetX;
    const sy = (-v.y * 0.5 + 0.5) * window.innerHeight + offsetY;
    el.style.left = sx + "px";
    el.style.top = sy + "px";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }

  _showCombo() {
    if (this.combo < 2) { this.hud.combo.classList.remove("show"); return; }
    this.hud.comboN.textContent = this.combo;
    this.hud.combo.classList.remove("show");
    void this.hud.combo.offsetWidth; // reflow to retrigger animation
    this.hud.combo.classList.add("show");
  }

  _shake(amp = 0.4, dur = 0.25) {
    this._shakeAmp = Math.max(this._shakeAmp, amp);
    this._shakeT = Math.max(this._shakeT, dur);
  }

  _slowMo(scale = 0.35, dur = 0.7) {
    this._timeScaleTarget = scale;
    this.hud.vignette.classList.add("on");
    clearTimeout(this._slowMoT);
    this._slowMoT = setTimeout(() => {
      this._timeScaleTarget = 1;
      this.hud.vignette.classList.remove("on");
    }, dur * 1000);
  }

  // Powerups -----------------------------------------------------------
  // Each "powerup" is a blessing from a Norse god. Internal slot names
  // (shield, speed, mult, magnet, ship, thor, odin) stay terse for the
  // game loop; user-facing names are the gods/relics themselves.
  _activatePowerup(type, duration) {
    // BIO DURATION BONUS: if the player is in flow/focused/calm
    // when they pick up a gift, the god honours the steady mind
    // with a +50% duration extension. Direct, visible bio benefit:
    // the same Mjölnir lasts 4.5s normally but 6.75s if you grabbed
    // it in Flow. End-of-run report tallies how many times this fired.
    const bonusStates = { flow: 1.5, focused: 1.35, calm: 1.20 };
    const bonus = bonusStates[this.cognitiveState];
    let actualDuration = duration;
    if (bonus) {
      actualDuration = duration * bonus;
      if (this.bioSession) this.bioSession.durationBonusApplied++;
      this._popText("EXTENDED +" + Math.round((bonus - 1) * 100) + "%", "rune", 0, 30);
    }
    this.power[type] = actualDuration;
    const labels = {
      shield: "TYR'S AEGIS",
      speed:  "SLEIPNIR",
      mult:   "BRAGI'S SAGA",
      magnet: "FREJA'S TEARS",
      ship:   "SKÍÐBLAÐNIR",
      thor:   "MJÖLNIR",
      odin:   "HUGINN & MUNINN",
    };
    const SUBTITLES = {
      shield: "Tyr shields you · " + actualDuration.toFixed(1) + "s",
      speed:  "Sleipnir's gallop · " + actualDuration.toFixed(1) + "s",
      mult:   "Sagas double your glory · " + actualDuration.toFixed(1) + "s",
      magnet: "Gold pulls to you · " + actualDuration.toFixed(1) + "s",
      ship:   "Freyr's longship · " + actualDuration.toFixed(1) + "s",
      thor:   "Lightning clears your path · " + actualDuration.toFixed(1) + "s",
      odin:   "Time bends to foresight · " + actualDuration.toFixed(1) + "s",
    };
    const HEX_FOR = {
      shield: 0xc8a040, speed: 0xc8d8e8, mult: 0xffd066, magnet: 0xff6090,
      ship: 0xc04020, thor: 0x9ec0ff, odin: 0xa8b0d0,
    };
    const SOUND_FOR = {
      shield: "tyr", speed: "sleipnir", mult: "bragi", magnet: "freja",
      ship: "skidbladnir", thor: "mjolnir", odin: "odin",
    };
    this.audio.power(SOUND_FOR[type] || "tyr");

    // BIG centre-screen celebration on pickup. The user asked for
    // "powerups should be visible upon claiming". Show the god's
    // name MASSIVE in their colour, with a subtitle saying what
    // it does and for how long. Plus a brief full-screen colour
    // flash matching the god, plus a camera punch. Unmissable.
    this._showPickupCelebration(labels[type] || type, SUBTITLES[type] || "", HEX_FOR[type] || 0xc9a55c);
    this._shake(0.35, 0.25);

    // Visual side-effects on activate.
    if (type === "ship") this._mountLongship();
    else if (type === "shield") this._addShieldGlow();
    else if (type === "thor") this._addThorAura();
    else if (type === "odin") {
      this._addOdinRavens();
      this._slowMo(0.55, actualDuration);
    }
    this._renderPowerHudOnce();
  }

  // Centre-screen god-pickup celebration. Builds the overlay once,
  // re-uses on every pickup. Massive Cinzel name + subtitle, fades in
  // and out over 1.8s. Saturated tint matches the god's halo colour.
  _showPickupCelebration(name, subtitle, accentHex) {
    let el = this._pickupEl;
    if (!el) {
      el = document.createElement("div");
      el.style.cssText =
        "position:fixed;top:38%;left:50%;transform:translate(-50%,-50%);" +
        "z-index:55;pointer-events:none;text-align:center;" +
        "opacity:0;transition:opacity .35s ease,transform .35s ease;" +
        "text-shadow:0 4px 36px rgba(0,0,0,.85),0 0 60px currentColor;";
      el.innerHTML = `<div class="pn" style="font:700 64px/1 'Cinzel',serif;letter-spacing:.10em;text-transform:uppercase;margin-bottom:18px"></div>
                      <div class="ps" style="font:500 14px/1.4 'Cinzel',serif;letter-spacing:.20em;text-transform:uppercase;opacity:.85"></div>`;
      document.body.appendChild(el);
      this._pickupEl = el;
    }
    const css = "#" + ("000000" + accentHex.toString(16)).slice(-6);
    el.querySelector(".pn").textContent = name;
    el.querySelector(".ps").textContent = subtitle;
    el.style.color = css;
    el.style.opacity = "1";
    el.style.transform = "translate(-50%,-50%) scale(1)";
    clearTimeout(this._pickupT);
    this._pickupT = setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translate(-50%,-50%) scale(1.08)";
    }, 1500);
    // Brief screen flash in the god's colour.
    if (this._bioStateFlash) this._bioStateFlash(accentHex);
  }

  _onPowerupEnd(type) {
    if (type === "ship") this._dismountLongship();
    if (type === "shield") this._removeShieldGlow();
    if (type === "thor")   this._removeThorAura();
    if (type === "odin")   this._removeOdinRavens();
    this._renderPowerHudOnce();
  }

  // Thor's hammer aura: floating Mjölnir + crackling lightning bolts.
  _addThorAura() {
    if (this._thorAura) return;
    const group = new THREE.Group();
    // Mjölnir head: short flat box.
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.32, 0.30),
      new THREE.MeshStandardMaterial({
        color: 0x808890, roughness: 0.4, metalness: 0.9,
        emissive: 0x6080ff, emissiveIntensity: 0.6, flatShading: true,
      })
    );
    head.position.y = 0.3;
    group.add(head);
    // Short handle below head.
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.07, 0.55, 8),
      new THREE.MeshStandardMaterial({ color: 0x4a2810, roughness: 0.9, flatShading: true })
    );
    handle.position.y = -0.05;
    group.add(handle);
    // Lightning "sparks". four thin emissive boxes that we'll spin per frame.
    const sparks = [];
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.7, 0.04),
        new THREE.MeshBasicMaterial({
          color: 0xc0d8ff, transparent: true, opacity: 0.85,
          depthWrite: false,
        })
      );
      s.userData.phase = i * Math.PI / 2;
      group.add(s);
      sparks.push(s);
    }
    group.position.y = 2.6;
    this.player.add(group);
    this._thorAura = { group, sparks, t: 0 };
  }
  _removeThorAura() {
    if (!this._thorAura) return;
    this.player.remove(this._thorAura.group);
    this._thorAura = null;
  }

  // Odin's ravens: Huginn (thought) + Muninn (memory) circle the player's
  // head. Cheap diamond silhouettes. black with very subtle gold rim.
  _addOdinRavens() {
    if (this._odinRavens) return;
    const group = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const bird = new THREE.Group();
      // Body
      const body = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.16, 0),
        new THREE.MeshStandardMaterial({
          color: 0x121418, roughness: 0.7,
          emissive: 0x40484a, emissiveIntensity: 0.4, flatShading: true,
        })
      );
      bird.add(body);
      // Wings. two thin planes that flap on the wing axis.
      for (const side of [-1, 1]) {
        const wing = new THREE.Mesh(
          new THREE.PlaneGeometry(0.30, 0.10),
          new THREE.MeshStandardMaterial({
            color: 0x0a0c10, roughness: 0.9, side: THREE.DoubleSide, flatShading: true,
          })
        );
        wing.position.x = side * 0.18;
        wing.userData.side = side;
        bird.add(wing);
      }
      bird.userData.phase = i * Math.PI;
      group.add(bird);
    }
    group.position.y = 2.4;
    this.player.add(group);
    this._odinRavens = { group, t: 0 };
  }
  _removeOdinRavens() {
    if (!this._odinRavens) return;
    this.player.remove(this._odinRavens.group);
    this._odinRavens = null;
  }

  // Lightning strike at a world position. vertical jagged beam that
  // flashes white-blue then fades over ~0.35s. Used by Mjölnir to
  // visualise each auto-strike. Cheap two-segment plane, no shaders.
  _lightningStrike(worldPos, lane) {
    const bolt = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xeaf0ff, transparent: true, opacity: 1.0, depthWrite: false,
    });
    // Two stacked thin tall planes, slightly offset & rotated for "jagged" feel.
    for (let i = 0; i < 2; i++) {
      const seg = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 6), mat.clone());
      seg.position.y = 3 + (i === 1 ? 0.3 : 0);
      seg.position.x = i === 1 ? 0.18 : -0.06;
      seg.rotation.z = (i === 0 ? -0.12 : 0.18);
      bolt.add(seg);
    }
    bolt.position.set(LANES[lane], 0, worldPos.z);
    this.scene.add(bolt);
    // Fade + remove.
    const start = performance.now();
    const fade = () => {
      const t = (performance.now() - start) / 350;
      if (t >= 1) { this.scene.remove(bolt); return; }
      for (const seg of bolt.children) seg.material.opacity = 1 - t;
      requestAnimationFrame(fade);
    };
    requestAnimationFrame(fade);
    if (this.audio) this.audio.thunderTick();
    this._shake(0.2, 0.12);
  }

  // Per-frame god-power visual update. spin Mjölnir sparks, orbit ravens.
  // Called from _update with the time-scaled dt.
  _updateGodPowers(dt) {
    if (this._thorAura) {
      this._thorAura.t += dt;
      this._thorAura.group.rotation.y = this._thorAura.t * 4;
      // Each spark sweeps around the hammer head with a flicker.
      for (const s of this._thorAura.sparks) {
        const p = this._thorAura.t * 6 + s.userData.phase;
        s.position.set(Math.cos(p) * 0.55, 0.3, Math.sin(p) * 0.55);
        s.rotation.z = p;
        s.material.opacity = 0.55 + Math.random() * 0.45;
      }
    }
    if (this._odinRavens) {
      this._odinRavens.t += dt;
      const t = this._odinRavens.t;
      const birds = this._odinRavens.group.children;
      for (let i = 0; i < birds.length; i++) {
        const b = birds[i];
        const ang = t * 1.8 + b.userData.phase;
        b.position.set(Math.cos(ang) * 1.2, Math.sin(t * 2 + i) * 0.15, Math.sin(ang) * 1.2);
        b.rotation.y = -ang + Math.PI / 2;
        // Flap wings. children index 1+ are wings.
        for (let w = 1; w < b.children.length; w++) {
          const wing = b.children[w];
          if (wing.userData.side !== undefined) {
            wing.rotation.y = wing.userData.side * (0.5 + Math.sin(t * 18 + i) * 0.6);
          }
        }
      }
    }
  }

  _addShieldGlow() {
    if (this._shieldGlow) return;
    const g = new THREE.Mesh(
      new THREE.SphereGeometry(1.6, 18, 12),
      new THREE.MeshBasicMaterial({
        color: 0x6ab0ff, transparent: true, opacity: 0.18,
        depthWrite: false, side: THREE.BackSide,
      })
    );
    g.position.y = 1.1;
    this.player.add(g);
    this._shieldGlow = g;
  }
  _removeShieldGlow() {
    if (this._shieldGlow) { this.player.remove(this._shieldGlow); this._shieldGlow = null; }
  }

  // Build a small longship under the player (longship powerup).
  _mountLongship() {
    if (this._longship) return;
    const ship = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 0.6, 1.3),
      new THREE.MeshStandardMaterial({ color: 0x4a2a14, roughness: 0.85, flatShading: true })
    );
    hull.position.y = -0.4;
    ship.add(hull);
    // Bow and stern lift the hull at the ends
    for (const sign of [-1, 1]) {
      const tip = new THREE.Mesh(
        new THREE.ConeGeometry(0.55, 0.9, 4),
        new THREE.MeshStandardMaterial({ color: 0x4a2a14, roughness: 0.9, flatShading: true })
      );
      tip.position.set(sign * 1.65, -0.1, 0);
      tip.rotation.z = sign * Math.PI / 2;
      ship.add(tip);
      // Dragon head
      const head = new THREE.Mesh(
        new THREE.ConeGeometry(0.18, 0.4, 4),
        new THREE.MeshStandardMaterial({ color: 0x6e2018, flatShading: true, emissive: 0x401004, emissiveIntensity: 0.4 })
      );
      head.position.set(sign * 2.0, 0.35, 0);
      head.rotation.z = sign * Math.PI / 2;
      ship.add(head);
    }
    // Striped sail above
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6),
      new THREE.MeshStandardMaterial({ color: 0x2a1a10 })
    );
    mast.position.y = 1.1;
    ship.add(mast);
    for (let i = 0; i < 4; i++) {
      const stripe = new THREE.Mesh(
        new THREE.PlaneGeometry(2.0, 0.4),
        new THREE.MeshStandardMaterial({
          color: i % 2 === 0 ? 0xd8d4c4 : 0xb83020,
          side: THREE.DoubleSide, roughness: 0.9,
        })
      );
      stripe.position.set(0, 0.5 + i * 0.4, 0);
      stripe.rotation.y = Math.PI / 2;
      ship.add(stripe);
    }
    ship.position.copy(this.player.position);
    this.scene.add(ship);
    this._longship = ship;
    // Lift the player off the ground while riding
    this._shipLift = 1.6;
  }
  _dismountLongship() {
    if (this._longship) { this.scene.remove(this._longship); this._longship = null; }
    this._shipLift = 0;
  }

  // HUD power strip ------------------------------------------------------
  _renderPowerHudOnce() {
    const host = $("powerHud");
    if (!host) return;
    const labels = {
      shield: "Tyr's Aegis",       speed:  "Sleipnir",
      mult:   "Bragi's Saga",      magnet: "Freja's Tears",
      ship:   "Skíðblaðnir",       thor:   "Mjölnir",
      odin:   "Huginn & Muninn",
    };
    const colors = {
      shield: "#c8a040",  speed:  "#c8d8e8",
      mult:   "#ffd066",  magnet: "#ff6090",
      ship:   "#c04020",  thor:   "#9ec0ff",
      odin:   "#a8b0d0",
    };
    host.innerHTML = "";
    for (const k of Object.keys(this.power)) {
      if (this.power[k] <= 0) continue;
      const div = document.createElement("div");
      div.className = "power-pill";
      div.dataset.kind = k;
      div.style.borderColor = colors[k];
      div.innerHTML = `<span class="pwlabel" style="color:${colors[k]}">${labels[k]}</span>
        <span class="pwbar"><span class="pwfill" style="background:${colors[k]}"></span></span>`;
      host.appendChild(div);
    }
  }
  _updatePowerHud(dt) {
    const host = $("powerHud");
    if (!host) return;
    let needsRender = false;
    for (const pill of host.children) {
      const k = pill.dataset.kind;
      if (!this.power[k] || this.power[k] <= 0) { needsRender = true; break; }
      const fill = pill.querySelector(".pwfill");
      const max = this.powerMax[k] || 5;
      fill.style.width = `${Math.max(0, Math.min(1, this.power[k] / max)) * 100}%`;
    }
    const activeKeys = Object.keys(this.power).filter(k => this.power[k] > 0);
    if (activeKeys.length !== host.children.length) needsRender = true;
    if (needsRender) this._renderPowerHudOnce();
  }

  _doAction(action) {
    if (this.over || !this.running) return;
    switch (action) {
      case "left":
        if (this.lane > 0) { this.lane--; this.targetLaneX = LANES[this.lane]; this.audio.laneChange(); }
        break;
      case "right":
        if (this.lane < 2) { this.lane++; this.targetLaneX = LANES[this.lane]; this.audio.laneChange(); }
        break;
      case "jump":
        if (this.playerY <= 0.001 && !this.sliding) {
          this.playerVy = JUMP_VELOCITY; this.audio.jump();
        }
        break;
      case "slide":
        if (this.playerY <= 0.001 && !this.sliding) {
          this.sliding = true; this.slideTimer = SLIDE_DURATION;
          this.audio.slide();
        }
        break;
    }
  }

  _togglePause() {
    if (!this.running || this.over) return;
    this.paused = !this.paused;
    this.hud.pauseOverlay.classList.toggle("on", this.paused);
  }

  _bindInput() {
    const keys = new Set();
    const keyToAction = {
      "a": "left", "arrowleft": "left",
      "d": "right", "arrowright": "right",
      "w": "jump", "arrowup": "jump", " ": "jump",
      "s": "slide", "arrowdown": "slide",
    };
    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright", "tab"].includes(k)) e.preventDefault();
      if (k === "tab") { this._toggleInfoPanel(); return; }
      if (keys.has(k)) return;
      keys.add(k);
      if (k === "shift") { this.sprint = true; return; }
      if (k === "p") { this._togglePause(); return; }
      if (k === "m") { this.audio.setMuted(!this.audio.muted); return; }
      // ~ or ` shows the FPS overlay (debug / perf-investigation aid)
      if (k === "~" || k === "`") { this._toggleFpsOverlay(); return; }
      const a = keyToAction[k];
      if (a) this._doAction(a);
    });
    window.addEventListener("keyup", (e) => {
      const k = e.key.toLowerCase();
      keys.delete(k);
      if (k === "shift") this.sprint = false;
    });

    // Touch swipe on the canvas area (avoid swallowing button taps)
    let tx = 0, ty = 0, td = 0;
    const canvas = this.canvas;
    canvas.addEventListener("touchstart", (e) => {
      tx = e.touches[0].clientX; ty = e.touches[0].clientY; td = performance.now();
    }, { passive: true });
    canvas.addEventListener("touchend", (e) => {
      const dx = e.changedTouches[0].clientX - tx;
      const dy = e.changedTouches[0].clientY - ty;
      if (Math.abs(dx) < 18 && Math.abs(dy) < 18 && performance.now() - td < 250) {
        // Tap: left half = left lane, right half = right lane, center = jump
        const w = window.innerWidth;
        if (tx < w * 0.33) this._doAction("left");
        else if (tx > w * 0.67) this._doAction("right");
        else this._doAction("jump");
      } else if (Math.abs(dx) > Math.abs(dy)) {
        this._doAction(dx > 0 ? "right" : "left");
      } else {
        this._doAction(dy > 0 ? "slide" : "jump");
      }
    }, { passive: true });

    // On-screen mobile buttons. Bind pointerdown for instant response.
    const isTouch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
    if (isTouch || window.innerWidth < 720) this.hud.touch.classList.add("on");
    for (const b of this.hud.touch.querySelectorAll(".b")) {
      const action = b.dataset.key;
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this._doAction(action);
        b.style.background = "rgba(255,255,255,.25)";
        setTimeout(() => (b.style.background = ""), 100);
      });
    }

    $("beginBtn").addEventListener("click", () => this._begin());
    // Second Run button at the bottom of the menu (below leaderboard/honours).
    const beginBtn2 = document.getElementById("beginBtn2");
    if (beginBtn2) beginBtn2.addEventListener("click", () => this._begin());
    $("againBtn").addEventListener("click", () => { $("overOverlay").classList.remove("show"); this._begin(); });
    $("resumeBtn").addEventListener("click", () => this._togglePause());
    // SHARE RUN. generate a canvas image of the last run summary and
    // either open native share sheet (mobile) or download the PNG.
    const shareBtn = document.getElementById("shareRunBtn");
    if (shareBtn) shareBtn.addEventListener("click", () => this._shareRun());

    // Menu accordion tabs (BIND BODY / SAGA SO FAR). Mutually exclusive.
    // Re-clicking the active tab collapses both. Compact menu instead
    // of the giant always-on bio + trends block.
    const tabS = document.getElementById("tabSensors");
    const tabT = document.getElementById("tabTrends");
    const pS = document.getElementById("panelSensors");
    const pT = document.getElementById("panelTrends");
    // Old tab system is hidden in the DOM compatibility shim now;
    // it's replaced by the bottom sheets opened from the hero.
    void tabS; void tabT; void pS; void pT;

    // BOTTOM SHEET OPEN/CLOSE wiring. One backdrop, three sheets.
    // Spring-feel transitions defined in CSS.
    const backdrop = document.getElementById("sheetBackdrop");
    const sheets = {
      saga: document.getElementById("sheetSaga"),
      body: document.getElementById("sheetBody"),
      help: document.getElementById("sheetHelp"),
    };
    const openSheet = (key) => {
      // Close any open sheet first.
      for (const k of Object.keys(sheets)) {
        if (sheets[k]) sheets[k].classList.remove("open");
      }
      if (!sheets[key]) return;
      sheets[key].classList.add("open");
      if (backdrop) backdrop.classList.add("open");
      // Populate dynamic content on open so it's always fresh.
      if (key === "saga") this._renderSagaSheet();
    };
    const closeAllSheets = () => {
      for (const k of Object.keys(sheets)) {
        if (sheets[k]) sheets[k].classList.remove("open");
      }
      if (backdrop) backdrop.classList.remove("open");
    };
    const wireOpen = (btnId, sheetKey) => {
      const b = document.getElementById(btnId);
      if (b) b.addEventListener("click", () => openSheet(sheetKey));
    };
    wireOpen("openSagaSheet", "saga");
    wireOpen("openBodySheet", "body");
    wireOpen("openHelpSheet", "help");
    if (backdrop) backdrop.addEventListener("click", closeAllSheets);
    // ALL elements with data-close-sheet close any open sheet.
    document.querySelectorAll("[data-close-sheet]").forEach(el => {
      el.addEventListener("click", closeAllSheets);
    });
    // ESC also closes.
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAllSheets();
    });

    // Sync dialog wiring + initial state. Auto-pull from cloud on
    // boot if the host provides ElataSync; otherwise just show local
    // identity. tryRestoreFromUrl is called first so a #save=… link
    // takes precedence over the device's local save before any cloud
    // pull can overwrite it.
    // Each of these is wrapped so a single failure (broken DOM ref,
    // missing localStorage, etc) can't kill the whole boot path.
    // Before this, an undefined I18N_DICT was throwing in
    // _wireSyncDialog and silently killing everything that followed,
    // including saved-state restore and cloud sync init.
    try { this._wireSyncDialog(); } catch (e) { console.warn("[boot] wireSyncDialog failed", e); }
    try { Store.tryRestoreFromUrl(); } catch (e) { console.warn("[boot] tryRestoreFromUrl failed", e); }
    try { this._refreshSkaldLine(); } catch (e) { console.warn("[boot] refreshSkaldLine failed", e); }
    try { this._bootCloudSync(); } catch (e) { console.warn("[boot] bootCloudSync failed", e); }
    try { this._scheduleNextReminder(); } catch (e) { console.warn("[boot] scheduleNextReminder failed", e); }
    try { this._applyI18n(); } catch (e) { console.warn("[boot] applyI18n failed", e); }
    setTimeout(() => { try { this._applyGear(); } catch (e) { console.warn("[boot] applyGear failed", e); } }, 1500);

    // Bio buttons live-mirror sensor status. Previous version was a one-
    // shot setter: button said "On" forever based on the start() return,
    // even after the sensor went to error / off. That caused the
    // "camera turned off automatically" complaint. the chip in the HUD
    // updated correctly but the menu button kept lying. Now the button
    // text is driven by the actual sensor state via the Bio event bus.
    const wireBioBtn = (btn, key) => {
      if (!btn) return;
      const originalText = btn.textContent;
      // Cached message so a status="off" event after a known error keeps
      // the error text visible until the auto-reset fires.
      let lastErrorMsg = null;

      const setVisualState = (status, detail) => {
        btn.classList.remove("error", "live", "warming");
        switch (status) {
          case "live":
            btn.textContent = "On";
            btn.classList.add("live");
            btn.disabled = false;
            btn.title = detail || "Live";
            lastErrorMsg = null;
            break;
          case "warming":
            btn.textContent = key === "eeg" ? "Pairing…" : "Warming…";
            btn.classList.add("warming");
            btn.disabled = true;
            btn.title = detail || "Warming up";
            lastErrorMsg = null;
            break;
          case "error": {
            const msg = detail || "Failed";
            btn.textContent = msg.length > 32 ? msg.slice(0, 30) + "…" : msg;
            btn.title = msg;
            btn.classList.add("error");
            btn.disabled = false;
            lastErrorMsg = msg;
            // Auto-restore to "Enable" after 6s so retry is one click.
            setTimeout(() => {
              if (btn.classList.contains("error") && lastErrorMsg === msg) {
                btn.textContent = originalText;
                btn.classList.remove("error");
                btn.title = "";
                lastErrorMsg = null;
              }
            }, 6000);
            break;
          }
          case "unsupported":
            btn.textContent = "Unavailable";
            btn.classList.add("error");
            btn.disabled = true;
            btn.title = detail || "Not supported in this browser";
            break;
          default:
            // "off". only revert if we don't have an active error message
            if (!lastErrorMsg) {
              btn.textContent = originalText;
              btn.disabled = false;
              btn.title = "";
            }
        }
      };

      // Subscribe to live status events the moment Bio is ready, so the
      // button keeps mirroring sensor state for the whole session.
      const subscribe = () => {
        if (!window.Bio) return false;
        window.Bio.on(`${key === "rppg" ? "rppg" : "eeg"}Status`, ({ status, detail }) => {
          setVisualState(status, detail);
        });
        // Reflect any state the sensor is already in (e.g. if Bio booted
        // mid-stream from a previous session).
        const s = window.Bio.status?.()?.[key];
        if (s) setVisualState(s);
        return true;
      };
      if (!subscribe()) window.addEventListener("bio:ready", subscribe, { once: true });

      btn.addEventListener("click", async () => {
        if (!window.Bio) {
          btn.textContent = "Unavailable";
          this._showBioErrorBanner("Bio module didn't load. Refresh the page once.");
          return;
        }
        if (btn.classList.contains("live")) {
          try {
            if (key === "rppg") await window.Bio.stopRppg();
            else                await window.Bio.stopEeg();
          } catch (e) { console.warn("[Valhalla] bio stop threw", e); }
          return;
        }
        const opts = {}; opts[key] = true;
        setVisualState("warming");
        try {
          const r = await window.Bio.start(opts);
          const result = r[key];
          if (!(result && result.ok !== false)) {
            const msg = result?.message || result?.reason || "Failed";
            setVisualState("error", msg);
            this._showBioErrorBanner(`${key === "rppg" ? "Webcam" : "Muse"} could not start: ${msg}`);
          }
        } catch (e) {
          console.warn("[Valhalla] bio start threw", e);
          setVisualState("error", e?.message || "Failed");
          this._showBioErrorBanner(`${key === "rppg" ? "Webcam" : "Muse"} threw: ${e?.message || "unknown error"}`);
        }
      });
    };
    wireBioBtn($("bioHrBtn"), "rppg");
    wireBioBtn($("bioEegBtn"), "eeg");

    // Web Bluetooth gating. ONLY surface an error if the browser
    // genuinely can't pair (no API / insecure context). In those
    // cases the user needs to know. When everything is fine, the
    // hint stays hidden. No "Before pairing:" wall of text. The
    // button tooltip already explains what's needed.
    const hint = $("bioBleHint");
    const eegBtn = $("bioEegBtn");
    if (hint && eegBtn) {
      hint.style.display = "none";
      if (typeof navigator === "undefined" || !navigator.bluetooth) {
        const ua = (typeof navigator !== "undefined" ? navigator.userAgent : "") || "";
        let msg = "This browser cannot pair a Muse. Use Chrome or Edge on desktop.";
        if (/iPhone|iPad|iPod/.test(ua))                msg = "iOS cannot pair a Muse. Use Chrome or Edge desktop.";
        else if (/Firefox/.test(ua))                    msg = "Firefox cannot pair a Muse. Use Chrome or Edge.";
        else if (/Safari/.test(ua) && !/Chrome/.test(ua)) msg = "Safari cannot pair a Muse. Use Chrome or Edge.";
        hint.textContent = msg;
        hint.style.display = "block";
        eegBtn.disabled = true;
        eegBtn.title = msg;
      } else if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
        hint.textContent = "Pairing needs HTTPS or localhost. Run start-game.bat.";
        hint.style.display = "block";
        eegBtn.disabled = true;
      }
      // No "everything fine" message. Silence is the right default.
    }

    // EEG DIAGNOSE link. clickable, runs all environment checks and
    // attempts a pair, then prints a detailed report inline. The user
    // can screenshot the report so we can pinpoint exactly which
    // stage of pairing is failing (Bluetooth API, WASM, GATT, Muse
    // firmware command sequence).
    const diagLink = $("bioEegDiag");
    const diagOut = $("bioEegDiagOut");
    if (diagLink && diagOut) {
      diagLink.addEventListener("click", async (e) => {
        e.preventDefault();
        const lines = [];
        const push = (k, v) => lines.push(k.padEnd(28) + " " + v);
        diagOut.style.display = "block";
        diagOut.textContent = "Running EEG diagnostic...";

        // Environment checks
        const hasBT = !!(navigator && navigator.bluetooth);
        push("navigator.bluetooth",   hasBT ? "yes" : "MISSING (use Chrome/Edge)");
        push("Secure context",        window.isSecureContext ? "yes" : "NO (use localhost or HTTPS)");
        push("User agent",            (navigator.userAgent || "").slice(0, 80));
        push("Bio adapter ready",     window.Bio ? "yes" : "MISSING");
        push("Bio status snapshot",   JSON.stringify(window.Bio?.status?.() || {}));

        // Try Bio.start with EEG and capture whatever returns/throws.
        push("--- Pair attempt ---", "");
        try {
          const r = await window.Bio?.start?.({ eeg: true });
          if (r?.eeg?.ok) {
            push("Result", "OK. sensor live (state should be 'warming' or 'live')");
          } else {
            push("Result.ok",      String(r?.eeg?.ok));
            push("Result.reason",  String(r?.eeg?.reason || ". "));
            push("Result.message", String(r?.eeg?.message || ". "));
            push("Result.attempts",String(r?.eeg?.attempts || ". "));
          }
        } catch (err) {
          push("Threw",   err?.name || "Error");
          push("Message", err?.message || String(err));
          if (err?.code) push("Code", String(err.code));
        }

        diagOut.textContent = lines.join("\n");
        // Auto-select so the user can copy with Ctrl+A / Ctrl+C.
        const range = document.createRange();
        range.selectNodeContents(diagOut);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
      });
    }

    // Clicking the HUD bio row when no sensor is on quick-starts the heart-rate sensor.
    this.hud.bioRow.addEventListener("click", () => {
      const hrBtn = $("bioHrBtn");
      if (hrBtn && !hrBtn.disabled) hrBtn.click();
    });

    // Belt and braces: the bio adapter injects floating widgets that
    // we don't want. Kill them by ID AND by any element whose id
    // starts with 'bio-' (covers future widgets we don't know about
    // yet). Also use a MutationObserver so anything re-mounted gets
    // nuked the moment it appears, not on the next polling tick.
    const LEGACY_IDS = [
      "bio-badge", "bio-panel", "bio-menu-sparkline",
      "bio-menu-ritual", "bio-tier-block", "bio-drill-host",
      "bio-style", // the <style> tag bio/ui.js injects into <head>
    ];
    // Whitelist — our OWN bio-prefixed elements that should survive.
    const KEEP_IDS = new Set([
      "bioCalibration", "bioBleHint", "bioEegBtn", "bioHrBtn",
      "bioEegDiag", "bioEegDiagOut", "bioRow", "bioNudge",
      "bioErrBanner", "bpmChip", "bpmTxt", "stateChip", "stateTxt",
    ]);
    const nukeLegacyBio = () => {
      for (const id of LEGACY_IDS) {
        const el = document.getElementById(id);
        if (el) el.remove();
      }
      // Match bio- prefix everywhere (head + body), skipping our own.
      const all = document.querySelectorAll('[id^="bio-"], [class^="bio-"]');
      for (const el of all) {
        if (KEEP_IDS.has(el.id)) continue;
        el.remove();
      }
      // Also kill any <style> tag in <head> whose content references
      // #bio-badge. The bio module's injectStyles uses no fixed id
      // on some paths and is hard to id otherwise.
      for (const style of document.head.querySelectorAll("style")) {
        if (style.id && KEEP_IDS.has(style.id)) continue;
        if (style.textContent && /#bio-badge|#bio-panel/.test(style.textContent)) {
          style.remove();
        }
      }
    };
    window.addEventListener("bio:ready", nukeLegacyBio);
    nukeLegacyBio();
    setTimeout(nukeLegacyBio, 200);
    setTimeout(nukeLegacyBio, 800);
    setTimeout(nukeLegacyBio, 2000);
    // MutationObserver as one guard. Deep tree (subtree:true) so it
    // catches any nested re-mount the bio module might do, not just
    // direct children of body.
    try {
      const mo = new MutationObserver(() => nukeLegacyBio());
      mo.observe(document.body, { childList: true, subtree: true });
    } catch {}
    // Forever interval as the second guard. The bio module previously
    // won the visibility war by re-mounting on its own timer after
    // the initial polls ended. 500ms forever ensures it can never win.
    setInterval(nukeLegacyBio, 500);
  }

  _bindBio() {
    const tryBind = () => {
      if (!window.Bio) return false;
      window.Bio.on("rppgMetric", (m) => {
        if (m && typeof m.bpm === "number") {
          this.bpm = Math.round(m.bpm);
          this.hud.bpmTxt.textContent = `${this.bpm} bpm`;
          this.hud.bioRow.classList.add("on");
          // HEARTBEAT IMPACT. every detected beat sends a real pulse
          // through the world. Scheduled as a chain of soft camera
          // kicks + screen pulses paced to the player's actual BPM,
          // so the game LITERALLY beats with their body. This is the
          // single biggest "the SDK changes the experience" cue.
          this._scheduleHeartbeatPulse();
        }
        // HRV (RMSSD ms). captured for the advanced-mode panel.
        if (m && typeof m.hrv === "number") this.hrv = m.hrv;
        // STRESS + FATIGUE inference layered on top of SDK state.
        // Wrapped so any bug here can NEVER take down the whole
        // metric handler (which would break camera connection).
        try { this._derivePunishStates(); }
        catch (e) { console.warn("[Bio] derivePunishStates threw", e); }
      });
      // EEG metrics. capture focus/calm levels for advanced-mode panel.
      window.Bio.on("eegMetric", (m) => {
        if (!m) return;
        if (typeof m.focus === "number") this.focusLevel = m.focus;
        if (typeof m.calm === "number")  this.calmLevel  = m.calm;
      });
      window.Bio.on("rppgStatus", (s) => {
        if (s.status === "off" || s.status === "error") {
          this.hud.bioRow.classList.remove("on");
          this.hud.bpmTxt.textContent = "Off";
        } else if (s.status === "warming") {
          this.hud.bioRow.classList.add("on");
          // Actionable warming hint instead of "Steadying" so the user
          // knows what to actually do during the calibration window.
          this.hud.bpmTxt.textContent = "Face the camera";
        } else if (s.status === "live") {
          this.hud.bioRow.classList.add("on");
          // FIRST-TIME CALIBRATION RITUAL. show a 60s breathing
          // guide once per profile lifetime so the SDK has a real
          // baseline to compare against. Skippable.
          this._maybeStartCalibration();
        }
        this._refreshBioLiveFlag();
      });
      window.Bio.on("eegStatus", (s) => {
        this._refreshBioLiveFlag();
      });
      window.Bio.on("stateChange", ({ state, prev }) => {
        this.cognitiveState = state;
        this._updateMultiplier(state);
        if (state && state !== "neutral") {
          const label = state.charAt(0).toUpperCase() + state.slice(1);
          this.hud.stateTxt.textContent = label;
          this.hud.stateChip.style.display = "";
          // Factual gameplay effect, not poetry. Surfaces the value prop:
          // bio is actually doing something to the game.
          const effects = {
            flow: "Flow active. 2x score.",
            berserker: "Berserker. +12% speed, +50% score.",
            meditation: "Meditation. -10% speed.",
            frantic: "Frantic.",
            focused: "Focused. +40% score.",
            aroused: "Charged. Faster.",
            calm: "Calm. Steadier.",
            distracted: "Distracted.",
          };
          const msg = effects[state];
          if (msg && this.running && !this.over) {
            this._showBioToast(msg);
          }
        } else {
          this.hud.stateChip.style.display = "none";
        }
      });
      return true;
    };
    if (!tryBind()) window.addEventListener("bio:ready", tryBind, { once: true });
  }

  // Drive the body.bio-live CSS flag. The nudge pill in the corner
  // hides immediately once any sensor activates. Additionally, after
  // the player has seen it once on a successful run start we hide it
  // permanently for that session. "rich in the background" means
  // we shouldn't keep nagging.
  _refreshBioLiveFlag() {
    if (!window.Bio || typeof window.Bio.status !== "function") return;
    const s = window.Bio.status();
    const active = (s.rppg === "live" || s.rppg === "warming"
                 || s.eeg  === "live" || s.eeg  === "warming");
    document.body.classList.toggle("bio-live", !!active);
  }
  // Called from _begin to suppress the nudge on subsequent runs once
  // the player has seen it. Sessionscoped so it returns on reload.
  _markNudgeSeen() {
    if (this._nudgeSeen) document.body.classList.add("bio-live");
    this._nudgeSeen = true;
  }

  _showBioToast(text) {
    let host = this._bioToast;
    if (!host) {
      host = document.createElement("div");
      host.style.cssText =
        "position:fixed;top:160px;left:50%;transform:translateX(-50%);" +
        "background:rgba(10,13,18,.92);color:#fff;font:600 13px/1.3 system-ui,sans-serif;" +
        "padding:9px 16px;border-radius:999px;z-index:34;pointer-events:none;" +
        "border:1px solid rgba(251,191,36,.45);box-shadow:0 6px 20px rgba(0,0,0,.4);" +
        "opacity:0;transition:opacity .25s ease,transform .25s ease;";
      document.body.appendChild(host);
      this._bioToast = host;
    }
    host.textContent = text;
    host.style.opacity = "1";
    host.style.transform = "translateX(-50%) translateY(0)";
    clearTimeout(this._bioToastT);
    this._bioToastT = setTimeout(() => {
      host.style.opacity = "0";
      host.style.transform = "translateX(-50%) translateY(-6px)";
    }, 2400);
  }

  _loadStats() {
    // Each step independently try-wrapped so one missing DOM element
    // (e.g. when the layout is changing) can NEVER kill the whole
    // menu boot path. Previously a single null-ref here was silently
    // killing the Skald-name refresh AND the button wiring downstream.
    try {
      const s = Store.load();
      const $$ = (id) => document.getElementById(id);
      if ($$("bestScore")) $$("bestScore").textContent = (s.bestScore || 0).toLocaleString();
      if ($$("bestDist"))  $$("bestDist").textContent  = `${Math.round(s.bestDist || 0)}m`;
      if ($$("totalRuns")) $$("totalRuns").textContent = s.totalRuns || 0;
    } catch (e) { console.warn("[loadStats] base failed", e); }
    try { this._renderMenuChrome(); } catch (e) { console.warn("[loadStats] chrome failed", e); }
    try { this._renderMenuNudge();  } catch (e) { console.warn("[loadStats] nudge failed", e); }
    try { this._renderSagaLine();   } catch (e) { console.warn("[loadStats] saga failed", e); }
    // CRITICAL: refresh the skald name in the micro-chrome top-right.
    // Was being missed because _refreshSkaldLine was only called in
    // boot, not on every menu open. That's why the user saw 'unknown'.
    try { this._refreshSkaldLine(); } catch (e) { console.warn("[loadStats] skald failed", e); }
  }

  // HERO-ONLY menu chrome. The hero composition (title, tagline, CTA,
  // stat ribbon) is the only thing visible by default. Everything else
  // (realm path, bosses, quest, leaderboard, honours) renders inside
  // the SAGA sheet when the user opens it.
  _renderMenuChrome() {
    const s = Store.load();
    const streak = s.streak || 0;
    const heroStreakEl = document.getElementById("heroStreak");
    const heroBestEl   = document.getElementById("heroBest");
    const heroDistEl   = document.getElementById("heroDist");
    if (heroStreakEl) heroStreakEl.innerHTML = `🔥 ${streak}`;
    if (heroBestEl)   heroBestEl.textContent = (s.bestScore || 0).toLocaleString();
    if (heroDistEl)   heroDistEl.textContent = `${Math.round(s.bestDist || 0)}m`;
  }

  // Populate the SAGA sheet. Called on every sheet open. Reuses the
  // existing renderers but writes to the SHEET DOM ids by temporarily
  // swapping element references (cheaper than duplicating renderers).
  _renderSagaSheet() {
    const s = Store.load();
    // Temporarily move data into the sheet's elements by rewriting
    // host IDs. Each renderer queries by id; we just redirect those
    // ids by setting innerHTML on the sheet host directly.
    const move = (fromId, toId) => {
      const from = document.getElementById(fromId);
      const to   = document.getElementById(toId);
      if (from && to) to.innerHTML = from.innerHTML;
    };
    // Run the renderers first (they write into the legacy hidden shims).
    this._renderDailyQuest(s);
    this._renderRealmPath(s);
    this._renderBossRoster(s);
    this._renderTopRuns(s);
    this._renderHonoursRow(s);
    this._renderMenuTrends();
    // Copy from hidden shim into the visible sheet host.
    move("realmPath",   "sagaSheetRealmPath");
    move("bossRoster",  "sagaSheetBossRoster");
    move("topRuns",     "sagaSheetTopRuns");
    move("honoursRow",  "sagaSheetHonoursRow");
    move("menuTrendsBody", "sagaSheetTrendsBody");
    // Daily quest sheet copy: clone the entire quest card.
    const dqHost = document.getElementById("dailyQuest");
    const dqSheet = document.getElementById("sagaSheetQuest");
    if (dqHost && dqSheet) {
      dqSheet.innerHTML = "";
      const clone = dqHost.cloneNode(true);
      clone.removeAttribute("id");
      dqSheet.appendChild(clone);
    }
    // Honours count label inside sheet.
    const hc = document.getElementById("honoursCount");
    const hcs = document.getElementById("sagaSheetHonoursTitle");
    if (hc && hcs) hcs.textContent = "Honours · " + hc.textContent;
  }

  _renderRealmPath(s) {
    const host = document.getElementById("realmPath");
    if (!host) return;
    const realms = [
      { key: "Midgard",    short: "MID",  icon: "🌲", colour: "#5a8c5a" },
      { key: "Jötunheim",  short: "JÖT",  icon: "❄",  colour: "#7aa8d0" },
      { key: "Muspelheim", short: "MUS",  icon: "🔥", colour: "#d06a40" },
      { key: "Asgard",     short: "ASG",  icon: "⚡", colour: "#f4d49a" },
    ];
    const cycles = s.totalCycles || 0;
    const farthest = s.farthestRealm || "Midgard";
    const farthestIdx = realms.findIndex(r => r.key === farthest);
    let html = "";
    for (let i = 0; i < realms.length; i++) {
      const r = realms[i];
      const reached = i <= farthestIdx || cycles > 0;
      const isFarthest = i === farthestIdx && cycles === 0;
      const op = reached ? 1 : 0.32;
      const ringColour = reached ? r.colour : "rgba(212,173,106,.28)";
      const nameColour = reached ? "#f4d49a" : "rgba(255,255,255,.4)";
      html += `<div class="realm-node" style="opacity:${op}" title="${r.key}${reached ? " · reached" : " · locked"}">`
            + `<div class="realm-circle" style="border:2px solid ${ringColour};${isFarthest ? `box-shadow:0 0 18px ${r.colour};` : ""}">${r.icon}</div>`
            + `<div class="realm-name" style="color:${nameColour}">${r.short}</div>`
            + `</div>`;
      if (i < realms.length - 1) {
        const lineOp = (i < farthestIdx || cycles > 0) ? 0.7 : 0.18;
        const hex = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
        html += `<div class="realm-edge" style="background:linear-gradient(90deg,${realms[i].colour}${hex(lineOp)},${realms[i+1].colour}${hex(lineOp)})"></div>`;
      }
    }
    if (cycles > 0) {
      html += `<div style="margin-left:10px;padding:4px 9px;background:rgba(244,212,154,.18);border:1px solid rgba(244,212,154,.45);border-radius:12px;font:700 10px/1 'Cinzel',serif;color:#f4d49a;letter-spacing:.08em;flex:0 0 auto">${cycles}× SAGA</div>`;
    }
    host.innerHTML = html;
  }

  // Boss roster. 4 boss cards with kill count + locked/unlocked state.
  _renderBossRoster(s) {
    const host = document.getElementById("bossRoster");
    if (!host) return;
    const BOSSES = [
      { key: "jotunn",   name: "JÖTUNN",   realm: "Jötunheim",  icon: "❄", colour: "#7aa8d0" },
      { key: "surtr",    name: "SURTR",    realm: "Muspelheim", icon: "🔥", colour: "#d06a40" },
      { key: "valkyrie", name: "VALKYRIE", realm: "Asgard",     icon: "✦", colour: "#f4d49a" },
      { key: "odin",     name: "ODIN",     realm: "Asgard ×5",  icon: "👁", colour: "#c5a3ff" },
    ];
    const kills = s.bossKills || {};
    const realms = ["Midgard","Jötunheim","Muspelheim","Asgard"];
    const farthestIdx = realms.indexOf(s.farthestRealm || "Midgard");
    const cycles = s.totalCycles || 0;
    let html = "";
    for (const b of BOSSES) {
      const reqIdx = realms.indexOf(b.realm.split(" ")[0]);
      const reqCycles = b.key === "odin" ? 4 : 0;
      const unlocked = (farthestIdx >= reqIdx || cycles > 0) && cycles >= reqCycles;
      const n = kills[b.key] || 0;
      const aliveClass = unlocked ? " alive" : "";
      const op = unlocked ? "" : "opacity:.32;";
      const border = unlocked ? `border-color:${b.colour}40;` : "";
      const nameColour = unlocked ? "#f4d49a" : "rgba(255,255,255,.4)";
      const metaColour = unlocked && n > 0 ? "#a3e8b8" : "rgba(255,255,255,.4)";
      html += `<div class="boss-card${aliveClass}" style="${op}${border}" title="${b.name} · ${b.realm}${unlocked ? "" : " · LOCKED"}">`
           + `<div class="boss-icon">${b.icon}</div>`
           + `<div class="boss-name" style="color:${nameColour}">${b.name}</div>`
           + `<div class="boss-meta" style="color:${metaColour}">${unlocked ? (n + " slain") : "locked"}</div>`
           + `</div>`;
    }
    host.innerHTML = html;
  }

  // Daily quest. One quest per day, persisted via dailyQuest:{date,id,progress,done}.
  // On first menu open of a new day, generate a fresh quest. Progress
  // is incremented in _saveStats / per-event hooks (already accumulated
  // in this.bioSession). Reward is +200 mead currency on completion.
  _renderDailyQuest(s) {
    const host = document.getElementById("dailyQuest");
    const textEl = document.getElementById("dailyQuestText");
    const progEl = document.getElementById("dailyQuestProgress");
    const rewardEl = document.getElementById("dailyQuestReward");
    if (!host || !textEl || !progEl || !rewardEl) return;
    const today = new Date().toISOString().slice(0, 10);
    const QUESTS = [
      { id: "dist1500",  text: "Run 1500m in a single road.",            target: 1500, unit: "m", reward: "+300 score on completion" },
      { id: "flow60",    text: "Hold Deep Flow for 60 seconds today.",   target: 60,   unit: "s", reward: "+1 streak freeze" },
      { id: "calm120",   text: "Hold Still Water for 2 minutes today.",  target: 120,  unit: "s", reward: "Bronze honour boost" },
      { id: "bossKill2", text: "Slay 2 bosses today.",                   target: 2,    unit: "",  reward: "+500 score" },
      { id: "runes10",   text: "Collect 10 rune-stones today.",          target: 10,   unit: "",  reward: "Asgard speed-up" },
      { id: "score3k",   text: "Score 3,000+ in one run today.",         target: 3000, unit: "",  reward: "Bronze honour boost" },
    ];
    let q = s.dailyQuest;
    if (!q || q.date !== today) {
      // Rotate quest by day-of-year hash so it changes daily but is stable.
      const dayHash = today.split("-").reduce((h, x) => h + parseInt(x, 10), 0);
      const chosen = QUESTS[dayHash % QUESTS.length];
      q = { date: today, id: chosen.id, progress: 0, done: false };
      const ns = Store.load();
      ns.dailyQuest = q;
      Store.save(ns);
    }
    const def = QUESTS.find(qq => qq.id === q.id) || QUESTS[0];
    textEl.textContent = def.text;
    progEl.textContent = q.done ? "✓ DONE" : `${q.progress}${def.unit} / ${def.target}${def.unit}`;
    rewardEl.textContent = q.done ? "Reward claimed." : `Reward: ${def.reward}`;
    host.classList.toggle("done", !!q.done);
  }

  // Top 5 personal leaderboard. Always visible. Each row: medal/rank,
  // score, distance, date. Today's runs highlighted.
  _renderTopRuns(s) {
    const host = document.getElementById("topRuns");
    if (!host) return;
    const board = (s.leaderboard || []).slice(0, 5);
    const today = new Date().toISOString().slice(0, 10);
    if (board.length === 0) {
      host.innerHTML = `<div style="opacity:.55;font-size:11.5px;font-style:italic;padding:6px 0">No runs walked. Walk one.</div>`;
      return;
    }
    let html = "";
    for (let i = 0; i < board.length; i++) {
      const b = board[i];
      const isToday = b.date === today;
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      html += `<div class="top-run-row${isToday ? " today" : ""}">`
           + `<span class="medal">${medal}</span>`
           + `<span class="score">${b.score.toLocaleString()}</span>`
           + `<span class="dist">${b.dist}m</span>`
           + `<span class="date">${b.date.slice(5)}</span>`
           + `</div>`;
    }
    host.innerHTML = html;
  }

  // Honours row — last 4 unlocked + next 2 unlocked. Always 6 cells.
  _renderHonoursRow(s) {
    const host = document.getElementById("honoursRow");
    const countEl = document.getElementById("honoursCount");
    if (!host) return;
    const all = (typeof this._allBadges === "function") ? this._allBadges() : [];
    const earnedSet = new Set(s.badges || []);
    const earned = all.filter(b => earnedSet.has(b.id));
    const unearned = all.filter(b => !earnedSet.has(b.id));
    if (countEl) countEl.textContent = `${earned.length} / ${all.length}`;
    // Take last 4 earned + next 2 to unlock.
    const showEarned = earned.slice(-4);
    const showNext = unearned.slice(0, 2);
    const cells = [...showEarned, ...showNext];
    if (cells.length === 0) {
      host.innerHTML = `<div style="grid-column:1/-1;font-size:11px;color:rgba(255,255,255,.4);text-align:center;padding:8px 0;font-style:italic">Earn honours as you walk the road.</div>`;
      return;
    }
    let html = "";
    for (const b of cells) {
      const got = earnedSet.has(b.id);
      html += `<div class="honour${got ? " earned" : ""}" title="${b.label || b.id}">`
           + `<div class="icon">${b.icon || "✦"}</div>`
           + `<div class="name">${(b.label || b.id).slice(0, 14)}</div>`
           + `</div>`;
    }
    host.innerHTML = html;
  }

  // Show the user's saga progression on the menu. total cycles
  // completed + current realm if mid-run, or a poetic "next realm"
  // teaser if they've never reached Asgard.
  _renderSagaLine() {
    // Inject a saga line into the menu under the tag line.
    let el = document.getElementById("sagaLine");
    if (!el) {
      const tag = document.querySelector(".start .card .tag");
      if (!tag) return;
      el = document.createElement("div");
      el.id = "sagaLine";
      el.style.cssText =
        "margin:8px auto 0;max-width:520px;font:italic 600 13.5px/1.4 'Cinzel',serif;" +
        "color:rgba(244,212,154,.85);letter-spacing:.04em;text-align:center;" +
        "text-shadow:0 2px 12px rgba(0,0,0,.7)";
      tag.insertAdjacentElement("afterend", el);
    }
    const s = Store.load();
    const cycles = s.totalCycles || 0;
    const farthest = s.farthestRealm || "Midgard";
    let line;
    if (cycles === 0) {
      if (farthest === "Midgard")    line = "Your saga begins. Bifröst awaits beyond three realms.";
      else if (farthest === "Jötunheim") line = "You have walked Jötunheim. Muspelheim lies ahead.";
      else if (farthest === "Muspelheim") line = "You have crossed Muspelheim. Asgard waits at the end of the road.";
      else                                line = "You have reached Asgard. One full saga awaits.";
    } else if (cycles === 1) {
      line = "One saga complete. The realms know your name.";
    } else {
      line = `${cycles} sagas walked. The gods take notice.`;
    }
    el.textContent = line;
  }

  // Personalised nudge shown on the menu. Picks ONE message based on
  // a priority ladder over the user's history. Hidden if no history
  // exists (first launch).
  _renderMenuNudge() {
    const el = document.getElementById("menuNudge");
    const txt = document.getElementById("menuNudgeText");
    if (!el || !txt) return;
    const s = Store.load();
    const daily = s.daily || {};
    const days = Object.keys(daily).sort();
    if (days.length === 0) { el.style.display = "none"; return; }

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const todayD = daily[today];
    const lastPlayed = days[days.length - 1];
    const daysSincePlay = Math.floor((Date.now() - new Date(lastPlayed).getTime()) / 86400000);

    // Compute rolling stats for context
    const last7 = days.slice(-7).map(d => daily[d]);
    const last30 = days.slice(-30).map(d => daily[d]);
    const flowSum = (arr) => arr.reduce((s, d) => s + (d?.flowSec || 0), 0);
    const flow7 = flowSum(last7);
    const flow30 = flowSum(last30);
    const flow7avg = flow7 / Math.max(1, last7.length);

    // PRIORITY LADDER, Viking-saga voice (no AI cheer, no em-dashes).
    // Loss-aversion bias: framed around what's slipping away, not
    // what's offered. "Your streak will die" hits harder than "keep
    // your streak". Sources of phrasing: Havamal, Saxo Grammaticus,
    // The Northman, Vikings TV. Short. Hard.
    let message = null;
    let tone = "neutral";

    // 1. Streak in jeopardy (LOSS-FRAMED, urgent)
    if (daysSincePlay >= 1 && (s.streak || 0) >= 2 && lastPlayed !== today) {
      const streak = s.streak;
      message = `Your ${streak}-day fire grows cold. Run now or lose it.`;
      tone = "urgent";
    }
    // 2. Stress accumulating (NEW, loss-framed). If yesterday had
    // notable stress time, surface it as a warning rather than a stat.
    else if (daily[yesterday] && (daily[yesterday].stressSec || 0) > 60) {
      message = `Yesterday the storm took you for ${Math.round(daily[yesterday].stressSec)}s. Breathe truer today.`;
      tone = "urgent";
    }
    // 3. Best-ever flow week (PRAISE, sparse)
    else if (flow7 > 0 && (s.bestWeekFlowSec || 0) < flow7) {
      message = `Seven days of deeper Flow than any before. The gods write your name down.`;
      tone = "win";
      const next = Store.load();
      next.bestWeekFlowSec = flow7;
      Store.save(next);
    }
    // 4. Yesterday's calm record to beat (CHALLENGE, loss-framed)
    else if (daily[yesterday] && daily[yesterday].calmSec > 30) {
      message = `Yesterday you held the cold ${Math.round(daily[yesterday].calmSec)}s. Hold it longer or be the lesser.`;
      tone = "challenge";
    }
    // 5. Trend up (PRAISE)
    else if (flow30 > 0 && flow7avg > flow30 / 30 * 1.3) {
      message = `Your Flow rises sharply. The path opens for those who keep walking it.`;
      tone = "win";
    }
    // 6. Recovery low (loss-framed warning)
    else if (daily[yesterday] && daily[yesterday].hrvAvg && daily[yesterday].hrvAvg < 25) {
      message = `Your body bears yesterday's weight. Move gently, breathe long.`;
      tone = "urgent";
    }
    // 7. Streak milestone close (FOMO + freeze reminder)
    else if ((s.streak || 0) >= 2 && (s.streak || 0) < 7) {
      const fz = s.streakFreezes || 0;
      const fzNote = fz > 0 ? ` (${fz} freeze in your bag)` : "";
      message = `Day ${s.streak} kept. ${7 - s.streak} more and you carry the 7-fire.${fzNote}`;
      tone = "neutral";
    }
    // 8. Big streak, freezes available
    else if ((s.streak || 0) >= 7 && (s.streakFreezes || 0) > 0) {
      const fz = s.streakFreezes;
      message = `${s.streak} fires kept. ${fz} freeze${fz > 1 ? "s" : ""} held back, in case the storm takes a day.`;
      tone = "neutral";
    }
    // 9. Long absence
    else if (daysSincePlay >= 2) {
      message = `${daysSincePlay} days the horn lay silent. The road remembers your weight.`;
      tone = "neutral";
    }
    // 10. First-of-day, time-flavoured (no "Welcome Skald" cheer)
    else if (lastPlayed !== today) {
      const hr = new Date().getHours();
      const line = hr < 6  ? "The fire is low. Run before the others wake."
                : hr < 12 ? "First light. The road is yours alone."
                : hr < 17 ? "The sun crosses. Time to test the legs."
                : hr < 21 ? "Sky bleeds. Run while it still holds."
                          : "Long-dark. The ravens are watching.";
      message = line;
      tone = "neutral";
    }

    if (!message) { el.style.display = "none"; return; }

    txt.textContent = message;
    el.style.display = "block";
    // Subtle tone variation in the border colour
    const borderColours = { urgent: "rgba(255,140,90,.45)", win: "rgba(120,220,180,.4)", challenge: "rgba(160,180,255,.4)", neutral: "rgba(212,173,106,.28)" };
    el.style.borderColor = borderColours[tone] || borderColours.neutral;
  }

  // 30-day trends panel. bar chart of flow seconds per day +
  // day-of-week heatmap showing when the user plays best.
  _renderMenuTrends() {
    const body = document.getElementById("menuTrendsBody");
    if (!body) return;
    const s = Store.load();
    const daily = s.daily || {};
    const dayKeys = Object.keys(daily).sort();
    if (dayKeys.length === 0) {
      body.innerHTML = `<div style="opacity:.6;font-size:11.5px;padding:10px 0">Walk one road. Numbers will follow.</div>`;
      return;
    }

    // Build 30-day arrays per metric.
    const today = new Date();
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const day = daily[key] || {};
      // "Calm-time" combines flow + focused + calm + meditation. that's
      // the abstracted "good bio time" the user gets credit for, even
      // if they don't know what each state means.
      const calm = (day.flowSec || 0) + (day.focusedSec || 0)
                 + (day.calmSec || 0) + (day.meditationSec || 0);
      const storm = (day.stressSec || 0) + (day.fatigueSec || 0);
      days.push({
        key,
        score: day.bestScore || 0,
        runs: day.runs || 0,
        calm, storm,
      });
    }
    const maxCalm  = Math.max(1, ...days.map(d => d.calm));
    const maxScore = Math.max(1, ...days.map(d => d.score));
    const totalCalm  = days.reduce((s, d) => s + d.calm, 0);
    const totalStorm = days.reduce((s, d) => s + d.storm, 0);
    const totalRuns  = days.reduce((s, d) => s + d.runs, 0);
    const activeDays = days.filter(d => d.runs > 0).length;
    const bestRun    = Math.max(0, ...days.map(d => d.score));
    const todayKey   = new Date().toISOString().slice(0, 10);

    // Bar renderer (height-scaled, today highlighted)
    const bar = (val, max, baseColour, today) => {
      const h = Math.round((val / max) * 32);
      const c = val === 0 ? "rgba(212,173,106,.10)"
              : today ? "#f4d49a"
              : baseColour;
      return `<div style="width:6px;height:${Math.max(2, h)}px;background:${c};border-radius:1px;flex-shrink:0"></div>`;
    };
    const calmBars  = days.map(d => bar(d.calm,  maxCalm,  "rgba(122,217,255,.6)", d.key === todayKey)).join("");
    const stormBars = days.map(d => bar(d.storm, maxCalm,  "rgba(200,64,48,.55)",  d.key === todayKey)).join("");
    const scoreBars = days.map(d => bar(d.score, maxScore, "rgba(212,173,106,.65)", d.key === todayKey)).join("");

    // Day-of-week best
    const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dowCalm = [0,0,0,0,0,0,0];
    for (const k of dayKeys) {
      const d = daily[k];
      const calm = (d.flowSec || 0) + (d.focusedSec || 0) + (d.calmSec || 0) + (d.meditationSec || 0);
      dowCalm[new Date(k).getDay()] += calm;
    }
    const maxDow = Math.max(1, ...dowCalm);
    const bestDow = dowCalm.indexOf(Math.max(...dowCalm));
    const dowHtml = dowNames.map((n, i) => {
      const op = 0.15 + (dowCalm[i] / maxDow) * 0.7;
      const isBest = i === bestDow && dowCalm[i] > 0;
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">`
           + `<div style="width:100%;height:18px;background:rgba(122,217,255,${op});border-radius:3px;${isBest ? "outline:1.5px solid #f4d49a;" : ""}"></div>`
           + `<div style="font-size:9px;letter-spacing:.04em;color:rgba(255,255,255,${isBest ? ".95" : ".45"})">${n}</div>`
           + `</div>`;
    }).join("");

    // Hard-readable summary line in saga voice. NO em-dashes.
    const summary = `${activeDays} days walked. ${totalRuns} runs.`
                  + ` Best run ${bestRun.toLocaleString()}.`;

    body.innerHTML =
        `<div style="font-size:11.5px;color:rgba(255,255,255,.7);margin-bottom:10px;letter-spacing:.02em">${summary}</div>`
      // BIO row: calm above the line, stress below the line
      + `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">`
      +   `<div style="font:600 9.5px/1 'Cinzel',serif;letter-spacing:.18em;color:rgba(122,217,255,.7);text-transform:uppercase">Steady time</div>`
      +   `<div style="font-size:10px;color:rgba(255,255,255,.5)">${Math.round(totalCalm)}s · 30 days</div>`
      + `</div>`
      + `<div style="display:flex;align-items:flex-end;gap:2px;height:36px;margin-bottom:6px;border-bottom:1px solid rgba(212,173,106,.18);padding-bottom:2px">${calmBars}</div>`
      + `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">`
      +   `<div style="font:600 9.5px/1 'Cinzel',serif;letter-spacing:.18em;color:rgba(200,64,48,.75);text-transform:uppercase">Storm time</div>`
      +   `<div style="font-size:10px;color:rgba(255,255,255,.5)">${Math.round(totalStorm)}s · what you want to shrink</div>`
      + `</div>`
      + `<div style="display:flex;align-items:flex-end;gap:2px;height:24px;margin-bottom:14px">${stormBars}</div>`
      // SCORE row
      + `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">`
      +   `<div style="font:600 9.5px/1 'Cinzel',serif;letter-spacing:.18em;color:rgba(244,212,154,.75);text-transform:uppercase">Best score / day</div>`
      +   `<div style="font-size:10px;color:rgba(255,255,255,.5)">peak ${bestRun.toLocaleString()}</div>`
      + `</div>`
      + `<div style="display:flex;align-items:flex-end;gap:2px;height:36px;margin-bottom:14px">${scoreBars}</div>`
      // DOW heatmap
      + `<div style="font:600 9.5px/1 'Cinzel',serif;letter-spacing:.18em;color:rgba(212,173,106,.7);text-transform:uppercase;margin-bottom:4px">Strongest day of the week</div>`
      + `<div style="display:flex;gap:4px;margin-bottom:6px">${dowHtml}</div>`;
  }

  // Live-apply localization to elements that have an id. Anything
  // not in I18N_DICT keeps its English text. Called on language
  // change + on boot.
  _applyI18n() {
    try {
      const playBtn = document.getElementById("beginBtn");
      const againBtn = document.getElementById("againBtn");
      const resumeBtn = document.getElementById("resumeBtn");
      const tabS = document.getElementById("tabSensors");
      const tabT = document.getElementById("tabTrends");
      if (playBtn)   playBtn.textContent   = I18N("run");
      if (againBtn)  againBtn.textContent  = I18N("runAgain");
      if (resumeBtn) resumeBtn.textContent = I18N("resume");
      if (tabS) tabS.textContent = I18N("bindBody");
      if (tabT) tabT.textContent = I18N("sagaSoFar");
    } catch (e) { console.warn("[Valhalla] i18n apply failed", e); }
  }

  // Apply selected coat/shield/cloak tint to the player model. Reads
  // localStorage; no-op if model not loaded yet. Safe to call any time.
  _applyGear() {
    try {
      if (!this.player) return;
      const coat   = localStorage.getItem("valhalla.gear.coat")   || "leather";
      const shield = localStorage.getItem("valhalla.gear.shield") || "oak";
      const cloak  = localStorage.getItem("valhalla.gear.cloak")  || "none";
      const COAT = {
        leather:  0x4a2818, furBlack: 0x1a1612, furGrey:  0x4a4a52, iron:     0x6a6e74,
      };
      const SHIELD = {
        oak:    0x6a4a28, red:    0x8a2020, blue:   0x205088, bronze: 0xa07028,
      };
      const CLOAK = {
        none:   null, wolf:   0x5a5e64, bear:   0x4a2818, red:    0x6a1818,
      };
      const coatColour   = COAT[coat]   ?? COAT.leather;
      const shieldColour = SHIELD[shield] ?? SHIELD.oak;
      const cloakColour  = CLOAK[cloak];
      // Traverse player meshes. Heuristic: tint anything that isn't
      // metal-ish based on roughness/metalness. The Soldier.glb has
      // generic materials; we just bias the colour.
      this.player.traverse((o) => {
        if (!o.isMesh) return;
        if (!o.material) return;
        const m = o.material;
        // Apply coat tint to non-metallic materials (skin / fur / leather).
        if (m.color && (m.metalness ?? 0) < 0.5) {
          m.color.setHex(coatColour);
          m.needsUpdate = true;
        }
      });
      // Shield / cloak tinting happens on the attached accessories if
      // they exist (set by the Viking-gear builder elsewhere).
      if (this._playerShield && this._playerShield.material) {
        this._playerShield.material.color.setHex(shieldColour);
      }
      if (this._playerCloak) {
        if (cloakColour == null) {
          this._playerCloak.visible = false;
        } else {
          this._playerCloak.visible = true;
          if (this._playerCloak.material) this._playerCloak.material.color.setHex(cloakColour);
        }
      }
    } catch (e) { console.warn("[Valhalla] gear apply failed", e); }
  }

  // Update the small "🪶 Skald · {name} · Local only" line in the
  // start overlay. Called on boot, after cloud sync, after restore.
  _refreshSkaldLine() {
    const nameEl = document.getElementById("skaldNameLine");
    const statusEl = document.getElementById("syncStatusLine");
    if (nameEl)   nameEl.textContent   = Store.getSkaldName();
    if (statusEl) statusEl.textContent = Store.cloudStatusText();
  }

  // Wire all the buttons inside the #syncOverlay dialog. Idempotent . 
  // safe to call once at boot.
  _wireSyncDialog() {
    const open = document.getElementById("openSyncDialog");
    const close = document.getElementById("closeSyncDialog");
    const overlay = document.getElementById("syncOverlay");
    if (!open || !close || !overlay) return;

    const refreshDialog = () => {
      const id = Store.getSkaldId();
      const name = Store.getSkaldName();
      document.getElementById("syncSkaldName").textContent = name;
      document.getElementById("syncSkaldId").textContent = id;
      const status = document.getElementById("syncCloudStatus");
      if (Store.isCloudAvailable()) {
        status.innerHTML = `<span style="color:#a3e8b8;font-weight:600">● Cloud sync active</span>. your save follows you to any device signed in to Elata.`;
      } else {
        status.innerHTML = `<span style="color:#ffd066;font-weight:600">● Local only</span>. this device's browser. Use the buttons below to move your save, or open Valhalla inside the Elata App Store for automatic sync.`;
      }
    };

    open.addEventListener("click", (e) => {
      e.preventDefault();
      refreshDialog();
      overlay.style.display = "flex";
    });
    close.addEventListener("click", () => { overlay.style.display = "none"; });
    overlay.addEventListener("click", (e) => {
      // Click outside the card to dismiss.
      if (e.target === overlay) overlay.style.display = "none";
    });

    // Rename. generate a new mnemonic but keep the same hex ID, so
    // cloud sync continuity is preserved.
    document.getElementById("syncRenameSkald").addEventListener("click", () => {
      try { localStorage.removeItem(SKALD_NAME_KEY); } catch {}
      Store.getSkaldName();          // regenerate
      refreshDialog();
      this._refreshSkaldLine();
    });

    // Copy save string to clipboard.
    document.getElementById("syncCopySave").addEventListener("click", async () => {
      try {
        const s = Store.exportString();
        await navigator.clipboard.writeText(s);
        this._showSyncResult(`Copied ${(s.length / 1024).toFixed(1)}KB save to clipboard. Paste it on the other device.`, "ok");
      } catch (e) {
        // Fallback: stash in textarea so user can copy manually
        const ta = document.getElementById("syncSavePaste");
        ta.value = Store.exportString();
        ta.focus(); ta.select();
        this._showSyncResult("Clipboard blocked. save text is in the box below, copy manually.", "warn");
      }
    });

    // Copy share link to clipboard.
    document.getElementById("syncCopyLink").addEventListener("click", async () => {
      try {
        const url = Store.exportUrl();
        await navigator.clipboard.writeText(url);
        this._showSyncResult(`Copied share link (${(url.length / 1024).toFixed(1)}KB). Open it on the other device. your save restores automatically.`, "ok");
      } catch {
        const ta = document.getElementById("syncSavePaste");
        ta.value = Store.exportUrl();
        ta.focus(); ta.select();
        this._showSyncResult("Clipboard blocked. link text is in the box below, copy manually.", "warn");
      }
    });

    // GEAR PICKER. coat/shield/cloak. Tints the player model on
    // selection (live; no refresh). Persists to localStorage so the
    // Skald keeps the look across sessions and devices (synced via
    // Store snapshot since the picker writes through Store).
    const wireGear = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = localStorage.getItem("valhalla.gear." + key) || el.value;
      el.addEventListener("change", () => {
        localStorage.setItem("valhalla.gear." + key, el.value);
        this._applyGear();
      });
    };
    wireGear("gearCoat",   "coat");
    wireGear("gearShield", "shield");
    wireGear("gearCloak",  "cloak");

    // FRIENDS LEADERBOARD. add by pasted Skald ID, list shows them
    // with their latest known score (synced via ElataSync if present;
    // otherwise just shows the IDs as placeholders for when sync
    // wires up via the app store).
    const friendInput = document.getElementById("friendIdInput");
    const friendAddBtn = document.getElementById("friendAddBtn");
    const friendList = document.getElementById("friendList");
    const friendCount = document.getElementById("friendCount");
    const refreshFriends = () => {
      const s = Store.load();
      const friends = s.friends || [];
      friendCount.textContent = `${friends.length} friend${friends.length === 1 ? "" : "s"}`;
      friendList.innerHTML = friends.length === 0
        ? `<div style="opacity:.5;font-size:11px;padding:4px 0">No friends yet. share your Skald ID with someone.</div>`
        : friends.map((f, i) =>
            `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(212,173,106,.08)">`
          + `<span style="color:#f4d49a;font-weight:600">${(f.name || "?").slice(0, 24)}</span>`
          + `<span style="color:rgba(255,255,255,.55);font-size:10px;font-family:ui-monospace,monospace">${(f.id || "").slice(0, 12)}…</span>`
          + `<span style="color:rgba(122,217,255,.8);font-weight:600">${(f.bestScore || 0).toLocaleString()}</span>`
          + `<button data-fi="${i}" class="friendDel" style="background:none;border:none;color:rgba(255,100,100,.5);cursor:pointer;font-size:14px;padding:0 4px">×</button>`
          + `</div>`
        ).join("");
      // Wire delete buttons
      friendList.querySelectorAll(".friendDel").forEach(btn => {
        btn.addEventListener("click", () => {
          const i = parseInt(btn.dataset.fi);
          const s = Store.load();
          s.friends = (s.friends || []).filter((_, idx) => idx !== i);
          Store.save(s);
          refreshFriends();
        });
      });
    };
    if (friendAddBtn) {
      friendAddBtn.addEventListener("click", () => {
        const id = (friendInput.value || "").trim();
        if (id.length < 8) { this._showSyncResult("Skald ID looks too short.", "err"); return; }
        if (id === Store.getSkaldId()) { this._showSyncResult("That's your own ID.", "warn"); return; }
        const s = Store.load();
        s.friends = s.friends || [];
        if (s.friends.find(f => f.id === id)) { this._showSyncResult("Already in your friends.", "warn"); return; }
        // Optimistic add. if ElataSync provides a friend lookup we'll
        // hydrate name+bestScore later; otherwise placeholder values.
        s.friends.push({ id, name: id.slice(0, 8), bestScore: 0, addedAt: Date.now() });
        Store.save(s);
        friendInput.value = "";
        refreshFriends();
        this._showSyncResult("Friend added. They'll appear with their next published run.", "ok");
        // If host provides a friend-fetch API, kick off a hydrate.
        if (window.ElataSync?.fetchFriend) {
          window.ElataSync.fetchFriend(id).then(data => {
            if (!data) return;
            const ss = Store.load();
            const f = (ss.friends || []).find(x => x.id === id);
            if (f) { Object.assign(f, data); Store.save(ss); refreshFriends(); }
          }).catch(() => {});
        }
      });
    }
    refreshFriends();

    // LANGUAGE PICKER. persists; applies on next refresh.
    const langPicker = document.getElementById("langPicker");
    if (langPicker) {
      langPicker.value = localStorage.getItem("valhalla.lang") || (navigator.language || "en").slice(0, 2);
      if (!I18N_DICT[langPicker.value]) langPicker.value = "en";
      langPicker.addEventListener("change", () => {
        localStorage.setItem("valhalla.lang", langPicker.value);
        this._showSyncResult(I18N("changesAfterRefresh"), "ok");
        // Live-apply the strings we have IDs for, even before refresh.
        this._applyI18n();
      });
    }

    // PWA install button. wire only if browser fired beforeinstallprompt.
    const installBtn = document.getElementById("installPwaBtn");
    if (installBtn) {
      if (window.__valhallaInstallPrompt) installBtn.style.display = "inline-block";
      installBtn.addEventListener("click", async () => {
        const promptEvt = window.__valhallaInstallPrompt;
        if (!promptEvt) {
          this._showSyncResult("Install prompt not available. try Add to Home Screen from your browser menu.", "warn");
          return;
        }
        promptEvt.prompt();
        const choice = await promptEvt.userChoice;
        if (choice.outcome === "accepted") {
          this._showSyncResult("Installed. Look for the Valhalla icon on your home screen.", "ok");
          installBtn.style.display = "none";
          window.__valhallaInstallPrompt = null;
        } else {
          this._showSyncResult("Install cancelled.", "warn");
        }
      });
    }

    // Daily reminder notification setup.
    const remTime = document.getElementById("reminderTime");
    const remToggle = document.getElementById("reminderToggle");
    const remStatus = document.getElementById("reminderStatus");
    const refreshReminderUI = () => {
      const enabled = localStorage.getItem("valhalla.reminderEnabled") === "1";
      const time = localStorage.getItem("valhalla.reminderTime") || "20:00";
      const perm = (typeof Notification !== "undefined") ? Notification.permission : "unsupported";
      if (remTime) remTime.value = time;
      if (remToggle) {
        remToggle.textContent = enabled ? "Disable" : "Enable";
        remToggle.style.background = enabled ? "rgba(120,200,140,.2)" : "rgba(212,173,106,.15)";
      }
      if (remStatus) {
        if (perm === "unsupported") remStatus.textContent = "Browser doesn't support notifications";
        else if (perm === "denied") remStatus.textContent = "Notifications blocked. re-enable in browser settings";
        else if (enabled && perm === "granted") remStatus.textContent = `On. your Skald will call at ${time} when the tab is open`;
        else if (enabled) remStatus.textContent = "Pending. click Enable to grant permission";
        else remStatus.textContent = "Off. Skald won't bug you";
      }
    };
    refreshReminderUI();
    if (remToggle) {
      remToggle.addEventListener("click", async () => {
        if (typeof Notification === "undefined") {
          this._showSyncResult("This browser doesn't support notifications.", "err");
          return;
        }
        const enabled = localStorage.getItem("valhalla.reminderEnabled") === "1";
        if (enabled) {
          localStorage.setItem("valhalla.reminderEnabled", "0");
          if (this._reminderHandle) { clearTimeout(this._reminderHandle); this._reminderHandle = null; }
          this._showSyncResult("Daily reminder turned off.", "ok");
        } else {
          let perm = Notification.permission;
          if (perm === "default") perm = await Notification.requestPermission();
          if (perm !== "granted") {
            this._showSyncResult("Permission denied. enable in browser settings.", "err");
            refreshReminderUI();
            return;
          }
          localStorage.setItem("valhalla.reminderEnabled", "1");
          localStorage.setItem("valhalla.reminderTime", remTime?.value || "20:00");
          this._scheduleNextReminder();
          this._showSyncResult("Reminder set. Skald will call you daily.", "ok");
        }
        refreshReminderUI();
      });
    }
    if (remTime) {
      remTime.addEventListener("change", () => {
        localStorage.setItem("valhalla.reminderTime", remTime.value);
        if (localStorage.getItem("valhalla.reminderEnabled") === "1") this._scheduleNextReminder();
        refreshReminderUI();
      });
    }

    // Graphics quality picker. applies on next refresh.
    const qPicker = document.getElementById("qualityPicker");
    const qCurrent = document.getElementById("qualityCurrent");
    if (qPicker && qCurrent) {
      qPicker.value = localStorage.getItem("valhalla.quality") || "";
      qCurrent.textContent = `Detected: ${this.quality || ". "}`;
      qPicker.addEventListener("change", () => {
        const v = qPicker.value;
        if (v) localStorage.setItem("valhalla.quality", v);
        else   localStorage.removeItem("valhalla.quality");
        this._showSyncResult("Refresh the page to apply the new graphics quality.", "ok");
      });
    }

    // Restore from pasted text. Accepts either the raw save string OR
    // a full share URL (extracts the #save=… part).
    document.getElementById("syncRestoreSave").addEventListener("click", () => {
      const ta = document.getElementById("syncSavePaste");
      let s = (ta.value || "").trim();
      if (!s) { this._showSyncResult("Paste a save or share-link first.", "err"); return; }
      const m = s.match(/#save=(.+)$/);
      if (m) s = m[1];
      if (!confirm("Restore this save? This will REPLACE your current progress on this device.")) return;
      try {
        Store.importString(s);
        this._showSyncResult("Save restored! Refreshing…", "ok");
        // Re-render stats panels.
        setTimeout(() => {
          this._loadStats();
          this._refreshSkaldLine();
          refreshDialog();
        }, 300);
      } catch (e) {
        console.warn("[Sync] restore failed", e);
        this._showSyncResult(`Couldn't restore: ${e.message || "bad save text"}`, "err");
      }
    });
  }

  // Tiny toast inside the sync dialog. kind: ok | warn | err
  _showSyncResult(msg, kind) {
    const el = document.getElementById("syncResult");
    if (!el) return;
    const colour = kind === "err" ? "#ff8a7a" : kind === "warn" ? "#ffd066" : "#a3e8b8";
    el.style.color = colour;
    el.textContent = msg;
    clearTimeout(this._syncResultT);
    this._syncResultT = setTimeout(() => { el.textContent = ""; }, 5000);
  }

  // DERIVE PUNISH STATES from the raw bio signal. Layered on top of
  // the SDK's positive-state classification. Sets this.cognitiveState
  // to "stress" / "fatigue" / "recovery" when the body signals show
  // these clearly, OVERRIDING the SDK state. This is the loss-aversion
  // engine: the user feels the cost of tensing up, not just the
  // reward of relaxing.
  //
  // Heuristics use rolling 8-sample windows of BPM + HRV. SDK fires
  // ~4 Hz so the window is ~2 seconds.
  _derivePunishStates() {
    if (!this._bpmWindow) { this._bpmWindow = []; this._hrvWindow = []; this._lastPunish = 0; }
    if (typeof this.bpm === "number") {
      this._bpmWindow.push(this.bpm);
      if (this._bpmWindow.length > 8) this._bpmWindow.shift();
    }
    if (typeof this.hrv === "number") {
      this._hrvWindow.push(this.hrv);
      if (this._hrvWindow.length > 8) this._hrvWindow.shift();
    }
    if (this._bpmWindow.length < 4) return;
    const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const bpmAvg = avg(this._bpmWindow);
    const hrvAvg = this._hrvWindow.length >= 3 ? avg(this._hrvWindow) : null;
    const bpmRecent = this._bpmWindow[this._bpmWindow.length - 1];
    const bpmDelta = bpmRecent - bpmAvg;

    // STRESS: pulse spiking AND (if EEG available) low calm. Also
    // pulse simply running 25+ above session baseline.
    const stressed = (bpmDelta > 8 && hrvAvg !== null && hrvAvg < 25)
                  || (bpmRecent > 95 && this.calmLevel !== null && this.calmLevel < 0.3);
    // FATIGUE: sustained low pulse, low HRV, no positive cognitive state.
    const fatigued = bpmRecent < 60 && hrvAvg !== null && hrvAvg < 22
                  && this.focusLevel !== null && this.focusLevel < 0.3;

    // Don't fight the SDK if it asserted a strong positive state
    // recently (the user is genuinely in flow).
    const positive = ["flow", "focused", "calm", "berserker", "meditation"];
    const sdkPositive = positive.includes(this.cognitiveState);
    const now = performance.now();
    if (stressed && !sdkPositive && (now - this._lastPunish) > 1500) {
      this._lastPunish = now;
      this.cognitiveState = "stress";
      this._updateMultiplier("stress");
    } else if (fatigued && !sdkPositive && (now - this._lastPunish) > 1500) {
      this._lastPunish = now;
      this.cognitiveState = "fatigue";
      this._updateMultiplier("fatigue");
    }
  }

  // BIO CALIBRATION RITUAL. 60s 4-4-6 box-breathing overlay shown
  // the first time a sensor goes live for this profile. Records bio
  // baseline at completion. Skippable. Skipped permanently once
  // completed (per-profile flag).
  _maybeStartCalibration() {
    const s = Store.load();
    if (s.calibrationDone) return;
    if (this._calibrationActive) return;
    // Don't pop the ritual mid-run.
    if (this.running) return;
    this._runCalibrationRitual();
  }

  _runCalibrationRitual() {
    const overlay = document.getElementById("bioCalibration");
    const label = document.getElementById("calibLabel");
    const circle = document.getElementById("calibCircle");
    const counter = document.getElementById("calibCounter");
    const progress = document.getElementById("calibProgressText");
    const skip = document.getElementById("calibSkip");
    if (!overlay) return;
    this._calibrationActive = true;
    overlay.style.display = "flex";

    // Box pattern: inhale 4s -> hold 4s -> exhale 6s = 14s per cycle.
    // 6 cycles = 84s, but we cap at 6 cycles ≈ 60-90s. Skip allowed any time.
    const PHASES = [
      { name: "Breathe in",   dur: 4, scale: 1.7, colour: "rgba(122,217,255,.5)" },
      { name: "Hold",         dur: 4, scale: 1.7, colour: "rgba(244,212,154,.4)" },
      { name: "Breathe out",  dur: 6, scale: 1.0, colour: "rgba(122,217,255,.2)" },
    ];
    const TOTAL_CYCLES = 6;
    let cycle = 0;
    let phaseIdx = 0;
    let phaseStart = performance.now();
    let stopped = false;

    const cleanup = (completed) => {
      stopped = true;
      overlay.style.display = "none";
      this._calibrationActive = false;
      if (completed) {
        const s = Store.load();
        s.calibrationDone = true;
        s.calibrationDate = new Date().toISOString().slice(0, 10);
        // Capture baselines if we have them
        if (this.bpm) s.calibrationBaselineBpm = this.bpm;
        Store.save(s);
        console.log("[Valhalla] calibration ritual completed");
      }
    };
    skip.onclick = () => cleanup(false);

    const tick = () => {
      if (stopped) return;
      const phase = PHASES[phaseIdx];
      const t = (performance.now() - phaseStart) / 1000;
      const remaining = Math.max(0, phase.dur - t);
      counter.textContent = Math.ceil(remaining).toString();
      label.textContent = phase.name;
      // Animate circle on phase entry
      if (t < 0.05) {
        circle.style.transition = `transform ${phase.dur}s cubic-bezier(.4,.0,.2,1),background ${phase.dur}s ease`;
        circle.style.transform = `scale(${phase.scale})`;
        circle.style.background = `radial-gradient(circle,${phase.colour} 0%,rgba(122,217,255,.05) 60%,transparent 100%)`;
      }
      if (t >= phase.dur) {
        phaseIdx = (phaseIdx + 1) % PHASES.length;
        if (phaseIdx === 0) {
          cycle++;
          progress.textContent = `Cycle ${cycle + 1} / ${TOTAL_CYCLES}`;
          if (cycle >= TOTAL_CYCLES) { cleanup(true); return; }
        }
        phaseStart = performance.now();
      }
      requestAnimationFrame(tick);
    };
    progress.textContent = `Cycle 1 / ${TOTAL_CYCLES}`;
    tick();
  }

  // SHARE RUN. auto-generate a 1080x1080 canvas card summarising the
  // last run (score, distance, mead, bio time, biome reached) on a
  // Norse-themed background. Uses Web Share API on mobile or falls
  // back to download. The card is the viral loop: every Skald who
  // shares one is a recruitment poster for Valhalla.
  async _shareRun() {
    const s = Store.load();
    const bs = this.bioSession || {};
    const W = 1080, H = 1080;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");

    // Background: dark Cinzel-bronze gradient
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0,   "#1a120a");
    bg.addColorStop(0.5, "#0e0905");
    bg.addColorStop(1,   "#06050a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Subtle vignette
    const vg = ctx.createRadialGradient(W/2, H/2, W*0.3, W/2, H/2, W*0.75);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.7)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    // Bronze border
    ctx.strokeStyle = "rgba(212,173,106,0.5)";
    ctx.lineWidth = 4;
    ctx.strokeRect(30, 30, W - 60, H - 60);

    // Title
    ctx.fillStyle = "#f4d49a";
    ctx.font = "italic 600 36px 'Cinzel', serif";
    ctx.textAlign = "center";
    ctx.fillText("VALHALLA · SKALD'S RUN", W/2, 130);

    // Skald name
    ctx.fillStyle = "rgba(244,212,154,0.8)";
    ctx.font = "italic 300 30px 'Cinzel', serif";
    ctx.fillText(`.  ${Store.getSkaldName()} . `, W/2, 190);

    // Big score
    ctx.fillStyle = "#fff";
    ctx.font = "bold 180px 'Cinzel', serif";
    ctx.fillText(Math.floor(this.score).toLocaleString(), W/2, 410);

    ctx.fillStyle = "rgba(212,173,106,0.65)";
    ctx.font = "600 22px 'Cinzel', serif";
    ctx.fillText("SCORE", W/2, 450);

    // Three stats row
    const statRow = (x, label, val, colour) => {
      ctx.fillStyle = colour || "#fff";
      ctx.font = "bold 64px 'Cinzel', serif";
      ctx.fillText(val, x, 600);
      ctx.fillStyle = "rgba(212,173,106,0.55)";
      ctx.font = "600 18px 'Cinzel', serif";
      ctx.fillText(label, x, 640);
    };
    statRow(W * 0.20, "DISTANCE", `${Math.round(this.distance)}m`);
    statRow(W * 0.50, "REALM",    this.biomeName || "Midgard", "#a3b8ff");
    statRow(W * 0.80, "MEAD",     this.mead.toString(), "#ffd066");

    // Bio summary row (only if had bio data)
    if (bs.flowSec > 0.5 || bs.calmSec > 0.5 || bs.focusedSec > 0.5) {
      ctx.fillStyle = "rgba(212,173,106,0.55)";
      ctx.font = "600 18px 'Cinzel', serif";
      ctx.fillText("· BODY ·", W/2, 740);
      const bioRow = (x, label, val, colour) => {
        ctx.fillStyle = colour;
        ctx.font = "bold 42px 'Cinzel', serif";
        ctx.fillText(val, x, 810);
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.font = "600 16px 'Cinzel', serif";
        ctx.fillText(label, x, 840);
      };
      if (bs.flowSec    > 0.5) bioRow(W * 0.22, "FLOW",    `${Math.round(bs.flowSec)}s`,    "#7ad9ff");
      if (bs.focusedSec > 0.5) bioRow(W * 0.50, "FOCUSED", `${Math.round(bs.focusedSec)}s`, "#a3b8ff");
      if (bs.calmSec    > 0.5) bioRow(W * 0.78, "CALM",    `${Math.round(bs.calmSec)}s`,    "#80d0e0");
    }

    // Streak + saga footer
    ctx.fillStyle = "rgba(244,212,154,0.8)";
    ctx.font = "italic 600 26px 'Cinzel', serif";
    const fLine = [];
    if ((s.streak || 0) > 0)      fLine.push(`🔥 ${s.streak}-day streak`);
    if ((s.totalCycles || 0) > 0) fLine.push(`${s.totalCycles} saga${s.totalCycles > 1 ? "s" : ""} walked`);
    ctx.fillText(fLine.join("  ·  ") || "First steps in Midgard", W/2, 940);

    // Bottom-right URL
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "600 18px 'Cinzel', serif";
    ctx.textAlign = "right";
    ctx.fillText("valhalla · brain app store", W - 60, 1020);

    // Convert to blob
    const blob = await new Promise(res => c.toBlob(res, "image/png"));
    if (!blob) {
      console.warn("[Share] toBlob returned null");
      return;
    }
    const file = new File([blob], `valhalla-${Math.floor(this.score)}.png`, { type: "image/png" });

    // Native Web Share with file if supported (mobile), else download
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: "Valhalla. Skald's Run",
          text: `I scored ${Math.floor(this.score).toLocaleString()} in Valhalla.`,
          files: [file],
        });
        return;
      }
    } catch (e) {
      console.warn("[Share] native share failed, falling back to download", e);
    }
    // Fallback: download
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 500);
  }

  // Daily reminder scheduler. Fires a browser notification at the
  // user-chosen time. Note: this only works while the tab is open
  // (no service worker yet. that comes in Phase 4b PWA pass).
  _scheduleNextReminder() {
    if (this._reminderHandle) { clearTimeout(this._reminderHandle); this._reminderHandle = null; }
    if (localStorage.getItem("valhalla.reminderEnabled") !== "1") return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const time = localStorage.getItem("valhalla.reminderTime") || "20:00";
    const [hh, mm] = time.split(":").map(Number);
    if (isNaN(hh) || isNaN(mm)) return;
    const now = new Date();
    const next = new Date();
    next.setHours(hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    this._reminderHandle = setTimeout(() => {
      try {
        const s = Store.load();
        const streak = s.streak || 0;
        const bodyLine = streak >= 2
          ? `Keep your ${streak}-day streak alive. The realms await.`
          : "Time for Valhalla. the realms await.";
        new Notification("⚔ Your Skald calls", {
          body: bodyLine,
          icon: "/favicon.ico",
          tag: "valhalla-daily",
          requireInteraction: false,
        });
      } catch (e) { console.warn("[Valhalla] notification failed", e); }
      this._scheduleNextReminder();   // schedule next day
    }, delay);
  }

  // On boot, if the host (Elata App Store) injected ElataSync, do an
  // initial pull so the device immediately reflects whatever progress
  // the user already had on other devices. Subsequent saves auto-
  // push via Store.save → _maybeCloudPush().
  async _bootCloudSync() {
    if (!Store.isCloudAvailable()) return;
    const result = await Store.cloudPull();
    if (result.ok && result.action === "pulled") {
      // Refresh visible state since we now have new data.
      this._loadStats();
      this._refreshSkaldLine();
      console.log("[Sync] pulled save from cloud");
    } else if (result.ok && result.action === "pushed") {
      console.log("[Sync] pushed local save to cloud (cloud was older)");
    } else if (result.ok && result.action === "pushed-initial") {
      console.log("[Sync] cloud was empty; pushed local save");
    }
  }

  _saveStats() {
    const s = Store.load();
    s.bestScore = Math.max(s.bestScore || 0, this.score);
    s.bestDist = Math.max(s.bestDist || 0, this.distance);
    s.totalRuns = (s.totalRuns || 0) + 1;
    s.totalScore = (s.totalScore || 0) + this.score;
    s.totalMead = (s.totalMead || 0) + this.mead;

    // LIFETIME STATS. the spine of the badge progression. Accumulates
    // across every run forever so badges have a real long-term curve.
    const bs = this.bioSession || {};
    const life = s.lifetime || {};
    life.runs       = (life.runs       || 0) + 1;
    life.score      = (life.score      || 0) + Math.floor(this.score);
    life.distance   = (life.distance   || 0) + Math.round(this.distance);
    life.mead       = (life.mead       || 0) + (this.mead || 0);
    life.runes      = (life.runes      || 0) + (this.runRunes || 0);
    life.bossKills  = (life.bossKills  || 0) + (this.runBossKills || 0);
    life.gifts      = (life.gifts      || 0) + (bs.giftsEarned || 0);
    life.flowSec    = (life.flowSec    || 0) + (bs.flowSec || 0);
    life.focusedSec = (life.focusedSec || 0) + (bs.focusedSec || 0);
    life.calmSec    = (life.calmSec    || 0) + (bs.calmSec || 0);
    s.lifetime = life;

    // DAILY QUEST progress. Hooked to the per-run totals so the menu's
    // "Today's deed" tile actually fills in as you play. Reward is
    // applied to this run's score at game-over too if it just completed.
    try {
      const q = s.dailyQuest;
      const todayK = new Date().toISOString().slice(0, 10);
      if (q && q.date === todayK && !q.done) {
        let inc = 0;
        if (q.id === "dist1500")  inc = Math.round(this.distance);
        if (q.id === "score3k")   inc = Math.floor(this.score);
        if (q.id === "runes10")   inc = (this.runRunes || 0);
        if (q.id === "flow60")    inc = Math.round(bs.flowSec || 0);
        if (q.id === "calm120")   inc = Math.round((bs.calmSec || 0) + (bs.focusedSec || 0) + (bs.meditationSec || 0));
        // dist1500/score3k are single-run thresholds (best of), others are daily-cumulative.
        if (q.id === "dist1500" || q.id === "score3k") {
          q.progress = Math.max(q.progress || 0, inc);
        } else {
          q.progress = (q.progress || 0) + inc;
        }
        const targets = { dist1500:1500, score3k:3000, runes10:10, flow60:60, calm120:120, bossKill2:2 };
        if (q.progress >= (targets[q.id] || 1)) {
          q.done = true;
          this._popText("DEED FULFILLED", "rune", 0, -60);
        }
      }
    } catch (e) { console.warn("[daily quest update]", e); }

    // SAGA PROGRESS. record the farthest realm reached and total
    // full cycles completed. Drives the menu's saga line + future
    // honour-based content unlocks.
    const realmOrder = ["Midgard", "Jötunheim", "Muspelheim", "Asgard"];
    const reachedIdx = realmOrder.indexOf(this.biomeName || "Midgard");
    const knownIdx   = realmOrder.indexOf(s.farthestRealm || "Midgard");
    if (reachedIdx > knownIdx) s.farthestRealm = this.biomeName;
    // biomeCycle is incremented in _transitionBiome when wrapping back
    // to Midgard after Asgard. Save the max we've ever reached.
    s.totalCycles = Math.max(s.totalCycles || 0, this.biomeCycle || 0);

    // LEADERBOARD. top 10 scores all-time, kept in localStorage.
    const board = Array.isArray(s.leaderboard) ? s.leaderboard.slice() : [];
    const today = new Date().toISOString().slice(0, 10);
    board.push({
      score: Math.floor(this.score),
      dist: Math.round(this.distance),
      mead: this.mead,
      date: today,
    });
    board.sort((a, b) => b.score - a.score);
    s.leaderboard = board.slice(0, 10);

    // DAILY ROLLUP. keyed by YYYY-MM-DD. Powers the trends panel +
    // nudge engine. Now also tracks PUNISH state seconds (stress /
    // fatigue) for loss-aversion nudges, and HRV average for the
    // recovery-warning nudge.
    const daily = s.daily || {};
    const today_ = daily[today] || {
      flowSec: 0, focusedSec: 0, calmSec: 0, meditationSec: 0,
      stressSec: 0, fatigueSec: 0,
      runs: 0, bestScore: 0, bossKills: 0, runes: 0, distance: 0,
      hrvAvg: 0, hrvSamples: 0,
    };
    today_.runs      += 1;
    today_.flowSec   += (bs.flowSec || 0);
    today_.focusedSec+= (bs.focusedSec || 0);
    today_.calmSec   += (bs.calmSec || 0);
    today_.meditationSec = (today_.meditationSec || 0) + (bs.meditationSec || 0);
    today_.stressSec  = (today_.stressSec || 0) + (bs.stressSec || 0);
    today_.fatigueSec = (today_.fatigueSec || 0) + (bs.fatigueSec || 0);
    today_.bossKills += (this.runBossKills || 0);
    today_.runes     += (this.runRunes || 0);
    today_.distance  += Math.round(this.distance);
    today_.bestScore = Math.max(today_.bestScore, Math.floor(this.score));
    // HRV running avg across the day so the recovery nudge has real data.
    if (bs.hrvSamples > 0) {
      const todayHRV = bs.sumHRV / bs.hrvSamples;
      const prevSamples = today_.hrvSamples || 0;
      const newSamples = prevSamples + bs.hrvSamples;
      today_.hrvAvg = ((today_.hrvAvg || 0) * prevSamples + todayHRV * bs.hrvSamples) / newSamples;
      today_.hrvSamples = newSamples;
    }
    daily[today] = today_;
    // Prune anything older than 60 days so localStorage doesn't bloat.
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 60);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (const key of Object.keys(daily)) {
      if (key < cutoffStr) delete daily[key];
    }
    s.daily = daily;

    // DAILY STREAK + STREAK FREEZE (Duolingo-style).
    // - Every 7 streak days earns a freeze, max 3 stored.
    // - If user missed exactly 1 day and has >=1 freeze, auto-consume
    //   one and preserve the streak. Otherwise streak resets to 1.
    // - >=2 missed days resets regardless (freezes only cover 1 day).
    if (s.lastPlayDate !== today) {
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      const twoDaysAgo = new Date(); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      const ydStr = yesterday.toISOString().slice(0, 10);
      const twoStr = twoDaysAgo.toISOString().slice(0, 10);
      const prevStreak = s.streak || 0;
      let consumedFreeze = false;
      if (s.lastPlayDate === ydStr) {
        s.streak = prevStreak + 1;
      } else if (s.lastPlayDate === twoStr && (s.streakFreezes || 0) >= 1) {
        // Missed exactly 1 day, freeze available. consume and extend
        s.streakFreezes = (s.streakFreezes || 0) - 1;
        s.streak = prevStreak + 1;
        consumedFreeze = true;
        s.lastFreezeUsedDate = today;
      } else {
        s.streak = 1;
      }
      s.lastPlayDate = today;
      // Earn a freeze every 7 streak days (when crossing the multiple).
      if (s.streak > prevStreak && s.streak % 7 === 0 && (s.streakFreezes || 0) < 3) {
        s.streakFreezes = (s.streakFreezes || 0) + 1;
        s.lastFreezeEarnedDate = today;
      }
      // Stash for the nudge / over-screen to surface.
      this._streakFreezeConsumed = consumedFreeze;
    }
    s.bestStreak = Math.max(s.bestStreak || 0, s.streak || 0);

    // TIERED BADGES. unlocked from lifetime stats. The unlock loop is
    // driven by the _allBadges() definitions themselves so adding a
    // new badge is one line of data, not new code paths.
    const badges = new Set(s.badges || []);
    for (const b of this._allBadges()) {
      const val = this._badgeMetricValue(b.metric, s);
      if (val >= b.threshold) badges.add(b.id);
    }
    s.badges = Array.from(badges);

    Store.save(s);
  }

  // Resolve a metric name (used by badge definitions) to its current
  // value from the stats blob. Centralises so badges and progress bars
  // share the same lookup table.
  _badgeMetricValue(metric, s) {
    const life = s.lifetime || {};
    switch (metric) {
      case "runs":         return life.runs       || 0;
      case "bestDist":     return s.bestDist      || 0;
      case "bestScore":    return s.bestScore     || 0;
      case "streak":       return s.bestStreak    || s.streak || 0;
      case "lifeRunes":    return life.runes      || 0;
      case "lifeBoss":     return life.bossKills  || 0;
      case "lifeGifts":    return life.gifts      || 0;
      case "lifeFlow":     return life.flowSec    || 0;
      case "lifeFocused":  return life.focusedSec || 0;
      case "lifeCalm":     return life.calmSec    || 0;
      case "lifeDistance": return life.distance   || 0;
      case "lifeMead":     return life.mead       || 0;
      default: return 0;
    }
  }

  // TIERED BADGES. Bronze/Silver/Gold/Mythic for each progression
  // axis. Real long-term retention: ~40 badges, most need lifetime
  // play to unlock. Each tier's threshold is 4-8x the previous so the
  // unlock cadence stays satisfying for a long time.
  _allBadges() {
    return [
      // FIRST STEPS. earliest unlocks, day-1 reinforcement
      { id: "first_run",      label: "First Run",       icon: "🏃", metric: "runs", threshold: 1,   group: "Journey", tier: "Bronze" },
      { id: "ten_runs",       label: "Wanderer",        icon: "🧭", metric: "runs", threshold: 10,  group: "Journey", tier: "Silver" },
      { id: "fifty_runs",     label: "Pilgrim",         icon: "⛺", metric: "runs", threshold: 50,  group: "Journey", tier: "Gold"   },
      { id: "two_fifty_runs", label: "Saga-Bearer",     icon: "📜", metric: "runs", threshold: 250, group: "Journey", tier: "Mythic" },

      // DISTANCE. single run best
      { id: "dist_500",   label: "500m",   icon: "🏔", metric: "bestDist", threshold: 500,   group: "Distance", tier: "Bronze" },
      { id: "dist_1k",    label: "1km",    icon: "🛡", metric: "bestDist", threshold: 1000,  group: "Distance", tier: "Silver" },
      { id: "dist_5k",    label: "5km",    icon: "⚓", metric: "bestDist", threshold: 5000,  group: "Distance", tier: "Gold"   },
      { id: "dist_25k",   label: "25km",   icon: "🐉", metric: "bestDist", threshold: 25000, group: "Distance", tier: "Mythic" },

      // SCORE. single run best
      { id: "score_5k",   label: "5K Skald",  icon: "⚔", metric: "bestScore", threshold: 5000,   group: "Score", tier: "Bronze" },
      { id: "score_25k",  label: "25K Jarl",  icon: "👑", metric: "bestScore", threshold: 25000,  group: "Score", tier: "Silver" },
      { id: "score_100k", label: "100K King", icon: "🏰", metric: "bestScore", threshold: 100000, group: "Score", tier: "Gold"   },
      { id: "score_500k", label: "Allfather", icon: "🌟", metric: "bestScore", threshold: 500000, group: "Score", tier: "Mythic" },

      // STREAK. daily play retention
      { id: "streak_3",   label: "3-Day Streak",  icon: "🔥", metric: "streak", threshold: 3,   group: "Streak", tier: "Bronze" },
      { id: "streak_7",   label: "7-Day Streak",  icon: "⚡", metric: "streak", threshold: 7,   group: "Streak", tier: "Silver" },
      { id: "streak_30",  label: "30-Day Streak", icon: "🌙", metric: "streak", threshold: 30,  group: "Streak", tier: "Gold"   },
      { id: "streak_100", label: "100-Day Streak",icon: "☀", metric: "streak", threshold: 100, group: "Streak", tier: "Mythic" },

      // BOSS KILLS. lifetime
      { id: "boss_1",     label: "First Slay",     icon: "🗡", metric: "lifeBoss", threshold: 1,    group: "Bosses", tier: "Bronze" },
      { id: "boss_10",    label: "Giant-Slayer",   icon: "⚔", metric: "lifeBoss", threshold: 10,   group: "Bosses", tier: "Silver" },
      { id: "boss_50",    label: "Berserker-King", icon: "🪓", metric: "lifeBoss", threshold: 50,   group: "Bosses", tier: "Gold"   },
      { id: "boss_250",   label: "Ragnarök",       icon: "💀", metric: "lifeBoss", threshold: 250,  group: "Bosses", tier: "Mythic" },

      // RUNES. lifetime collected
      { id: "rune_10",    label: "First Runes",   icon: "ᚱ", metric: "lifeRunes", threshold: 10,    group: "Runes", tier: "Bronze" },
      { id: "rune_100",   label: "Rune-Reader",   icon: "ᚦ", metric: "lifeRunes", threshold: 100,   group: "Runes", tier: "Silver" },
      { id: "rune_1000",  label: "Runemaster",    icon: "ᚷ", metric: "lifeRunes", threshold: 1000,  group: "Runes", tier: "Gold"   },
      { id: "rune_10000", label: "Skald of Mímir",icon: "ᚹ", metric: "lifeRunes", threshold: 10000, group: "Runes", tier: "Mythic" },

      // FLOW. lifetime seconds (the headline bio achievement)
      { id: "flow_30",    label: "Touch of Flow",   icon: "🌊", metric: "lifeFlow", threshold: 30,   group: "Flow", tier: "Bronze" },
      { id: "flow_5m",    label: "5 min in Flow",   icon: "🧠", metric: "lifeFlow", threshold: 300,  group: "Flow", tier: "Silver" },
      { id: "flow_30m",   label: "30 min in Flow",  icon: "💫", metric: "lifeFlow", threshold: 1800, group: "Flow", tier: "Gold"   },
      { id: "flow_3h",    label: "Lord of Flow",    icon: "🔱", metric: "lifeFlow", threshold: 10800,group: "Flow", tier: "Mythic" },

      // CALM. lifetime seconds (the breathwork badge)
      { id: "calm_1m",    label: "Settled Mind",  icon: "🍃", metric: "lifeCalm", threshold: 60,    group: "Calm", tier: "Bronze" },
      { id: "calm_15m",   label: "Calm Spirit",   icon: "🪷", metric: "lifeCalm", threshold: 900,   group: "Calm", tier: "Silver" },
      { id: "calm_2h",    label: "Sage",          icon: "🧘", metric: "lifeCalm", threshold: 7200,  group: "Calm", tier: "Gold"   },
      { id: "calm_10h",   label: "Bodhisattva",   icon: "☯", metric: "lifeCalm", threshold: 36000, group: "Calm", tier: "Mythic" },

      // FOCUS. lifetime seconds
      { id: "focus_1m",  label: "Sharpened",       icon: "👁", metric: "lifeFocused", threshold: 60,    group: "Focus", tier: "Bronze" },
      { id: "focus_15m", label: "Hawk-Eyed",       icon: "🦅", metric: "lifeFocused", threshold: 900,   group: "Focus", tier: "Silver" },
      { id: "focus_2h",  label: "Eyes of Heimdall",icon: "🌈", metric: "lifeFocused", threshold: 7200,  group: "Focus", tier: "Gold"   },
      { id: "focus_10h", label: "All-Seeing",      icon: "🔮", metric: "lifeFocused", threshold: 36000, group: "Focus", tier: "Mythic" },

      // GIFTS. bio-earned powerups (validates the SDK loop)
      { id: "gift_1",    label: "First Gift",   icon: "🎁", metric: "lifeGifts", threshold: 1,    group: "Gifts", tier: "Bronze" },
      { id: "gift_25",   label: "Blessed",      icon: "✨", metric: "lifeGifts", threshold: 25,   group: "Gifts", tier: "Silver" },
      { id: "gift_100",  label: "Favoured",     icon: "🏵", metric: "lifeGifts", threshold: 100,  group: "Gifts", tier: "Gold"   },
      { id: "gift_500",  label: "Chosen of Odin",icon: "🦉", metric: "lifeGifts", threshold: 500,  group: "Gifts", tier: "Mythic" },
    ];
  }

  // Build the post-run dashboard on the game-over card:
  //   1. Today's recap (runs played today, flow seconds, bossKills, etc.)
  //   2. 7-day flow-seconds bar chart (visible progression over time)
  //   3. Top-10 leaderboard
  //   4. Tiered badge grid grouped by progression axis, with the next
  //      not-yet-earned tier of each group showing live progress.
  _injectScoreboard() {
    const card = document.querySelector("#overOverlay .card");
    if (!card) return;
    const s = Store.load();
    let host = card.querySelector("#scoreboard");
    if (!host) {
      host = document.createElement("div");
      host.id = "scoreboard";
      host.style.cssText =
        "margin:18px 0 4px;padding:18px 0 0;"
        + "border-top:1px solid rgba(212,173,106,.22);text-align:left;"
        + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;";
      const actions = card.querySelector(".actions");
      card.insertBefore(host, actions || null);
    }

    // ----- Today's recap ----------------------------------------------
    const todayStr = new Date().toISOString().slice(0, 10);
    const today = (s.daily || {})[todayStr] || {};
    const todayBits = [];
    if (today.runs)      todayBits.push(`<b style="color:#f4d49a">${today.runs}</b> runs`);
    if (today.flowSec >= 1)   todayBits.push(`<b style="color:#7ad9ff">${Math.round(today.flowSec)}s</b> flow`);
    if (today.calmSec >= 1)   todayBits.push(`<b style="color:#80d0e0">${Math.round(today.calmSec)}s</b> calm`);
    if (today.bossKills)      todayBits.push(`<b style="color:#ff8c5a">${today.bossKills}</b> bosses`);

    // ----- 7-day chart of flow seconds --------------------------------
    const labels = [];
    const data = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const day = (s.daily || {})[key];
      labels.push(d.toLocaleDateString(undefined, { weekday: "short" })[0]);
      data.push(day ? (day.flowSec + day.calmSec + day.focusedSec) : 0);
    }
    const maxBar = Math.max(1, ...data);
    const chartHtml = data.map((v, i) => {
      const h = Math.max(2, Math.round((v / maxBar) * 38));
      const isToday = i === 6;
      const bg = isToday ? "linear-gradient(180deg,#f4d49a,#c9a55c)" : "rgba(212,173,106,.4)";
      const txt = isToday ? "#f4d49a" : "rgba(255,255,255,.45)";
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1">`
           + `<div style="width:80%;height:${h}px;background:${bg};border-radius:2px 2px 0 0"></div>`
           + `<div style="font-size:9.5px;color:${txt};letter-spacing:.04em">${labels[i]}</div>`
           + `</div>`;
    }).join("");
    const bestThisWeek = Math.max(...data);
    const thisDay = data[6];
    const weekHint = thisDay > 0 && thisDay >= bestThisWeek
      ? `<span style="color:#f4d49a">Best bio day this week 🎉</span>`
      : (thisDay > 0
          ? `${Math.round(thisDay)}s of bio-state today`
          : `No bio-state yet today. pair to start`);

    // ----- Leaderboard ------------------------------------------------
    const todayScore = Math.floor(this.score);
    const board = (s.leaderboard || []).slice(0, 5);
    const rows = board.map((b, i) => {
      const isThis = b.score === todayScore && b.date === todayStr;
      const colour = isThis ? "#f4d49a" : "rgba(255,255,255,.78)";
      const weight = isThis ? 700 : 500;
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1) + ".";
      return `<div style="display:flex;justify-content:space-between;gap:12px;`
           + `padding:5px 0;color:${colour};font-weight:${weight};`
           + `font-size:13px;letter-spacing:.01em">`
           + `<span style="min-width:28px">${medal}</span>`
           + `<span style="flex:1;font-variant-numeric:tabular-nums">${b.score.toLocaleString()}</span>`
           + `<span style="opacity:.7">${b.dist}m</span>`
           + `<span style="opacity:.5;font-size:11px">${b.date.slice(5)}</span>`
           + `</div>`;
    }).join("");

    // ----- Tiered badges, grouped + progress to next tier --------------
    const all = this._allBadges();
    const earned = new Set(s.badges || []);
    // Group by axis (Journey, Distance, …)
    const groups = {};
    for (const b of all) {
      (groups[b.group] || (groups[b.group] = [])).push(b);
    }
    const TIER_COLOUR = {
      Bronze: "#c08868", Silver: "#cdd8df", Gold: "#f4d49a", Mythic: "#cba6ff",
    };
    const fmt = (n, metric) => {
      // Time-domain metrics formatted as duration; everything else as integer.
      const isTimeMetric = metric === "lifeFlow" || metric === "lifeFocused" || metric === "lifeCalm";
      if (isTimeMetric) {
        if (n >= 3600) return (n / 3600).toFixed(1) + "h";
        if (n >= 60)   return Math.round(n / 60) + "m";
        return Math.round(n) + "s";
      }
      return n.toLocaleString();
    };
    const groupHtml = Object.keys(groups).map(gname => {
      const tiers = groups[gname];
      const tierIcons = tiers.map(t => {
        const got = earned.has(t.id);
        const col = got ? TIER_COLOUR[t.tier] : "rgba(255,255,255,.18)";
        const op = got ? 1 : 0.35;
        return `<span title="${t.tier}: ${t.label}" style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${got ? "rgba(244,212,154,.12)" : "transparent"};border:1px solid ${col};font-size:13px;opacity:${op}">${t.icon}</span>`;
      }).join("");
      // Find next-not-yet-earned tier in this group for the progress bar.
      const nextTier = tiers.find(t => !earned.has(t.id));
      let progressBar = "";
      if (nextTier) {
        const val = this._badgeMetricValue(nextTier.metric, s);
        const pct = Math.min(100, (val / nextTier.threshold) * 100);
        progressBar = `<div style="margin-top:4px">`
          + `<div style="display:flex;justify-content:space-between;font-size:9.5px;color:rgba(255,255,255,.55);margin-bottom:2px">`
          + `<span>Next: <b style="color:${TIER_COLOUR[nextTier.tier]}">${nextTier.label}</b></span>`
          + `<span style="font-variant-numeric:tabular-nums">${fmt(val, nextTier.metric)} / ${fmt(nextTier.threshold, nextTier.metric)}</span>`
          + `</div>`
          + `<div style="height:3px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden">`
          + `<div style="height:100%;width:${pct}%;background:${TIER_COLOUR[nextTier.tier]};border-radius:2px"></div>`
          + `</div>`
          + `</div>`;
      } else {
        progressBar = `<div style="margin-top:4px;font-size:9.5px;color:${TIER_COLOUR.Mythic};text-align:right">All tiers earned ✦</div>`;
      }
      return `<div style="margin-bottom:10px">`
        + `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">`
        + `<div style="font:600 10px/1 'Cinzel',serif;letter-spacing:.18em;color:rgba(212,173,106,.78);text-transform:uppercase">${gname}</div>`
        + `<div style="display:flex;gap:4px">${tierIcons}</div>`
        + `</div>`
        + progressBar
        + `</div>`;
    }).join("");

    // Newly unlocked this run. surface them prominently as a NEW
    // HONOURS strip; the rest of the badges are collapsed.
    const beforeIds = new Set(this._badgeIdsBeforeRun || []);
    const newlyEarned = [...earned].filter(id => !beforeIds.has(id));
    const newlyHtml = newlyEarned.length
      ? newlyEarned.map(id => {
          const b = all.find(x => x.id === id);
          if (!b) return "";
          const col = TIER_COLOUR[b.tier] || "#f4d49a";
          return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(244,212,154,.08);border:1px solid ${col}55;border-radius:6px">`
               + `<span style="font-size:18px">${b.icon}</span>`
               + `<div><div style="font-size:11px;font-weight:700;color:${col};letter-spacing:.04em;text-transform:uppercase">${b.tier} · ${b.label}</div>`
               + `<div style="font-size:9.5px;color:rgba(255,255,255,.55);text-transform:uppercase;letter-spacing:.08em">${b.group}</div></div>`
               + `</div>`;
        }).join("")
      : "";

    // ----- Final HTML ----------------------------------------------------
    // Hierarchy: TODAY (the most personal info) → CHART (progression)
    // → NEW HONOURS this run (the dopamine hit) → details collapsed.
    host.innerHTML =
        // Today + streak
        `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">`
      + `<div style="font:600 10px/1 'Cinzel',serif;letter-spacing:.22em;text-transform:uppercase;color:rgba(212,173,106,.72)">Today</div>`
      + `<div style="font:600 10px/1 'Cinzel',serif;letter-spacing:.22em;text-transform:uppercase;color:#f4d49a">🔥 ${s.streak || 0}-day streak</div>`
      + `</div>`
      + `<div style="font-size:13px;color:rgba(255,255,255,.85);margin-bottom:16px;line-height:1.5">`
      + (todayBits.length ? todayBits.join(" · ") : "Your first run today!")
      + `</div>`
      // 7-day chart
      + `<div style="margin-bottom:6px;font:600 10px/1 'Cinzel',serif;letter-spacing:.22em;text-transform:uppercase;color:rgba(212,173,106,.72)">Last 7 days</div>`
      + `<div style="display:flex;align-items:flex-end;gap:4px;height:42px;margin-bottom:4px">${chartHtml}</div>`
      + `<div style="font-size:10.5px;color:rgba(255,255,255,.5);margin-bottom:18px;letter-spacing:.02em">${weekHint}</div>`
      // Newly unlocked
      + (newlyHtml
          ? `<div style="margin-bottom:6px;font:600 10px/1 'Cinzel',serif;letter-spacing:.22em;text-transform:uppercase;color:#f4d49a">✦ New Honours</div>`
            + `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:18px">${newlyHtml}</div>`
          : "")
      // Leaderboard
      + `<details style="margin-bottom:10px"><summary style="cursor:pointer;font:600 10px/1 'Cinzel',serif;letter-spacing:.22em;text-transform:uppercase;color:rgba(212,173,106,.72);padding:6px 0;list-style:none;outline:none">▸ Skalds' Roll · top ${board.length}</summary>`
      + `<div style="margin-top:8px">${rows || '<div style="opacity:.6;font-size:12px">No runs yet</div>'}</div>`
      + `</details>`
      // All badges collapsed
      + `<details style="margin-bottom:6px"><summary style="cursor:pointer;font:600 10px/1 'Cinzel',serif;letter-spacing:.22em;text-transform:uppercase;color:rgba(212,173,106,.72);padding:6px 0;list-style:none;outline:none">▸ Honours · ${earned.size} / ${all.length} unlocked</summary>`
      + `<div style="margin-top:10px">${groupHtml}</div>`
      + `</details>`;
    // Update the "before-run" badge snapshot for the NEXT _gameOver call.
    this._badgeIdsBeforeRun = Array.from(earned);
  }

  _flash() {
    this.hud.flash.classList.add("on");
    setTimeout(() => this.hud.flash.classList.remove("on"), 320);
  }

  _begin() {
    $("startOverlay").classList.add("hide");
    $("overOverlay").classList.remove("show");
    // CINEMATIC INTRO. Start the run in pure-black, then fade in over
    // 1.4s as the body.playing class is added. .cinematic-intro on
    // body keeps the .introfade overlay opaque; .playing then removes
    // it via CSS transition. Same trick every Vikings episode opens.
    document.body.classList.add("cinematic-intro");
    requestAnimationFrame(() => {
      document.body.classList.add("playing");
      setTimeout(() => document.body.classList.remove("cinematic-intro"), 1500);
    });
    this.lane = 1; this.targetLaneX = LANES[1];
    this.playerY = 0; this.playerVy = 0;
    this.sliding = false; this.slideTimer = 0;
    this.distance = 0; this.score = 0; this.mead = 0;
    this.lives = 3; this.combo = 0; this.invuln = 0;
    // Per-run counters for lifetime/daily aggregation in _saveStats.
    this.runRunes = 0; this.runBossKills = 0;
    // Snapshot the badge set at run-start so the game-over screen can
    // highlight only the badges UNLOCKED THIS RUN as "New Honours".
    this._badgeIdsBeforeRun = (Store.load().badges || []).slice();
    this.speed = BASE_SPEED;
    this._shakeAmp = 0; this._shakeT = 0;
    this._timeScale = 1; this._timeScaleTarget = 1;
    // Clear powerups + tear down any visual auras still attached to the
    // player from the previous run (Aegis glow, longship, Mjölnir aura,
    // Odin's ravens).
    for (const k of Object.keys(this.power)) this.power[k] = 0;
    this._removeShieldGlow();
    this._dismountLongship();
    this._removeThorAura();
    this._removeOdinRavens();
    this._renderPowerHudOnce();
    this._showCombo();
    this._updateHUD();
    for (const o of this.obstacles) {
      this.scene.remove(o.mesh);
      if (o.decal) {
        if (Array.isArray(o.decal)) for (const d of o.decal) this.scene.remove(d);
        else this.scene.remove(o.decal);
      }
    }
    for (const c of this.collectibles) {
      this.scene.remove(c.mesh);
      if (c.decal) this.scene.remove(c.decal);
    }
    this.obstacles = []; this.collectibles = [];
    // First obstacle wave is ~55m ahead so the opening reads as world, not gauntlet.
    this._spawnZ = 55;
    // Reset hostile-spawn cooldown so the very first wave isn't gated.
    this._lastHardZ = -999;
    // Reset bio session counters so the end-of-run report reflects
    // this run only.
    this.bioSession = {
      flowSec: 0, focusedSec: 0, calmSec: 0, berserkerSec: 0, meditationSec: 0,
      sumHR: 0, hrSamples: 0, peakHR: 0,
      giftAccumSec: 0, giftsEarned: 0, durationBonusApplied: 0,
    };
    // Refresh bio aura with the current state so it shows on this run too
    // (cognitive state survives game-over, only the visible aura clears).
    this._updateMultiplier(this.cognitiveState);
    this._markNudgeSeen();
    // Reset biome back to Midgard. Snap fog/sky to Midgard colours so the
    // first biome transition is dramatic from a clean slate.
    this.biomeIdx = 0;
    this.biomeCycle = 0;
    this.biomeName = BIOMES[0].name;
    this._biomeFogTarget.setHex(BIOMES[0].fog);
    this._biomeSkyTargets = BIOMES[0].sky.map(c => new THREE.Color(c));
    if (this.scene.fog) {
      this.scene.fog.color.setHex(BIOMES[0].fog);
      this.scene.background.setHex(BIOMES[0].fog);
    }
    if (this.audio && typeof this.audio.setBiomePitch === "function") {
      this.audio.setBiomePitch(0);
    }
    // Tear down any boss actor left over from the previous run.
    if (this._bossActor) {
      this.scene.remove(this._bossActor.mesh);
      this._bossActor = null;
    }
    this.running = true; this.over = false; this.paused = false;
    // Open the run with the MIDGARD banner so the player sees the realm
    // system exists even before the first transition fires. Order matters:
    // set `running = true` BEFORE _updateBiomeChip so the chip's opacity
    // resolves to 1.
    this._showBiomeBanner(BIOMES[0].name);
    this._updateBiomeChip();
    // Cinematic HUD: fade out the controls hint after 6s and the
    // legend after 20s of fresh play. Both reappear via TAB.
    const hint = document.querySelector(".hint");
    const legend = document.getElementById("legend");
    if (hint)   { hint.classList.remove("faded");   clearTimeout(this._hintFadeT);   this._hintFadeT   = setTimeout(() => hint.classList.add("faded"), 6000); }
    if (legend) { legend.classList.remove("faded"); clearTimeout(this._legendFadeT); this._legendFadeT = setTimeout(() => legend.classList.add("faded"), 20000); }
    this.audio.ensure();
    this.audio.startWind();
    this.audio.startMusic();
    this.audio.startFireAmbience();
  }

  _gameOver() {
    if (this.over) return;
    this.over = true; this.running = false;
    this.audio.stopMusic();
    this.audio.death();
    if (this._biomeChipEl) this._biomeChipEl.style.opacity = "0";
    // Stop the heartbeat pulse so it doesn't keep dimming the menu.
    if (this._hbTimer) { clearTimeout(this._hbTimer); this._hbTimer = null; }
    if (this._heartbeatEl) this._heartbeatEl.style.opacity = "0";
    // CRITICAL: hide every in-world floating overlay so the run-over
    // card isn't drowned in boss tutorial popups, Skald narration,
    // biome banners, boss banners that were mid-fade when death hit.
    // Without this, the run-over screen reads as a stack of garbage.
    const hideIds = ["bossTutorial", "bossBanner", "skaldEl"];
    for (const id of hideIds) {
      const el = document.getElementById(id);
      if (el) { el.style.display = "none"; el.style.opacity = "0"; }
    }
    // The biome banner + Skald narration are class-instance refs not IDs.
    if (this._biomeBannerEl) { this._biomeBannerEl.style.opacity = "0"; this._biomeBannerEl.style.display = "none"; }
    if (this._skaldEl)       { this._skaldEl.style.opacity = "0";       this._skaldEl.style.display = "none"; }
    // Bio status pill should fade not vanish (it's still factual).
    if (this._bioPillEl) this._bioPillEl.style.opacity = "0";
    // Clear any in-flight tutorial / narration timers so they don't
    // re-show the popups after we hid them.
    if (this._bossTutorialTimer) { clearTimeout(this._bossTutorialTimer); this._bossTutorialTimer = null; }
    if (this._biomeBannerT)      { clearTimeout(this._biomeBannerT);      this._biomeBannerT = null; }
    if (this._skaldT)            { clearTimeout(this._skaldT);            this._skaldT = null; }
    const prev = Store.load();
    const prevBestScore = prev.bestScore || 0;
    const prevBestDist = prev.bestDist || 0;
    this._saveStats();
    const finalScore = Math.floor(this.score);
    const finalDist = Math.round(this.distance);
    $("oScore").textContent = finalScore.toLocaleString();
    $("oDist").textContent = `${finalDist}m`;
    $("oMead").textContent = this.mead;
    const bb = $("bestBeat");
    if (finalScore > prevBestScore && prevBestScore > 0) {
      bb.textContent = `New best  +${(finalScore - prevBestScore).toLocaleString()}`;
      bb.classList.remove("none");
    } else if (finalDist > prevBestDist && prevBestDist > 0) {
      bb.textContent = `Furthest run  +${finalDist - prevBestDist}m`;
      bb.classList.remove("none");
    } else if (prevBestScore > 0) {
      bb.textContent = `${(prevBestScore - finalScore).toLocaleString()} to your best`;
      bb.classList.remove("none");
    } else {
      bb.classList.add("none");
    }
    // END-OF-RUN BIO REPORT. the receipt that justifies the SDK.
    // Inject a "Body" section into the run-over card with this run's
    // physiological summary. Only shows if a sensor was active at any
    // point (hrSamples > 0 OR any positive state accumulated).
    this._injectBioReport();
    this._injectScoreboard();
    $("overOverlay").classList.add("show");
    this._loadStats();
  }

  // Build / refresh the bio report on the game-over screen. Pure DOM
  // injection. finds the .over .card and appends/updates a section.
  _injectBioReport() {
    const card = document.querySelector("#overOverlay .card");
    if (!card) return;
    let host = card.querySelector("#bioReport");
    const s = this.bioSession || {};
    const hadBio = (s.hrSamples > 0)
                || (s.flowSec + s.focusedSec + s.calmSec) > 0.5;
    if (!hadBio) {
      if (host) host.style.display = "none";
      return;
    }
    if (!host) {
      host = document.createElement("div");
      host.id = "bioReport";
      host.style.cssText =
        "margin:18px 0 4px;padding:18px 0 0;"
        + "border-top:1px solid rgba(212,173,106,.18);text-align:left;";
      host.innerHTML =
        '<div style="font:600 11px/1 \'Cinzel\',serif;letter-spacing:.22em;text-transform:uppercase;color:rgba(212,173,106,.62);margin-bottom:14px">What You Earned</div>'
        + '<div id="bioReportRows"></div>';
      const actions = card.querySelector(".actions");
      card.insertBefore(host, actions || null);
    }
    const rows = host.querySelector("#bioReportRows");
    const fmtSec = (sec) => sec >= 60 ? (sec/60).toFixed(1) + " min" : sec.toFixed(0) + " s";
    const avgHR = s.hrSamples > 0 ? Math.round(s.sumHR / s.hrSamples) : null;
    const items = [];
    if (s.flowSec > 0.5)      items.push(["Time in Flow",       fmtSec(s.flowSec),       "#7ad9ff"]);
    if (s.focusedSec > 0.5)   items.push(["Time Focused",       fmtSec(s.focusedSec),    "#a3b8ff"]);
    if (s.calmSec > 0.5)      items.push(["Time Calm",          fmtSec(s.calmSec),       "#80d0e0"]);
    if (avgHR)                items.push(["Avg Heart Rate",      avgHR + " bpm",          "#ff8a7a"]);
    if (s.peakHR)             items.push(["Peak Heart Rate",     s.peakHR + " bpm",       "#ff5e4a"]);
    if (s.giftsEarned)        items.push(["Gifts From Body",     s.giftsEarned + "×",     "#d4ad6a"]);
    if (s.durationBonusApplied) items.push(["Gifts Extended",   s.durationBonusApplied + "×", "#d4ad6a"]);
    rows.innerHTML = items.map(([k, v, c]) =>
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin:6px 0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">'
      + '<span style="font-size:11.5px;color:rgba(232,219,196,.55);text-transform:uppercase;letter-spacing:.10em">' + k + '</span>'
      + '<span style="font:700 16px/1 \'Cinzel\',serif;color:' + c + ';font-variant-numeric:tabular-nums">' + v + '</span>'
      + '</div>'
    ).join("");
    host.style.display = "block";
  }

  // ---------- Spawning ----------
  _spawnAhead(dt) {
    if (!this.running) return;
    // Wave interval scales with distance for a smoother ramp:
    //   0 – 150m  : 22 – 32m (gentle intro, learn the controls)
    //   150 – 400m: 18 – 26m (busier)
    //   400m+     : 14 – 22m (full pressure)
    // The Round 3 hard-hazard cooldown still gates unavoidable patterns,
    // but this puts overall density on a real ramp instead of dropping
    // a new player straight into the deep end.
    while (this._spawnZ < this.distance + VIEW_DEPTH * 0.7) {
      this._spawnWave(this._spawnZ);
      const d = this.distance;
      let minGap, jitter;
      if (d < 150)      { minGap = 22; jitter = 10; }
      else if (d < 400) { minGap = 18; jitter = 8;  }
      else              { minGap = 14; jitter = 8;  }
      this._spawnZ += minGap + Math.random() * jitter;
    }
  }

  _spawnWave(zWorld) {
    // First 100m of a fresh run is a grace zone: collectibles only, no
    // hazards at all. The player gets to land in the world, see the HUD,
    // grab some mead, and watch the first realm transition fire at 250m
    // before anything tries to kill them. This is what "addictive" needs
    //. the first 5 seconds have to feel like discovery, not punishment.
    const inGrace = this.distance < 100;

    // Pattern-safety rules. Some hazards are unavoidable if you can't
    // react in time to the previous one:
    //   - beam / ravens need a slide
    //   - fire pit needs a jump
    //   - 2-lane block needs a lane change
    // Track the z of the last "must-act" hazard and refuse to spawn another
    // within 14m so the player always has time to reset their stance.
    this._lastHardZ = this._lastHardZ || -999;
    const tooCloseToHard = (zWorld - this._lastHardZ) < 14 || inGrace;

    const r = Math.random();
    if (r < 0.20 && !inGrace) {
      // Single-lane obstacle. easy to dodge, no cooldown needed.
      const lane = (Math.random() * 3) | 0;
      this._spawnObstacle(lane, zWorld);
    } else if (r < 0.34 && !tooCloseToHard) {
      // Two-lane block (one safe lane). Hard. gate by cooldown.
      const safe = (Math.random() * 3) | 0;
      for (let i = 0; i < 3; i++) if (i !== safe) this._spawnObstacle(i, zWorld);
      this._lastHardZ = zWorld;
    } else if (r < 0.45 && !tooCloseToHard) {
      // Slide-under beam. gate by cooldown.
      this._spawnBeam(zWorld);
      this._lastHardZ = zWorld;
    } else if (r < 0.55 && !tooCloseToHard) {
      // Jump-over fire pit. gate by cooldown.
      this._spawnFirePit((Math.random() * 3) | 0, zWorld);
      this._lastHardZ = zWorld;
    } else if (r < 0.65 && !tooCloseToHard) {
      // Slide-under ravens. gate by cooldown.
      this._spawnRavens(zWorld);
      this._lastHardZ = zWorld;
    } else {
      // Empty wave or cooldown. collectibles only.
    }

    // Mead cluster in a single lane (arc or line). First horn in the
    // cluster gets a soft gold ground decal so the player can spot the
    // loot lane from far off.
    const coinLane = (Math.random() * 3) | 0;
    const coinCount = 3 + ((Math.random() * 4) | 0);
    const arc = Math.random() < 0.3;
    for (let i = 0; i < coinCount; i++) {
      const z = zWorld + i * 1.6;
      const y = arc ? 1.2 + Math.sin(i / coinCount * Math.PI) * 1.8 : 1.2;
      this._spawnMead(coinLane, z, y, i === 0);
    }

    // Rare rune
    if (Math.random() < 0.16) {
      this._spawnRune((Math.random() * 3) | 0, zWorld + 4);
    }

    // God-blessing orbs. Triples the previous spawn rate (8% → 24%)
    // and unlocks the great relics much earlier. the user-reported
    // "no powerups" issue was just rarity. Now you see one every
    // ~3-4 waves which is ~60-80m apart.
    if (Math.random() < 0.24) {
      let pool;
      if (this.distance < 60) pool = ["speed", "mult", "magnet"];
      else if (this.distance < 150) pool = ["shield", "speed", "mult", "magnet", "ship", "thor"];
      else pool = ["shield", "speed", "mult", "magnet", "ship", "thor", "odin"];
      const t = pool[(Math.random() * pool.length) | 0];
      this._spawnPowerup(t, (Math.random() * 3) | 0, zWorld + 6);
    }
  }

  // Ground markers tell the player at-a-glance what a lane is about to do:
  //   red ring  = DANGER (obstacle, beam, fire, ravens)
  //   gold ring = REWARD (mead cluster, rune)
  //   gods-coloured ring = god blessing (powerup)
  // All decals pulse so peripheral vision picks them up even at speed.
  _makeGroundDecal(color = 0xff3030, radius = 1.0, danger = true) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.55, radius * 1.05, 28),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: danger ? 0.85 : 0.65, depthWrite: false,
        side: THREE.DoubleSide, fog: false,
      })
    );
    m.rotation.x = -Math.PI / 2;
    // Tag so the per-frame decal pulser knows how aggressively to throb.
    m.userData.danger = danger;
    m.userData.phase = Math.random() * Math.PI * 2;
    if (!this._allDecals) this._allDecals = [];
    this._allDecals.push(m);
    return m;
  }

  _spawnObstacle(lane, zWorld) {
    const r = Math.random();
    let mesh, w, h, type;
    if (r < 0.34) {
      // Boulder: ancient runestone. A weather-worn slab with carved norse
      // runes glowing dim red. Reads as a single chunky silhouette.
      mesh = new THREE.Group();
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 2.2, 0.55),
        new THREE.MeshStandardMaterial({
          color: 0x44484f, roughness: 1.0, flatShading: true,
        })
      );
      slab.position.y = 1.1;
      slab.castShadow = true;
      mesh.add(slab);
      // Chipped top (smaller box rotated)
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 0.3, 0.6),
        new THREE.MeshStandardMaterial({
          color: 0x52565d, roughness: 1.0, flatShading: true,
        })
      );
      cap.position.y = 2.3;
      cap.rotation.z = (Math.random() - 0.5) * 0.15;
      mesh.add(cap);
      // Carved runes - thin glowing red bars in a column on the front face
      for (let i = 0; i < 4; i++) {
        const rune = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.08, 0.02),
          new THREE.MeshBasicMaterial({ color: 0xff3010 })
        );
        rune.position.set(0, 0.45 + i * 0.4, 0.29);
        rune.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.18;
        mesh.add(rune);
      }
      // Moss patches (small green box at base)
      const moss = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 0.15, 0.6),
        new THREE.MeshStandardMaterial({ color: 0x2c4a25, roughness: 0.95, flatShading: true })
      );
      moss.position.y = 0.08;
      mesh.add(moss);
      w = 1.8; h = 2.5; type = "boulder";
    } else if (r < 0.67) {
      // Troll: hunched humanoid carrying a club. Dark green-grey skin with
      // glowing red eyes. Reads as a real creature not a cube.
      mesh = new THREE.Group();
      // Body - tapered torso (cone-ish via cylinder with different radii)
      const torso = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.7, 1.4, 8),
        new THREE.MeshStandardMaterial({
          color: 0x2a3a2a, roughness: 0.9, flatShading: true,
        })
      );
      torso.position.y = 0.95;
      torso.castShadow = true;
      mesh.add(torso);
      // Head
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.45, 8, 6),
        new THREE.MeshStandardMaterial({
          color: 0x35452f, roughness: 0.92, flatShading: true,
        })
      );
      head.position.y = 1.95;
      head.scale.set(1, 0.85, 1.1);
      head.castShadow = true;
      mesh.add(head);
      // Jaw / mouth box poking forward
      const jaw = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.25, 0.35),
        new THREE.MeshStandardMaterial({ color: 0x202c1c, flatShading: true })
      );
      jaw.position.set(0, 1.78, 0.25);
      mesh.add(jaw);
      // Tusks
      for (const dx of [-0.12, 0.12]) {
        const tusk = new THREE.Mesh(
          new THREE.ConeGeometry(0.05, 0.22, 4),
          new THREE.MeshStandardMaterial({ color: 0xeae0c4, flatShading: true })
        );
        tusk.position.set(dx, 1.7, 0.42);
        tusk.rotation.x = Math.PI;
        mesh.add(tusk);
      }
      // Eyes
      for (const dx of [-0.16, 0.16]) {
        const eye = new THREE.Mesh(
          new THREE.SphereGeometry(0.08, 6, 6),
          new THREE.MeshBasicMaterial({ color: 0xff4020 })
        );
        eye.position.set(dx, 2.0, 0.36);
        mesh.add(eye);
      }
      // Arms hanging down with a club
      const armL = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.9, 0.22),
        new THREE.MeshStandardMaterial({ color: 0x2a3a2a, flatShading: true })
      );
      armL.position.set(-0.6, 1.0, 0.05);
      mesh.add(armL);
      const armR = armL.clone();
      armR.position.x = 0.6;
      mesh.add(armR);
      // Club - vertical knobby cylinder in right hand
      const club = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.22, 1.2, 7),
        new THREE.MeshStandardMaterial({
          color: 0x3a2614, roughness: 0.95, flatShading: true,
          emissive: 0x2c1404, emissiveIntensity: 0.25,
        })
      );
      club.position.set(0.62, 0.55, 0.2);
      mesh.add(club);
      // Knobs on the club
      for (let i = 0; i < 4; i++) {
        const knob = new THREE.Mesh(
          new THREE.SphereGeometry(0.08, 6, 4),
          new THREE.MeshStandardMaterial({ color: 0x4a3018, flatShading: true })
        );
        knob.position.set(0.62 + (Math.random() - 0.5) * 0.1, 0.2 + i * 0.25, 0.2 + (Math.random() - 0.5) * 0.1);
        mesh.add(knob);
      }
      w = 1.7; h = 2.4; type = "troll";
    } else {
      // Ice spikes: cluster of jagged crystals, no flat slab. Each spike
      // glows blue from within, reads as growing out of the ground.
      mesh = new THREE.Group();
      // Cluster of 5 ice cones in a triangle pattern
      const spikes = [
        { x: -0.5, h: 1.6, r: 0.32 },
        { x: 0.5, h: 1.8, r: 0.34 },
        { x: 0, h: 2.4, r: 0.42 },
        { x: -0.25, h: 1.2, r: 0.26 },
        { x: 0.3, h: 1.0, r: 0.24 },
      ];
      for (const s of spikes) {
        const spike = new THREE.Mesh(
          new THREE.ConeGeometry(s.r, s.h, 5),
          new THREE.MeshStandardMaterial({
            color: 0xb0e0ee, roughness: 0.18, metalness: 0.3,
            emissive: 0x4080a8, emissiveIntensity: 0.55,
            flatShading: true,
          })
        );
        spike.position.set(s.x, s.h / 2, (Math.random() - 0.5) * 0.4);
        spike.rotation.z = (Math.random() - 0.5) * 0.3;
        spike.castShadow = true;
        mesh.add(spike);
      }
      // Inner glow sphere for ambient light
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.4, 8, 6),
        new THREE.MeshBasicMaterial({
          color: 0xb0e0ee, transparent: true, opacity: 0.35, depthWrite: false,
        })
      );
      core.position.y = 0.5;
      mesh.add(core);
      w = 1.7; h = 2.5; type = "ice";
    }
    // Big red danger ring on the ground so the threatened lane is impossible
    // to miss even in peripheral vision. Pulses every frame (see _update).
    const decal = this._makeGroundDecal(0xff2818, 1.5, true);
    decal.position.set(LANES[lane], 0.06, zWorld);
    this.scene.add(decal);

    mesh.position.x = LANES[lane];
    mesh.position.z = zWorld;
    this.scene.add(mesh);
    // Action label floating above so the player knows what to do.
    // Single-lane obstacles are dodge-by-lane-change (yellow). The jump
    // mechanic exists if they're brave but DODGE is the canonical play.
    this._addActionLabel(mesh, "DODGE", h + 1.0, 0xffd040);
    this.obstacles.push({ mesh, lane, spawnAt: zWorld, type, w, h, slidable: false, action: "dodge", decal });
  }

  // Action labels (JUMP/SLIDE/DODGE) were tutorial scaffolding that
  // broke immersion. The player learns the verbs in 2-3 tries and after
  // that the floating words are just noise. Disabled. keep the
  // function as a no-op so existing call sites still work but emit
  // nothing. The colour-coded ground rings + obstacle silhouettes
  // already telegraph the action clearly enough.
  _addActionLabel(parent, text, yOffset = 2.5, accent = 0xff8040) {
    return null;
  }

  _spawnBeam(zWorld) {
    // Hazard bar across all lanes at chest height. Must slide under.
    // Bright red-orange with yellow hazard stripes + glowing bottom edge.
    const grp = new THREE.Group();
    const span = 11;
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(span, 0.55, 0.55),
      new THREE.MeshStandardMaterial({
        color: 0xd83020, roughness: 0.6, flatShading: true,
        emissive: 0x701010, emissiveIntensity: 0.65,
      })
    );
    beam.position.y = 1.75;
    beam.castShadow = true;
    grp.add(beam);
    for (let i = -3; i <= 3; i++) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.4, 0.57),
        new THREE.MeshBasicMaterial({ color: 0xffd020 })
      );
      stripe.position.set(i * 1.5, 1.75, 0);
      stripe.rotation.z = 0.35;
      grp.add(stripe);
    }
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(span + 0.4, 0.16),
      new THREE.MeshBasicMaterial({
        color: 0xff5030, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false, fog: false,
      })
    );
    glow.position.set(0, 1.45, 0);
    grp.add(glow);
    grp.position.z = zWorld;
    this.scene.add(grp);

    // Three lane decals to telegraph the bar is across the whole row
    const decals = [];
    for (let li = 0; li < 3; li++) {
      const d = this._makeGroundDecal(0xff4020, 0.95);
      d.position.set(LANES[li], 0.06, zWorld);
      this.scene.add(d);
      decals.push(d);
    }
    // SLIDE label floating above the centre of the beam. Red accent so
    // it visually matches the bar's "danger" colour.
    this._addActionLabel(grp, "SLIDE", 3.0, 0xff3030);
    this.obstacles.push({
      mesh: grp, lane: -1, spawnAt: zWorld, type: "beam",
      w: 999, h: 0.55, slidable: true, yMin: 1.6, action: "slide", decal: decals,
    });
  }

  _spawnMead(lane, zWorld, baseY = 1.2, leadDecal = false) {
    const grp = new THREE.Group();
    // Drinking horn. bone/ivory tone, NO emissive (a horn doesn't glow).
    // Slight metallic on the iron rim only.
    const horn = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.8, 10),
      new THREE.MeshStandardMaterial({ color: 0xe2cda3, roughness: 0.65, flatShading: true })
    );
    horn.rotation.z = Math.PI;
    grp.add(horn);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.04, 6, 16),
      new THREE.MeshStandardMaterial({ color: 0x3a2d1c, metalness: 0.7, roughness: 0.55 })
    );
    rim.position.y = 0.4;
    grp.add(rim);
    grp.position.set(LANES[lane], baseY, zWorld);
    this.scene.add(grp);
    // Only the first mead in a cluster gets a decal. otherwise we'd
    // litter the path. The cluster is one "loot lane" event.
    let decal = null;
    if (leadDecal) {
      decal = this._makeGroundDecal(0xffc060, 0.8, false);
      decal.position.set(LANES[lane], 0.06, zWorld);
      this.scene.add(decal);
    }
    this.collectibles.push({ mesh: grp, lane, spawnAt: zWorld, type: "mead", ang: 0, value: 25, baseY, decal });
  }

  _spawnRune(lane, zWorld) {
    // Carved standing runestone. weathered grey granite slab with three
    // faintly-glowing etched runes. Far more "ancient Norse holy site"
    // than the previous cartoon cyan crystal that just floated in midair.
    const grp = new THREE.Group();
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 1.6, 0.22),
      new THREE.MeshStandardMaterial({
        color: 0x6e7480, roughness: 1.0, flatShading: true,
      })
    );
    slab.position.y = 0.8;
    slab.castShadow = true;
    grp.add(slab);
    // Slight chipped cap, rotated to look weather-worn.
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.14, 0.26),
      new THREE.MeshStandardMaterial({ color: 0x7a8088, roughness: 1.0, flatShading: true })
    );
    cap.position.y = 1.65;
    cap.rotation.z = 0.07;
    grp.add(cap);
    // Three runic etchings stacked on the front face. MeshStandard with
    // a strong emissiveIntensity so the bloom pass picks them up as
    // real magical light spilling off the stone.
    for (let i = 0; i < 3; i++) {
      const rune = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.05, 0.03),
        new THREE.MeshStandardMaterial({
          color: 0x9adfff, emissive: 0x60c0ff, emissiveIntensity: 2.4,
          roughness: 0.4, metalness: 0.1,
        })
      );
      rune.position.set(0, 0.55 + i * 0.32, 0.12);
      rune.rotation.z = (i % 2 === 0 ? 0.18 : -0.18);
      grp.add(rune);
    }
    // Mossy base ring so the stone doesn't read as floating.
    const moss = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.08, 0.32),
      new THREE.MeshStandardMaterial({ color: 0x2a3a22, roughness: 1.0, flatShading: true })
    );
    moss.position.y = 0.04;
    grp.add(moss);
    grp.position.set(LANES[lane], 0, zWorld);
    this.scene.add(grp);
    // Cyan reward ring so runestones are obviously not-a-threat from afar.
    const decal = this._makeGroundDecal(0x60d0ff, 1.0, false);
    decal.position.set(LANES[lane], 0.06, zWorld);
    this.scene.add(decal);
    this.collectibles.push({ mesh: grp, lane, spawnAt: zWorld, type: "rune", ang: 0, value: 100, baseY: 0, decal });
  }

  // Powerup orbs. Each is a colored glowing sphere with a halo + small icon
  // shape inside, hovering above the path. Picking one up activates the
  // corresponding buff for 5-8 seconds.
  _spawnPowerup(type, lane, zWorld) {
    // Each god/relic gets a distinct orb colour, icon, and shouted name.
    // `label` is the literal text rendered on the floating banner above
    // the orb so the player knows exactly what they're about to pick up.
    const PUSPECS = {
      shield:  { color: 0xc8a040, halo: 0xffe098, value: 6.0, sym: "shield", label: "TYR'S AEGIS" },
      speed:   { color: 0xc8d8e8, halo: 0xf0f6ff, value: 5.0, sym: "hoof",   label: "SLEIPNIR" },
      mult:    { color: 0xffd066, halo: 0xfff2c8, value: 8.0, sym: "rune",   label: "BRAGI'S SAGA" },
      magnet:  { color: 0xff6090, halo: 0xffc0d0, value: 6.0, sym: "tear",   label: "FREJA'S TEARS" },
      ship:    { color: 0xc04020, halo: 0xff8050, value: 6.0, sym: "ship",   label: "SKÍÐBLAÐNIR" },
      thor:    { color: 0x9ec0ff, halo: 0xe0e8ff, value: 4.5, sym: "hammer", label: "MJÖLNIR" },
      odin:    { color: 0x6878a8, halo: 0xa8b0d0, value: 6.0, sym: "ravens", label: "HUGINN & MUNINN" },
    };
    const spec = PUSPECS[type];
    const grp = new THREE.Group();
    // Core orb. gift of the gods. Strong emissive so the bloom pass
    // turns it into a real lantern of divine light, not a flat sphere.
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 18, 14),
      new THREE.MeshStandardMaterial({
        color: spec.color, roughness: 0.18, metalness: 0.7,
        emissive: spec.color, emissiveIntensity: 2.6,
      })
    );
    grp.add(core);
    // Halo. larger and slightly more opaque.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 14, 10),
      new THREE.MeshBasicMaterial({ color: spec.halo, transparent: true, opacity: 0.32, depthWrite: false })
    );
    grp.add(halo);
    // Powerup name banners removed. they made the world feel like a
    // tutorial. The orb's distinct halo colour + icon silhouette is
    // enough to identify the relic. The pickup announcement (big
    // floating text on activate) is when the player learns the name.
    // Icon symbol inside the orb. small white silhouette that reads at
    // distance even when the player is sprinting. One shape per god/relic.
    const W = new THREE.MeshBasicMaterial({ color: 0xffffff });
    let icon;
    if (spec.sym === "shield") {                      // Tyr. round shield with boss
      icon = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.05, 16), W);
      disc.rotation.x = Math.PI / 2;
      icon.add(disc);
      const boss = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), W);
      boss.position.z = 0.05;
      icon.add(boss);
    } else if (spec.sym === "hoof") {                 // Sleipnir. galloping hoofprint (kite)
      icon = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.32, 4), W);
      icon.rotation.x = Math.PI / 2;
    } else if (spec.sym === "rune") {                 // Bragi. rune-stone (vertical bar with cross)
      icon = new THREE.Group();
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.38, 0.06), W);
      icon.add(bar);
      const cross = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.06), W);
      icon.add(cross);
    } else if (spec.sym === "tear") {                 // Freja. tear-drop
      icon = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.32, 12), W);
    } else if (spec.sym === "ship") {                 // Skíðblaðnir. longship silhouette
      icon = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, 0.14), W);
    } else if (spec.sym === "hammer") {               // Mjölnir. boxy hammer head + short handle
      icon = new THREE.Group();
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.20, 0.18), W);
      head.position.y = 0.07;
      icon.add(head);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.28, 0.06), W);
      handle.position.y = -0.13;
      icon.add(handle);
    } else if (spec.sym === "ravens") {               // Odin. two stacked diamond birds
      icon = new THREE.Group();
      for (let i = 0; i < 2; i++) {
        const b = new THREE.Mesh(new THREE.OctahedronGeometry(0.10, 0), W);
        b.position.set(i === 0 ? -0.10 : 0.10, i === 0 ? 0.08 : -0.06, 0);
        icon.add(b);
      }
    } else {                                          // default fallback. diamond
      icon = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 0), W);
    }
    icon.position.z = 0.05;
    grp.add(icon);

    // BEACON. vertical pillar of light shooting up from the orb so
    // the player spots it from far away even through heavy fog. This
    // is THE fix for "I can't see what's a powerup". the pillar is
    // 18m tall, additive-blended, fog-aware so it fades naturally
    // with distance. God's halo colour at top.
    const beaconGeo = new THREE.CylinderGeometry(0.22, 0.22, 18, 8, 1, true);
    beaconGeo.translate(0, 9, 0);
    const beaconMat = new THREE.MeshBasicMaterial({
      color: spec.halo, transparent: true, opacity: 0.55,
      depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, fog: true,
    });
    const beacon = new THREE.Mesh(beaconGeo, beaconMat);
    grp.add(beacon);

    grp.position.set(LANES[lane], 1.6, zWorld);
    this.scene.add(grp);
    // Reward decal. the god's halo colour on the ground, so the player can
    // distinguish at a glance from the red danger rings.
    const rewardDecal = this._makeGroundDecal(spec.halo, 1.3, false);
    rewardDecal.position.set(LANES[lane], 0.06, zWorld);
    this.scene.add(rewardDecal);
    this.collectibles.push({ mesh: grp, lane, spawnAt: zWorld, type: "powerup",
      pwType: type, value: spec.value, ang: 0, baseY: 1.6, decal: rewardDecal });
  }

  // Canvas-rendered text sprite. Three.js has no native text. we draw the
  // label to a 2D canvas, wrap it in a CanvasTexture, then put it on a
  // Sprite that always faces the camera. Used for floating powerup names.
  _makeTextSprite(text, accent = 0xffffff) {
    const cv = document.createElement("canvas");
    cv.width = 512; cv.height = 128;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    // Pill background for legibility against snow/sky.
    ctx.fillStyle = "rgba(10, 13, 18, 0.78)";
    const r = 28;
    ctx.beginPath();
    ctx.moveTo(r, 18);
    ctx.lineTo(cv.width - r, 18);
    ctx.quadraticCurveTo(cv.width - 4, 18, cv.width - 4, 18 + r);
    ctx.lineTo(cv.width - 4, cv.height - 18 - r);
    ctx.quadraticCurveTo(cv.width - 4, cv.height - 18, cv.width - r, cv.height - 18);
    ctx.lineTo(r, cv.height - 18);
    ctx.quadraticCurveTo(4, cv.height - 18, 4, cv.height - 18 - r);
    ctx.lineTo(4, 18 + r);
    ctx.quadraticCurveTo(4, 18, r, 18);
    ctx.closePath();
    ctx.fill();
    // Accent rim in the god's halo colour.
    const cssColor = "#" + ("000000" + accent.toString(16)).slice(-6);
    ctx.strokeStyle = cssColor;
    ctx.lineWidth = 3;
    ctx.stroke();
    // Label.
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 44px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cv.width / 2, cv.height / 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    return new THREE.Sprite(mat);
  }

  // Fire pit: a low burning hazard occupying one lane. Must JUMP over it.
  _spawnFirePit(lane, zWorld) {
    const grp = new THREE.Group();
    // Charred base
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 1.05, 0.2, 12),
      new THREE.MeshStandardMaterial({ color: 0x16100c, roughness: 1.0, flatShading: true })
    );
    base.position.y = 0.1;
    grp.add(base);
    // Logs
    for (let i = 0; i < 3; i++) {
      const log = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.1, 1.0, 6),
        new THREE.MeshStandardMaterial({ color: 0x2a1808, roughness: 0.9, flatShading: true,
          emissive: 0xff4020, emissiveIntensity: 0.4 })
      );
      log.rotation.z = Math.PI / 2;
      log.rotation.y = i * Math.PI / 3;
      log.position.y = 0.25;
      grp.add(log);
    }
    // Flames. stacked tetrahedra. Material is BasicMaterial in HDR
    // colour space (values > 1) so the bloom pass picks them up as
    // real fire light spilling everywhere around the pit, not flat
    // triangle decals. Each tier uses progressively brighter values.
    const flames = new THREE.Group();
    const FLAME_HDR = [
      new THREE.Color(2.4, 0.6, 0.15),  // deepest red-orange
      new THREE.Color(3.0, 1.0, 0.25),
      new THREE.Color(3.4, 1.8, 0.55),  // amber peak
      new THREE.Color(3.0, 2.4, 1.0),
      new THREE.Color(2.6, 2.4, 1.4),   // yellow-white tip
    ];
    for (let i = 0; i < 5; i++) {
      const h = 0.7 + i * 0.18;
      const r = 0.5 - i * 0.08;
      const flame = new THREE.Mesh(
        new THREE.TetrahedronGeometry(r, 0),
        new THREE.MeshBasicMaterial({
          color: FLAME_HDR[i], transparent: true, opacity: 0.9, fog: true,
        })
      );
      flame.position.y = h;
      flame.userData.basePhase = Math.random() * Math.PI * 2;
      flames.add(flame);
    }
    grp.add(flames);
    grp.userData.flames = flames;
    // No PointLight. multiple fire obstacles on screen + 4 scenery
    // pits would burst WebGL's dynamic-light budget. Emissive flame
    // materials read as fire on their own.
    grp.position.set(LANES[lane], 0, zWorld);
    this.scene.add(grp);

    const decal = this._makeGroundDecal(0xff4020, 1.3);
    decal.position.set(LANES[lane], 0.06, zWorld);
    this.scene.add(decal);

    // JUMP label. orange accent matches the fire colour.
    this._addActionLabel(grp, "JUMP", 3.0, 0xff9020);
    this.obstacles.push({
      mesh: grp, lane, spawnAt: zWorld, type: "fire",
      w: 1.9, h: 0.6, slidable: false, action: "jump", decal,
    });
  }

  // Swooping ravens: 3 dark birds at chest/head height that span lanes.
  // Player must SLIDE to avoid them. Acts like the hazard bar but is alive
  // looking.
  _spawnRavens(zWorld) {
    const grp = new THREE.Group();
    const span = 12;
    for (let i = -2; i <= 2; i++) {
      const bird = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0x0a0a10, roughness: 0.5, flatShading: true })
      );
      body.scale.z = 1.6;
      bird.add(body);
      // Wings
      for (const side of [-1, 1]) {
        const wing = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.04, 0.18),
          new THREE.MeshStandardMaterial({ color: 0x141422, roughness: 0.6, flatShading: true })
        );
        wing.position.set(side * 0.35, 0.04, 0);
        wing.rotation.z = side * 0.3;
        wing.userData.side = side;
        wing.userData.phase = Math.random() * Math.PI * 2;
        bird.add(wing);
      }
      // Glowing eye
      const eye = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xff3010 })
      );
      eye.position.set(0.08, 0.06, 0.32);
      bird.add(eye);
      bird.position.set(i * 2.4, 1.85, i * 0.3);
      bird.userData.phase = Math.random() * Math.PI * 2;
      grp.add(bird);
    }
    grp.position.z = zWorld;
    this.scene.add(grp);

    const decals = [];
    for (let li = 0; li < 3; li++) {
      const d = this._makeGroundDecal(0xff4020, 0.95);
      d.position.set(LANES[li], 0.06, zWorld);
      this.scene.add(d);
      decals.push(d);
    }
    // SLIDE label. same red as the beam since the verb is identical.
    this._addActionLabel(grp, "SLIDE", 3.5, 0xff3030);
    this.obstacles.push({
      mesh: grp, lane: -1, spawnAt: zWorld, type: "ravens",
      w: 999, h: 0.55, slidable: true, yMin: 1.5, action: "slide", decal: decals,
    });
  }

  // ---------- Frame ----------
  _frame(now) {
    const realDt = Math.min(0.05, (now - this._lastT) / 1000);
    this._lastT = now;
    // Track an EMA of frame time so we can drop quality if the GPU is
    // struggling. Updates every frame, ~1s smoothing.
    this._frameEMA = this._frameEMA == null ? realDt : (this._frameEMA * 0.95 + realDt * 0.05);
    // Adaptive post. disable heavy passes if running below 40 FPS
    // sustained, re-enable above 50 FPS. Hysteresis prevents flicker.
    // SSAO drops first (most expensive), bloom second.
    if (this.ssaoPass) {
      if (this._frameEMA > 0.022 && this.ssaoPass.enabled) {
        this.ssaoPass.enabled = false;
      } else if (this._frameEMA < 0.017 && !this.ssaoPass.enabled) {
        this.ssaoPass.enabled = true;
      }
    }
    if (this.bloomPass) {
      if (this._frameEMA > 0.028 && this.bloomPass.enabled) {
        this.bloomPass.enabled = false;
      } else if (this._frameEMA < 0.020 && !this.bloomPass.enabled) {
        this.bloomPass.enabled = true;
      }
    }
    // Ease toward the active time scale (1 normally, 0.35 during rune slow-mo).
    this._timeScale += (this._timeScaleTarget - this._timeScale) * Math.min(1, realDt * 8);
    const dt = realDt * this._timeScale;
    if (!this.paused) this._update(dt);
    // Half-rate render when not playing (menu, game-over). Halves GPU
    // load on the title screen.
    if (this.running || this.paused) {
      this._render();
    } else {
      this._idleFrame = (this._idleFrame || 0) + 1;
      if ((this._idleFrame & 1) === 0) this._render();
    }
    // FPS sampling + runtime quality auto-downgrade.
    this._sampleFps(realDt);
    requestAnimationFrame(this._frame);
  }

  // Rolling FPS via EMA. When sustained <25 fps in-game, auto-downgrade
  // heavy features one at a time (HDRI off → shadow map smaller → no
  // shadows). When >55 fps for sustained period, leave settings as-is
  // (we don't auto-upgrade because that causes oscillation).
  _sampleFps(dt) {
    if (!this._fpsState) {
      this._fpsState = { ema: 60, since: performance.now(), badStart: 0, downgrades: 0 };
    }
    const f = this._fpsState;
    const fps = 1 / Math.max(0.001, dt);
    // EMA with ~1s time constant
    f.ema = f.ema * 0.9 + fps * 0.1;

    // Update visible FPS overlay (if shown)
    if (this._fpsOverlay && (performance.now() - (f.lastDisplayed || 0) > 250)) {
      f.lastDisplayed = performance.now();
      this._fpsOverlay.textContent = `${f.ema.toFixed(0)} fps · ${this.quality}${f.downgrades ? ` · auto-down ×${f.downgrades}` : ""}`;
      this._fpsOverlay.style.color = f.ema > 50 ? "#a3e8b8" : f.ema > 30 ? "#ffd066" : "#ff8a7a";
    }

    // Only auto-downgrade during active play
    if (!this.running || this.paused) { f.badStart = 0; return; }
    if (f.ema < 25) {
      if (!f.badStart) f.badStart = performance.now();
      // Sustained 3s of <25fps → step down
      if (performance.now() - f.badStart > 3000 && f.downgrades < 3) {
        f.downgrades++;
        f.badStart = 0;
        this._autoDowngrade(f.downgrades);
      }
    } else {
      f.badStart = 0;
    }
  }

  // Step-down ladder. Each step is non-destructive (no reload needed).
  _autoDowngrade(step) {
    if (step === 1) {
      // Step 1: drop HDRI environment (often the biggest hit on
      // weaker GPUs because every PBR material samples it).
      if (this.scene.environment) {
        const env = this.scene.environment;
        this.scene.environment = null;
        try { env.dispose(); } catch {}
        console.warn("[Valhalla] auto-downgrade #1: dropped HDRI environment");
        this._fpsToast("Auto-downgrade: HDRI off");
      }
    } else if (step === 2) {
      // Step 2: shrink shadow map.
      if (this.sun && this.sun.shadow) {
        this.sun.shadow.mapSize.set(256, 256);
        this.sun.shadow.map?.dispose?.();
        this.sun.shadow.map = null;
        console.warn("[Valhalla] auto-downgrade #2: shadow map -> 256");
        this._fpsToast("Auto-downgrade: shadows reduced");
      }
    } else if (step === 3) {
      // Step 3: disable shadows entirely.
      this.renderer.shadowMap.enabled = false;
      if (this.sun) this.sun.castShadow = false;
      console.warn("[Valhalla] auto-downgrade #3: shadows disabled");
      this._fpsToast("Auto-downgrade: shadows off. consider Graphics → Low");
    }
  }

  // Big, visible error banner shown when bio start fails. The button
  // text alone was getting truncated and missed. This banner sits at
  // the top of the screen for 8s with the full error message so the
  // user sees exactly what blocked the sensor.
  _showBioErrorBanner(msg) {
    let el = document.getElementById("bioErrBanner");
    if (!el) {
      el = document.createElement("div");
      el.id = "bioErrBanner";
      el.style.cssText = "position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:90;padding:10px 16px;background:rgba(60,8,8,.96);color:#ffd066;border:1px solid rgba(255,140,90,.6);border-radius:6px;font:600 12.5px/1.4 -apple-system,system-ui,sans-serif;letter-spacing:.02em;max-width:min(560px,90vw);text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.7)";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    el.style.display = "block";
    clearTimeout(this._bioErrT);
    this._bioErrT = setTimeout(() => { el.style.opacity = "0"; setTimeout(() => { el.style.display = "none"; }, 400); }, 8000);
  }

  // Tiny non-blocking toast for downgrade notifications.
  _fpsToast(msg) {
    let t = document.getElementById("fpsToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "fpsToast";
      t.style.cssText = "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:60;padding:8px 14px;background:rgba(60,8,8,.9);color:#ffd066;border:1px solid rgba(255,200,100,.5);border-radius:6px;font:600 12px/1.2 -apple-system,system-ui,sans-serif;letter-spacing:.04em;box-shadow:0 6px 24px rgba(0,0,0,.7);pointer-events:none;opacity:0;transition:opacity .25s ease";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(this._fpsToastT);
    this._fpsToastT = setTimeout(() => { t.style.opacity = "0"; }, 4000);
  }

  // Toggle FPS overlay. Bound to a key (~) so power users can debug.
  _toggleFpsOverlay() {
    if (this._fpsOverlay) {
      this._fpsOverlay.remove();
      this._fpsOverlay = null;
      return;
    }
    const el = document.createElement("div");
    el.id = "fpsOverlay";
    el.style.cssText = "position:fixed;left:14px;bottom:14px;z-index:60;padding:5px 9px;background:rgba(0,0,0,.65);color:#a3e8b8;border:1px solid rgba(255,255,255,.15);border-radius:5px;font:600 11px/1 ui-monospace,Menlo,Consolas,monospace;pointer-events:none";
    el.textContent = ".  fps";
    document.body.appendChild(el);
    this._fpsOverlay = el;
  }

  _update(dt) {
    if (!this.running) {
      // gentle parallax on title screen - drift snow + rotate ravens
      this._updateAmbient(dt);
      return;
    }

    // Speed ramp + BIO MODULATION (the centrepiece).
    // The base ramp is the same as before. Then bio directly modulates:
    //   - Heart rate: each BPM above 70 bumps speed by 0.6%, capped at
    //     +30% (so 120 BPM = +30% speed, which is the "panic / berserker
    //     fast" feeling. and you'll lose if you can't calm down)
    //   - Cognitive state: flow halves the speed bump (you stay in
    //     control), meditation gives a 10% slow.
    //   - Powerup: speed gives +35%, ship +25%.
    // The HR bump is the most visceral bio→gameplay link: the player
    // can FEEL their pulse making the game harder, and they have to
    // calm down to win. That's the addictive thesis-pump loop.
    let target = BASE_SPEED + Math.min(this.distance * 0.012, MAX_SPEED - BASE_SPEED);
    if (this.bpm && this.bpm > 70) {
      const over = Math.min(50, this.bpm - 70);              // 0..50 bpm over
      let bump = 1 + over * 0.006;                            // up to +30%
      // Flow keeps the player in control even when HR rises.
      if (this.cognitiveState === "flow") bump = 1 + (bump - 1) * 0.5;
      target *= bump;
      this._bioSpeedBump = bump;                              // expose for HUD
    } else {
      this._bioSpeedBump = 1;
    }
    if (this.sprint) target *= 1.18;
    if (this.cognitiveState === "berserker") target *= 1.12;
    else if (this.cognitiveState === "meditation") target *= 0.9;
    if (this.power.speed > 0) target *= 1.35;
    if (this.power.ship > 0) target *= 1.25;
    this.speed += (target - this.speed) * Math.min(1, dt * 2);

    // Tick down active powerups
    for (const k of Object.keys(this.power)) {
      if (this.power[k] > 0) {
        this.power[k] = Math.max(0, this.power[k] - dt);
        if (this.power[k] === 0) this._onPowerupEnd(k);
      }
    }
    this._updatePowerHud(dt);
    this._updateGodPowers(dt);
    this._updateBioAura(dt);
    this._updateBiome(dt);
    this._updateBreath(dt);
    this._updateBioSession(dt);
    this._updateWorldMarkers(dt);
    // Drive the real character's animation mixer. Speed scales with
    // game speed so legs cycle in sync with apparent motion.
    if (this._mixer) {
      const animSpeed = Math.max(0.5, this.speed / BASE_SPEED);
      this._mixer.update(dt * animSpeed);
    }
    // Aurora ribbons. gentle drift / sway. No shader uniforms now;
    // we just rotate them subtly so the curtains look alive.
    if (this._aurora) {
      const t = performance.now() * 0.0004;
      for (let i = 0; i < this._aurora.length; i++) {
        const m = this._aurora[i];
        if (!m.visible) continue;
        m.rotation.z = Math.sin(t + i * 1.2) * 0.06;
        m.position.x = Math.sin(t * 0.7 + i) * 8;
      }
    }
    // Boss actor. scrolls with the world, idles dramatically, fights,
    // dies. Now also drives the screen-space HP banner for unambiguous
    // boss-fight UI (the in-world bar above the head was easy to miss).
    const bossBanner = document.getElementById("bossBanner");
    if (this._bossActor) {
      const b = this._bossActor;
      const sz = b.spawnAt - this.distance;
      b.mesh.position.z = sz;

      if (b.defeated) {
        // Death sequence: tilt forward + drop + fade out over 1.6s.
        b.fallTimer = (b.fallTimer || 0) + dt;
        const fall = Math.min(1, b.fallTimer / 1.6);
        b.mesh.rotation.x = -fall * 1.4;
        b.mesh.position.y = -fall * 4;
        if (b.hpFill) b.hpFill.visible = false;
        if (bossBanner) bossBanner.style.display = "none";
        if (fall >= 1 && sz < -10) {
          this.scene.remove(b.mesh);
          this._bossActor = null;
        }
      } else {
        // BIGGER, more dramatic idle. Was a quiet 0.18m bob. easy
        // to miss. Now 0.45m bob + 0.12rad sway, slightly faster.
        // The boss visibly BREATHES + ROCKS.
        b.idle += dt;
        b.mesh.position.y = Math.sin(b.idle * 1.4) * 0.45;
        b.mesh.rotation.y = Math.sin(b.idle * 0.8) * 0.12;
        // If boss has arms (children with x > 2), swing them like an
        // angry war-stance. Children indexed by position so we don't
        // need to keep separate refs.
        for (const c of b.mesh.children) {
          if (c.position && Math.abs(c.position.x) > 1.8 && c.position.y > 3 && c.position.y < 6) {
            c.rotation.z = Math.sin(b.idle * 1.6 + (c.position.x > 0 ? 0 : Math.PI)) * 0.18;
          }
        }

        // BIO DAMAGE: being in Flow state during a fight ticks damage
        // continuously (5/s). This is the "your physiology helps you
        // beat bosses" loop the user asked for. Berserker = 3/s.
        if (this.cognitiveState === "flow")        this._damageBoss(5 * dt, "flow");
        else if (this.cognitiveState === "berserker") this._damageBoss(3 * dt, "berserker");

        // SCREEN-SPACE BOSS BANNER. always-visible HP + name + hint
        // while the boss is in front of the player.
        if (bossBanner && sz > -10) {
          bossBanner.style.display = "block";
          const nameEl = document.getElementById("bossBannerName");
          const fillEl = document.getElementById("bossBannerFill");
          if (nameEl) nameEl.textContent = b.type.toUpperCase();
          if (fillEl) fillEl.style.width = Math.max(0, (b.hp / b.hpMax) * 100) + "%";
        } else if (bossBanner) {
          bossBanner.style.display = "none";
        }

        // Boss escapes if it scrolls 20m past the player still alive.
        if (sz < -20 && !b.escaped) this._bossEscaped();
        if (sz < -30) {
          this.scene.remove(b.mesh);
          this._bossActor = null;
          if (bossBanner) bossBanner.style.display = "none";
        }
      }

      // In-world HP bar still updated, just less prominent than the
      // screen-space banner.
      if (b.hpFill && !b.defeated) {
        const w = b.hpFillBaseWidth;
        const pct = Math.max(0.001, b.hp / b.hpMax);
        b.hpFill.position.x = -(w * (1 - pct)) * 0.5;
      }
    } else {
      // No boss. make sure banner is hidden.
      if (bossBanner) bossBanner.style.display = "none";
    }

    // forward distance
    this.distance += this.speed * dt;

    // SCORE MULTIPLIERS STACK: bio state + combo + powerup, with
    // LOSS AVERSION applied as a punish-state penalty (stress and
    // fatigue actively reduce score, not just deny bonus). User
    // can FEEL their body costing them points.
    const cs = this.cognitiveState;
    const flowMul = (cs === "flow")       ? 2.0 :
                    (cs === "focused")    ? 1.4 :
                    (cs === "berserker")  ? 1.5 :
                    (cs === "calm")       ? 1.1 :
                    (cs === "meditation") ? 0.95 :       // tradeoff: slow but easier
                    (cs === "stress")     ? 0.55 :       // PENALTY: storm-heart loses
                    (cs === "fatigue")    ? 0.7 :        // PENALTY: oar-weary, weak swing
                    (cs === "distracted") ? 0.85 :       // mild penalty
                    1.0;
    const powerMul = this.power.mult > 0 ? 2.0 : 1.0;
    this.score += dt * this.speed * 0.6 * (1 + this.combo * 0.05) * flowMul * powerMul;

    // lane lerp
    const px = this.player.position.x;
    this.player.position.x = px + (this.targetLaneX - px) * Math.min(1, dt * 11);

    // jump physics
    this.playerVy -= GRAVITY * dt;
    this.playerY += this.playerVy * dt;
    if (this.playerY < 0) { this.playerY = 0; this.playerVy = 0; }
    // Longship lifts the player up while riding
    const lift = this._shipLift || 0;
    this.player.position.y = this.playerY + lift;
    // Move longship under player
    if (this._longship) {
      this._longship.position.x = this.player.position.x;
      this._longship.position.z = this.player.position.z;
      this._longship.position.y = lift - 0.4 + Math.sin(performance.now() * 0.003) * 0.08;
    }

    // slide
    if (this.sliding) {
      this.slideTimer -= dt;
      this.player.scale.set(1, 0.55, 1.4);
      this.player.position.y = this.playerY + 0.05;
      if (this.slideTimer <= 0) { this.sliding = false; this.player.scale.set(1, 1, 1); }
    } else {
      this.player.scale.set(1, 1, 1);
    }

    // run-cycle anim
    const t = performance.now() * 0.012 * (this.speed / BASE_SPEED);
    const swing = Math.sin(t) * 0.7;
    if (this.playerY < 0.05 && !this.sliding) {
      this.playerParts.legL.rotation.x = swing;
      this.playerParts.legR.rotation.x = -swing;
      this.playerParts.armL.rotation.x = -swing * 0.8;
      this.playerParts.armR.rotation.x = swing * 0.8;
    } else {
      this.playerParts.legL.rotation.x *= 0.9;
      this.playerParts.legR.rotation.x *= 0.9;
      this.playerParts.armL.rotation.x *= 0.9;
      this.playerParts.armR.rotation.x *= 0.9;
    }
    // tiny body bob
    this.player.rotation.z = Math.sin(t * 0.5) * 0.04;

    // shadow follows player x
    this.shadowDisc.position.x = this.player.position.x;
    this.shadowDisc.scale.setScalar(Math.max(0.4, 1 - this.playerY * 0.18));
    this.shadowDisc.material.opacity = Math.max(0.05, 0.35 - this.playerY * 0.04);

    // Footprint trail - only stamp while grounded and running
    if (this.playerY < 0.05 && !this.sliding && this.running) {
      this._fpAccum += this.speed * dt;
      // one footstep ~ every 0.9m of forward travel
      while (this._fpAccum > 0.9) {
        this._fpAccum -= 0.9;
        const fp = this.footprints[this._fpIdx];
        fp.visible = true;
        fp.position.x = this.player.position.x + fp.userData.side;
        fp.userData.spawnAt = this.distance;
        fp.material.opacity = 0.45;
        this._fpIdx = (this._fpIdx + 1) % this.footprints.length;
        // SNOW CRUNCH. each footprint plays a randomised crunch.
        // Single biggest 'this is real' cue at running speed.
        if (this.audio?.footstep) this.audio.footstep();
      }
    }

    // FIRE PROXIMITY. fade fire-crackle ambience up when near any
    // fire pit (scenery or obstacle). Squared falloff, max ~12m.
    if (this.audio?.setFireProximity) {
      let nearest = Infinity;
      // scenery pits
      if (this.firePits) {
        for (const pit of this.firePits.children) {
          const dz = (pit.position.z - this.distance);
          const dx = pit.position.x - this.player.position.x;
          const d = Math.hypot(dx, dz);
          if (d < nearest) nearest = d;
        }
      }
      // in-game fire obstacles
      for (const o of this.obstacles) {
        if (o.type !== "fire") continue;
        const dz = (o.spawnAt - this.distance);
        const dx = LANES[o.lane] - this.player.position.x;
        const d = Math.hypot(dx, dz);
        if (d < nearest) nearest = d;
      }
      const prox = nearest < 12 ? 1 - (nearest / 12) ** 2 : 0;
      this.audio.setFireProximity(prox);
    }
    // Scroll all live footprints and fade them
    for (const fp of this.footprints) {
      if (!fp.visible) continue;
      const sceneZ = fp.userData.spawnAt - this.distance;
      fp.position.z = sceneZ;
      // Fade out as they age past 8m behind
      const age = -sceneZ;
      if (age > 2) fp.material.opacity = Math.max(0, 0.45 - (age - 2) * 0.06);
      if (sceneZ < -16) fp.visible = false;
    }

    // Camera follow with VISCERAL motion. Two synced oscillators:
    //   - Vertical "footfall" bob at 2× the leg-cycle frequency,
    //     amplitude scaling with run speed. This is the single
    //     biggest "I'm actually moving" cue.
    //   - Horizontal sway at half the bob freq for a natural swing.
    // Frequencies derived from gait research: ~2 Hz footfall at jog
    // speed, ~3 Hz at sprint. Scaling speed/BASE → freq matches that.
    const gaitFreq = 2.0 + Math.min(1.5, (this.speed - BASE_SPEED) * 0.04);
    const bobAmp   = 0.08 + Math.min(0.22, (this.speed - BASE_SPEED) * 0.007);
    const swayAmp  = 0.10 + Math.min(0.12, (this.speed - BASE_SPEED) * 0.003);
    const phase = performance.now() * 0.001 * gaitFreq * Math.PI;
    // HANDHELD BREATHING. Low-freq perlin-style sway adds the
    // operator-with-a-real-camera feel that pure procedural cameras
    // lack. Sub-pixel amplitude; you don't see it consciously but the
    // scene stops feeling like a fixed render. Apple-tier touch.
    const t = performance.now() * 0.001;
    const handheldX = Math.sin(t * 0.31) * 0.06 + Math.sin(t * 0.73) * 0.03;
    const handheldY = Math.sin(t * 0.27) * 0.04 + Math.cos(t * 0.59) * 0.02;
    const camTargetX = this.player.position.x * 0.4 + Math.sin(phase * 0.5) * swayAmp + handheldX;
    const camTargetY = 5.3 + Math.abs(Math.sin(phase)) * bobAmp + this.playerY * 0.12 + handheldY;
    this.camera.position.x += (camTargetX - this.camera.position.x) * Math.min(1, dt * 4);
    this.camera.position.y += (camTargetY - this.camera.position.y) * Math.min(1, dt * 4);
    this.camera.position.z = -12;
    // FOV breathing. Tied to heart rate when bio is live, otherwise
    // a quiet 0.25 Hz baseline. ±0.4° about the resting FOV.
    const baseFov = this._baseFov || (this._baseFov = this.camera.fov);
    const breathHz = this.bpm ? (this.bpm / 60) : 0.25;
    const fovOffset = Math.sin(t * breathHz * Math.PI * 2) * 0.4;
    this.camera.fov = baseFov + fovOffset;
    this.camera.updateProjectionMatrix();

    // Trauma-based camera shake (decays, applied as offset).
    let shakeX = 0, shakeY = 0;
    if (this._shakeT > 0) {
      this._shakeT -= dt;
      const trauma = Math.max(0, this._shakeT / 0.25);
      const amp = this._shakeAmp * trauma * trauma;
      shakeX = (Math.random() - 0.5) * amp;
      shakeY = (Math.random() - 0.5) * amp;
      if (this._shakeT <= 0) this._shakeAmp = 0;
    }
    this.camera.position.x += shakeX;
    this.camera.position.y += shakeY;
    this.camera.lookAt(
      this.player.position.x * 0.6 + shakeX * 0.5,
      1.0 + this.playerY * 0.4 + shakeY * 0.5,
      28
    );
    // Camera lean reverted. setting camera.rotation.z directly AFTER
    // lookAt() flipped the view upside-down in some frames (the user
    // saw "you are walking on the opposite"). The visual lean was
    // not worth the orientation risk; the existing footfall bob +
    // sway already sells run-motion adequately.

    // sun follows camera-ish
    this.sun.position.set(this.player.position.x * 0.5 + 50, 80, this.distance + 30);
    this.sun.target.position.set(this.player.position.x, 0, this.distance + 5);

    // scroll terrain chunks: when a chunk is fully behind the camera, recycle it forward
    for (const ch of this.chunks) {
      const sceneZ = (ch.zStart + CHUNK_LENGTH / 2) - this.distance;
      ch.mesh.position.z = sceneZ;
      ch.decor.position.z = -this.distance + (ch.zStart - ch.zStart);
      // place decor with the chunk by translating
    }
    // decor: easier to manage as separate group with z = chunk.zStart - this.distance
    // (we set this on each frame for safety)
    for (const ch of this.chunks) {
      ch.decor.position.z = -this.distance;
    }
    // recycle chunks
    for (const ch of this.chunks) {
      if (ch.mesh.position.z < -CHUNK_LENGTH * 1.2) {
        // move forward by CHUNK_COUNT * CHUNK_LENGTH (in world distance terms)
        ch.zStart += CHUNK_COUNT * CHUNK_LENGTH;
        // rebuild displacement & color for new world position
        this._reseedChunk(ch);
      }
    }

    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const o = this.obstacles[i];
      const sz = o.spawnAt - this.distance;
      o.mesh.position.z = sz;
      // Scroll decals with the world. Decal sits in absolute world coords,
      // so we update its z each frame too. Pulse opacity for telegraph.
      if (o.decal) {
        const pulse = 0.4 + Math.abs(Math.sin(performance.now() * 0.006)) * 0.35;
        if (Array.isArray(o.decal)) {
          for (const d of o.decal) { d.position.z = sz; d.material.opacity = pulse; }
        } else {
          o.decal.position.z = sz;
          o.decal.material.opacity = pulse;
        }
      }
      if (o.type === "troll") o.mesh.rotation.y = Math.sin(performance.now() * 0.003) * 0.2;
      // Animate fire flames
      if (o.type === "fire" && o.mesh.userData.flames) {
        const flameTime = performance.now() * 0.006;
        for (let f = 0; f < o.mesh.userData.flames.children.length; f++) {
          const flame = o.mesh.userData.flames.children[f];
          flame.rotation.y = flameTime + flame.userData.basePhase;
          flame.scale.set(
            0.8 + Math.sin(flameTime * 1.3 + flame.userData.basePhase) * 0.2,
            0.85 + Math.sin(flameTime + flame.userData.basePhase) * 0.25,
            0.8 + Math.cos(flameTime * 1.1 + flame.userData.basePhase) * 0.2
          );
        }
      }
      // Animate ravens (wings flapping, slight horizontal drift)
      if (o.type === "ravens") {
        const rt = performance.now() * 0.01;
        for (const bird of o.mesh.children) {
          bird.position.y = 1.85 + Math.sin(rt + bird.userData.phase) * 0.12;
          for (const w of bird.children) {
            if (w.userData.side !== undefined) {
              w.rotation.z = w.userData.side * (0.3 + Math.sin(rt * 2 + w.userData.phase) * 0.6);
            }
          }
        }
      }
      // Mjölnir. while Thor's hammer is in your grasp, any obstacle that
      // enters the 25m forward strike-cone is destroyed by lightning before
      // it can touch you. Plays a faint thunder rumble + bonus score, and
      // flags the obstacle as consumed so the standard collision branch
      // below treats it as cleared.
      if (this.power.thor > 0 && !o._consumed && sz > -1 && sz < 25
          && o.type !== "beam" && o.type !== "ravens") {
        this._lightningStrike(o.mesh.position.clone(), o.lane);
        this.score += 15;
        o._consumed = true;
        o.spawnAt = this.distance - 100;
      }
      // Collision window scales with speed to avoid tunnelling at high
      // speed, but is HARD-CAPPED at 2m so a stutter / GC pause / hidden
      // tab does not produce a 9m hitbox that registers as "random death".
      // Min 1m, max 2m. Most frames at 60 FPS are 0.34–0.48m.
      const hitWindow = Math.max(1.0, Math.min(2.0, this.speed * dt * 1.5));
      // Tyr's Aegis (shield), Skíðblaðnir (ship), and Mjölnir (thor) all
      // grant invulnerability. Huginn & Muninn (odin) gives foresight via
      // slow-mo only. the player still has to dodge.
      const invul = this.invuln > 0 || this.power.shield > 0
                 || this.power.ship > 0  || this.power.thor > 0;
      if (Math.abs(sz) < hitWindow && !o._consumed) {
        const hit = this._hitsPlayer(o);
        if (hit && !invul) {
          this._takeHit();
          o._consumed = true;
          o.spawnAt = this.distance - 100;
        } else if (hit && invul) {
          this._popText("BUST", "rune", 0, -30);
          this._shake(0.25, 0.18);
          o._consumed = true;
          o.spawnAt = this.distance - 100;
        }
      }
      if (sz < -8) {
        this.scene.remove(o.mesh);
        if (o.decal) {
          if (Array.isArray(o.decal)) for (const d of o.decal) this.scene.remove(d);
          else this.scene.remove(o.decal);
        }
        this.obstacles.splice(i, 1);
        const inLane = o.lane === this.lane || o.type === "beam" || o.type === "ravens";
        if (inLane && o.type !== "beam" && o.type !== "ravens") {
          this.combo++;
          this._showCombo();
          if (this.combo > 1) {
            const bonus = 10 * this.combo;
            this.score += bonus;
            this._popText(`+${bonus}`, "combo", (Math.random() - 0.5) * 80, -40);
          }
          if (this.combo === 20) this._shake(0.6, 0.4);
        }
        // BOSS DAMAGE: a successfully-dodged encounter obstacle deals
        // its damage value (default 25). Bigger hazards = more damage.
        // The check is "obstacle scrolled past safely without being
        // consumed by collision", i.e. the player survived it.
        if (o.encounterBoss && !o._consumed) {
          const dmg = o.type === "beam" || o.type === "ravens" ? 30
                    : o.type === "fire" ? 22 : 18;
          this._damageBoss(dmg, "dodge");
        }
      }
    }

    // collectibles update
    for (let i = this.collectibles.length - 1; i >= 0; i--) {
      const c = this.collectibles[i];
      const sz = c.spawnAt - this.distance;
      let cx = LANES[c.lane];
      // Magnet: pull mead horizontally toward player when within ~6m ahead
      if (this.power.magnet > 0 && c.type === "mead" && sz > -2 && sz < 8) {
        const targetX = this.player.position.x;
        cx = LANES[c.lane] + (targetX - LANES[c.lane]) * Math.min(1, (8 - sz) / 8);
        c.mesh.position.x = cx;
      } else {
        c.mesh.position.x = LANES[c.lane];
      }
      c.mesh.position.z = sz;
      c.ang += dt * 3;
      // Runestones are heavy carved granite. they don't spin or hover.
      // Everything else (mead horns, powerup orbs) gets the magical bob.
      if (c.type !== "rune") {
        c.mesh.rotation.y = c.ang;
        const baseY = c.baseY != null ? c.baseY : 1.2;
        c.mesh.position.y = baseY + Math.sin(c.ang * 1.3) * 0.12;
      } else {
        c.mesh.position.y = 0;
      }
      // Reward decals scroll with the collectible. Use a separate (slower,
      // softer) pulse so they're distinguishable from the red danger rings.
      if (c.decal) {
        c.decal.position.z = sz;
        c.decal.position.x = LANES[c.lane];
        c.decal.material.opacity = 0.45 + Math.abs(Math.sin(performance.now() * 0.004 + c.ang)) * 0.3;
      }
      // Collision: tighter for mead (no magnet snap unless close), normal for others
      const xDist = Math.abs(this.player.position.x - cx);
      if (Math.abs(sz) < 0.9 && xDist < 1.2 &&
          this.playerY < 2.4 && this.playerY > -0.2) {
        if (c.type === "mead") {
          this.mead++;
          const gain = this.power.mult > 0 ? 50 : 25;
          this.score += gain;
          this.audio.collect();
          this._popText(`+${gain}`, "gold", (Math.random() - 0.5) * 60, 0);
        }
        if (c.type === "rune") {
          this.score += c.value;
          this.audio.collectRune();
          this._popText(`+${c.value}`, "rune", 0, -20);
          this._slowMo(0.35, 0.7);
          this.hud.glory.classList.add("on");
          setTimeout(() => this.hud.glory.classList.remove("on"), 350);
          // Track for lifetime/daily stats.
          this.runRunes = (this.runRunes || 0) + 1;
          // Runes hit the active boss HARD. they're the player's main
          // ranged attack during a fight.
          if (this._bossActor && !this._bossActor.defeated) {
            this._damageBoss(40, "rune");
          }
        }
        if (c.type === "powerup") {
          this._activatePowerup(c.pwType, c.value);
        }
        this.scene.remove(c.mesh);
        if (c.decal) this.scene.remove(c.decal);
        this.collectibles.splice(i, 1);
      } else if (sz < -8) {
        this.scene.remove(c.mesh);
        if (c.decal) this.scene.remove(c.decal);
        this.collectibles.splice(i, 1);
      }
    }

    // spawn ahead
    this._spawnAhead(dt);

    // snow drift
    this._driftSnow(dt);

    // mountain ring follows the player slowly so they always feel distant
    this.mountainRing.position.z = this.distance;
    // god rays follow the player so the light shaft is always present
    if (this.godRay) this.godRay.position.z = this.distance;
    if (this.godRay2) this.godRay2.position.z = this.distance;
    // skew water to follow distance
    this.water[0].position.z = this.distance + VIEW_DEPTH / 2;
    this.water[1].position.z = this.distance + VIEW_DEPTH / 2;
    this.water[0].material.uniforms["time"].value += dt;
    this.water[1].material.uniforms["time"].value += dt;

    // Huginn + Muninn. Odin's ravens always orbit the player
    this._updateOdinsRavens(dt);
    // Real animated horses galloping through the meadows
    this._updateRealHorses(dt);
    // Longship fleet sailing past
    this._updateLongships(dt);
    // Runestones + fire pits + pine forest + helms recycle behind→ahead
    this._updateRunestones();
    this._updateFirePits(dt);
    this._updatePineForest();
    this._updateBattleHelms();
    this._updateVikingProps();
    this._updateVikingNPCs(dt);
    // Atmospheric layers
    this._updateGodRays(dt);
    this._updateMist(dt);

    // scenery bobs. only the non-longship pieces (longships have their
    // own bob logic inside _updateLongships that combines forward sail
    // with the wave bob).
    for (const s of this.scenery) {
      if (s.isLongship) continue;
      s.mesh.position.y = s.baseY + Math.sin(performance.now() * 0.0011 + s.phase) * 0.08;
    }

    // invuln tick
    if (this.invuln > 0) {
      this.invuln -= dt;
      this.player.visible = Math.floor(performance.now() / 80) % 2 === 0;
    } else {
      this.player.visible = true;
    }

    this._updateHUD();
  }

  _hitsPlayer(o) {
    const px = this.player.position.x;
    // Row-spanning hazards at chest height: must slide.
    if (o.type === "beam" || o.type === "ravens") {
      return !this.sliding;
    }
    // Single-lane hazards: must be in different lane or jumped high enough.
    if (Math.abs(px - LANES[o.lane]) > (o.w * 0.5 + 0.55)) return false;
    // Fire pit is ground-level: jump clears it.
    if (o.type === "fire") {
      return this.playerY < 0.9;
    }
    if (this.playerY > o.h - 0.3) return false;
    return true;
  }

  _takeHit() {
    this.lives--;
    this.combo = 0;
    this._showCombo();
    this.invuln = 1.4;
    this.audio.hit();
    this._flash();
    this._shake(0.55, 0.35);
    // LIVES SYNC FIX. update HUD lives counter IMMEDIATELY on
    // collision instead of waiting for the next _updateHUD() at
    // end-of-frame. User reported the counter felt out-of-sync with
    // the hit. Also pop a big visible "-1" floater so the loss is
    // unmistakable.
    if (this.hud && this.hud.lives) {
      this._updateLivesDots();
    }
    this._popText("-1 LIFE", "combo", 0, -60);
    if (this.lives <= 0) this._gameOver();
  }

  // LIVES AS DOTS. Renders 3 quiet • dots (filled = alive, dim = lost).
  // Apple-style: numbers vanish, glyphs convey the state. CSS reads
  // data-lives attribute via ::before content.
  _updateLivesDots() {
    if (!this.hud || !this.hud.lives) return;
    const n = Math.max(0, Math.min(3, this.lives));
    const dots = "• ".repeat(n) + "◌ ".repeat(3 - n);
    this.hud.lives.setAttribute("data-lives", dots.trim());
    this.hud.lives.textContent = "";  // CSS ::before paints the dots
  }

  _reseedChunk(ch) {
    const pos = ch.mesh.geometry.attributes.position;
    const colors = ch.mesh.geometry.attributes.color;
    const nearWhite = new THREE.Color(0xeef5fb);
    const snowMid = new THREE.Color(0xc7d4dc);
    const moss = new THREE.Color(0x4d6149);
    const rock = new THREE.Color(0x5a6068);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i) + ch.zStart;
      const h = groundHeight(x, z);
      pos.setY(i, h);
      const distFromPath = Math.max(0, Math.abs(x) - 6);
      const t = Math.min(1, distFromPath / 18);
      const c = new THREE.Color();
      if (Math.abs(x) < 5.2) c.copy(nearWhite);
      else c.lerpColors(snowMid, distFromPath > 14 ? rock : moss, t);
      const n = fbm(x * 0.2, z * 0.2);
      c.r *= 0.9 + n * 0.2; c.g *= 0.9 + n * 0.2; c.b *= 0.9 + n * 0.2;
      colors.setXYZ(i, c.r, c.g, c.b);
    }
    pos.needsUpdate = true; colors.needsUpdate = true;
    ch.mesh.geometry.computeVertexNormals();
    // rebuild decor
    this.scene.remove(ch.decor);
    ch.decor = this._populateChunk(ch.zStart);
  }

  _driftSnow(dt) {
    // Far layer: drifts down + back (we're running forward into it)
    if (this.snow) {
      const pos = this.snow.geometry.attributes.position;
      const now = performance.now();
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) - dt * 4;
        let x = pos.getX(i) + Math.sin(now * 0.0009 + i) * dt * 0.5;
        let z = pos.getZ(i) - this.speed * dt * 0.6;
        if (y < 0.5) y = 50 + Math.random() * 10;
        if (z < -10) z += VIEW_DEPTH;
        pos.setX(i, x); pos.setY(i, y); pos.setZ(i, z);
      }
      pos.needsUpdate = true;
    }

    // Close layer: parented to follow camera so it always feels like
    // weather around you. Drifts faster relative to camera = stronger
    // sense of forward motion.
    if (this.snowClose) {
      const pos = this.snowClose.geometry.attributes.position;
      const now = performance.now();
      const forward = this.speed * dt * 0.9;
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) - dt * 6;
        let x = pos.getX(i) + Math.sin(now * 0.0017 + i * 0.7) * dt * 1.2;
        let z = pos.getZ(i) - forward;
        if (y < 0.2) { y = 12 + Math.random() * 3; x = (Math.random() - 0.5) * 36; }
        if (z < -18) z = 12 + Math.random() * 12;
        if (z > 16) z = -16;
        if (x > 18) x = -18;
        if (x < -18) x = 18;
        pos.setX(i, x); pos.setY(i, y); pos.setZ(i, z);
      }
      pos.needsUpdate = true;
      // Follow the camera so weather feels relative to you, not the world
      this.snowClose.position.x = this.camera.position.x;
      this.snowClose.position.z = this.camera.position.z + 14;
    }
  }

  _updateAmbient(dt) {
    // slow rotate the camera around for ambient title screen
    const t = performance.now() * 0.0002;
    this.camera.position.x = Math.sin(t) * 4;
    this.camera.position.y = 4.2;
    this.camera.position.z = -8 + Math.cos(t) * 2;
    this.camera.lookAt(0, 1.6, 14);
    this._driftSnow(dt);
    if (this.water?.[0]) {
      this.water[0].material.uniforms["time"].value += dt;
      this.water[1].material.uniforms["time"].value += dt;
    }
    // Menu-screen raven orbit: spin Odin's two ravens at a slow,
    // dreamlike cadence around the spotlit player. _updateOdinsRavens
    // handles its own time math; we just need to call it here so the
    // birds don't freeze on the title screen.
    this._updateOdinsRavens(dt);
  }

  _updateHUD() {
    this.hud.score.textContent = Math.floor(this.score).toLocaleString();
    this.hud.dist.textContent = `${Math.round(this.distance)}m`;
    this._updateLivesDots();
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setSize(w, h);
      if (this.bloomPass) this.bloomPass.setSize(w * 0.4, h * 0.4);
      if (this.ssaoPass)  this.ssaoPass.setSize(w * 0.5, h * 0.5);
      if (this.fxaaPass) {
        this.fxaaPass.material.uniforms["resolution"].value.set(
          1 / (w * this.renderer.getPixelRatio()),
          1 / (h * this.renderer.getPixelRatio())
        );
      }
    }
  }

  // Use the post-processed composer when available so bloom + AA hit
  // every frame. Falls back to direct renderer.render if the composer
  // failed to init (browser without WebGL2, etc).
  _renderOnce() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
  _render() {
    // DEFENSIVE: if scene.background got nulled (HDRI dispose, auto-
    // downgrade race, context-loss recovery), restore it to the
    // current biome fog colour. Black screen on game-start was traced
    // to a boot-time throw nulling subsequent setup; this is the last
    // line of defence so a render frame ALWAYS clears to a visible
    // colour even if every other system above fails.
    if (!this.scene.background) {
      this.scene.background = new THREE.Color(0x6e7a86);
    }
    try {
      if (this.composer) this.composer.render();
      else this.renderer.render(this.scene, this.camera);
    } catch (e) {
      // If composer chain throws (rare, e.g. shader compile fail
      // mid-frame), fall back to direct render so we never show a
      // black frame from a thrown error.
      try { this.renderer.render(this.scene, this.camera); }
      catch (e2) { /* nothing to do; will retry next frame */ }
    }
  }
}

// Boot. Modules are deferred so DOM is already parsed when this runs.
function showFatal(html) {
  const ldr = $("loader");
  if (!ldr) return;
  ldr.classList.remove("hide");
  ldr.style.color = "#fff";
  ldr.innerHTML = html;
}

function boot() {
  // File-protocol detection. Opening index.html directly via double-click
  // makes the URL file:/// which most browsers won't allow ES module import
  // maps for. The page silently hangs on "Loading". Catch this up front
  // and tell the user how to actually run the game.
  if (location.protocol === "file:") {
    showFatal(`
      <div style="text-align:center;max-width:520px;line-height:1.6;padding:0 24px">
        <div style="font-size:18px;font-weight:600;color:#fff;margin-bottom:8px">Run the start script</div>
        <div style="font-size:13px;color:rgba(255,255,255,.7);margin-bottom:18px">
          You opened the file directly. The game needs a local web server because the
          biosignal sensors require a secure context (file:// is blocked).
        </div>
        <div style="font-size:12px;color:rgba(255,255,255,.55);background:rgba(255,255,255,.05);
          padding:14px 18px;border-radius:10px;text-align:left;font-family:monospace">
          <b style="color:#fff;font-family:inherit">Windows:</b> double-click <code>start-game.bat</code><br>
          <b style="color:#fff;font-family:inherit">macOS/Linux:</b> run <code>./start-game.sh</code><br>
          <b style="color:#fff;font-family:inherit">Or:</b> <code>node server.js</code> then open
          <code>http://localhost:8000</code>
        </div>
      </div>
    `);
    return;
  }
  try {
    window.__valhalla = new Valhalla();
    console.log("[Valhalla] booted");
  } catch (e) {
    console.error("[Valhalla] init failed", e);
    showFatal(`<div style='text-align:center;line-height:1.5'>Failed to load.<br><br><span style='font-size:11px;opacity:.7'>${(e && e.message) || e}</span></div>`);
  }
}
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

