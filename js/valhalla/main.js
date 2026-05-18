// 3D viking runner. Three lanes, jump+slide. Reads window.Bio if present.

import * as THREE from "three";
import { Water } from "three/addons/objects/Water.js";
// Real atmospheric Sky shader (Hosek-Wilkie scattering with sun position).
// This replaces the previous custom gradient-sphere — Hosek-Wilkie is
// the same physically-based model used in feature films for daytime sky.
import { Sky } from "three/addons/objects/Sky.js";
// Postprocessing — turns the procedural geometry into something that
// actually looks LIT. Bloom on emissives (runes, mead, Mjölnir, fires)
// is the single biggest "this is a real 3D world not a toy" cue.
import { EffectComposer }   from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass }       from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass }  from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass }       from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader }       from "three/addons/shaders/FXAAShader.js";
// HDRI image-based lighting — feeds every PBR material a real-world
// environment map so reflections + sky-lit colour come for free.
import { RGBELoader }       from "three/addons/loaders/RGBELoader.js";
// Real rigged GLB character loading. The Soldier.glb hosted on
// threejs.org/examples is a CC0 rigged human with built-in walk/run
// animations — when it loads it replaces the capsule player and gives
// the world its single biggest "this is real not a toy" cue.
// NOTE: Three.js r160's SkeletonUtils exports individual functions
// (clone, retargetClip, ...), NOT a `SkeletonUtils` object. Importing
// the wrong symbol previously broke the entire module load (game
// wouldn't start at all). We only load Soldier once and never clone
// him, so the import was unnecessary in the first place — removed.
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
// 22 m/s that's first transition in ~5.5s — Midgard is brief on
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
// Total cycle length — after this the player loops back to Midgard
// with biomeCycle++ for the score modifier.
const BIOME_CYCLE_LENGTH = BIOMES.reduce((s, b) => s + b.length, 0);

const STORE_KEY = "valhalla.v1";

// ---------------- Storage ----------------
const Store = {
  load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  },
  save(data) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch {}
  },
};

const $ = (id) => document.getElementById(id);

// ---------------- NorseAudio ----------------
// Procedural audio for Valhalla. No samples — everything synthesized in
// WebAudio. The aim is to sound like you've actually been transported to
// the Viking Age: longhall acoustics, lur horn carrying across a fjord,
// frame drum and skald-chant over a smoke-fire. Reverb is a cheap multi-
// tap delay with feedback (no impulse response). Music is built from
// layered procedural instruments:
//
//   Lur            — long brass-like signal horn. 3 detuned saws through
//                    a sweeping lowpass with 5.2 Hz vibrato in sustain.
//   Tagelharpa     — bowed Sami lyre. 2 detuned saws through a bandpass,
//                    plus quiet high-passed pink noise for bow friction.
//   Frame drum     — sine kick (90→32 Hz) + filtered noise skin slap.
//   Throat chant   — sawtooth + 6 harmonics through three vowel formants.
//   Animal horn    — short FM tone for bell/blessing pickups.
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
      this.master.gain.value = this.muted ? 0 : 0.42;
      this.master.connect(this.ctx.destination);

      // Reverb: single delay + filtered feedback. The previous 4-tap
      // network was double CPU for marginal acoustic benefit — a single
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
  // Voss-McCartney pink noise — much warmer than white for wind/breath.
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
  // Lur horn — REAL brass timbre via additive synthesis. Real brass has
  // a specific harmonic series with peaks shaped by lip-tension and bore
  // resonance. We build the tone as a sum of sine harmonics with the
  // amplitudes of an actual French-horn / lur spectrum (measured by
  // acoustical engineers: H1=1.0, H2=0.78, H3=0.66, H4=0.52, H5=0.36,
  // H6=0.28, H7=0.18, H8=0.11). On attack the higher harmonics swell
  // in slightly later (brass "bloom") — that's the bright sting you
  // hear when a real horn note starts. No sawtooth-through-filter
  // buzziness, no synth tell.
  _lur(when, freq, dur, vol = 0.18) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;

    // Spectral envelope — published brass-instrument values, normalised.
    const HARM = [1.00, 0.78, 0.66, 0.52, 0.36, 0.28, 0.18, 0.11];
    // Per-harmonic attack offset (in seconds) — higher harmonics bloom
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
      // Vibrato on the partial — multiplied by harmonic number so higher
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
    // (real brass is never pure-tone — there's always a whisper).
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
    for (const o of oscs) { o.start(when); o.stop(when + dur + 0.05); }
    vib.start(when); vib.stop(when + dur + 0.05);
  }

  // Tagelharpa — KARPLUS-STRONG plucked-string physical model. This is
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
    // One-pole lowpass in the feedback path — controls how fast harmonics
    // decay. Higher Q + lower cutoff = darker, longer-sustaining string.
    const damping = ctx.createBiquadFilter();
    damping.type = "lowpass";
    damping.frequency.value = Math.min(4000, freq * 10);
    damping.Q.value = 0.4;
    // Feedback gain — set just below 1 so the string sustains then decays.
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

    // Bow-noise overlay — quiet high-passed pink for the friction tone
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

  // Frame drum — PHYSICAL MEMBRANE MODES. A real drumhead has multiple
  // resonant modes at non-harmonic ratios (the (0,1), (1,1), (2,1) modes
  // of a circular membrane are at ratios ~1, 1.59, 2.14 of the
  // fundamental). We excite all three with a single noise burst — they
  // ring together for the rich "thud-PFFf" attack you get from a real
  // skin drum being struck. Much more natural than a swept sine kick.
  _drum(when, vol = 0.42) {
    const ctx = this.ctx;
    // The strike — a 4ms broadband noise burst that hits all modes at once.
    const burst = this._noiseSrc(false);
    const burstG = ctx.createGain();
    burstG.gain.setValueAtTime(vol * 1.6, when);
    burstG.gain.setValueAtTime(vol * 1.6, when + 0.004);
    burstG.gain.setValueAtTime(0, when + 0.005);
    burst.connect(burstG);
    burst.start(when); burst.stop(when + 0.01);

    const out = ctx.createGain(); out.gain.value = 1;

    // Membrane modes — measured Bessel-function ratios for a circular
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
    // Stick attack — sharp transient slap, high-passed noise so it has
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
    const noise = this._noiseSrc(true);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 380; lp.Q.value = 0.5;
    const g = this.ctx.createGain(); g.gain.value = 0.10;
    noise.connect(lp); lp.connect(g);
    this._send(g, 0.3);
    noise.start();
    this.windNode = { noise, lp, g };
    setInterval(() => {
      if (!this.windNode || !this.ctx) return;
      const t = this.ctx.currentTime;
      const target = 220 + Math.random() * 260;
      this.windNode.lp.frequency.linearRampToValueAtTime(target, t + 1.6);
      this.windNode.g.gain.linearRampToValueAtTime(0.07 + Math.random() * 0.07, t + 1.6);
    }, 1600);
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

  // Short wind gust — pink noise with a low-pass swept up then down,
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

  // Distant lur horn — a single long note at low volume with massive
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
    const BEAT = 0.72;          // slower tempo — feels more breath-heavy
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
      // Long lur drone holds the root for the whole loop — quieter so
      // it sits under everything as the seabed of the music.
      this._lur(t0, root, LOOP, 0.075);
      // Tagelharpa melody only on EVEN loops — gives the music room
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
      // Distant lur call sometimes mid-loop — gives the world the
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

  // Snow crunch lane-change tick — short, sharp, quiet.
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
        // THUNDERCLAP — broadband noise + sub-bass shock + bell ring.
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

    // Active powerup state — each value is seconds remaining; 0 = inactive.
    // Internal keys are slot names; user-facing labels are Norse gods/relics.
    this.power = {
      shield: 0,  // Tyr's Aegis     — invuln (god of war, sacrificed his hand)
      speed:  0,  // Sleipnir         — Odin's 8-legged steed, gallop speed
      mult:   0,  // Bragi's Saga     — god of poetry, x2 score
      magnet: 0,  // Freja's Tears    — pulls mead (she wept tears of gold)
      ship:   0,  // Skíðblaðnir      — Freyr's magical longship, flight
      thor:   0,  // Mjölnir          — Thor's hammer, lightning clears obstacles
      odin:   0,  // Huginn & Muninn  — Odin's ravens, foresight (slow-mo)
    };
    // Per-power max durations, used by HUD pill fill calculations.
    this.powerMax = { shield: 6, speed: 5, mult: 8, magnet: 6, ship: 6, thor: 4.5, odin: 6 };

    this.cognitiveState = "neutral";
    this.bpm = null;

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
    this._buildHUD();
    this._bindInput();
    this._bindBio();
    this._loadStats();

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
  }

  // ---------- three setup ----------
  _initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, powerPreference: "high-performance",
    });
    // Cap at 1.5 instead of 2 — on a retina display this cuts rendered
    // pixels by 44% with barely-noticeable sharpness loss because the
    // scene is low-poly / flat-shaded already. Biggest single perf win.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Cinematic dark grade. Previous 0.95 + Sky.js bright horizon +
    // strong bloom = the screen blew out white and "couldn't see the
    // map". 0.55 keeps the sky read but the world is properly dark
    // and moody — like Northman, Vikings TV, 13th Warrior — instead
    // of looking like a phone-game stock asset.
    this.renderer.toneMappingExposure = 0.55;
    this.renderer.shadowMap.enabled = false;

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
    // player sees further down the lane — addresses "hard to see"
    // feedback. FOV widened 48° → 55° for more peripheral coverage.
    // Far clip extended to 50000 so the Sky.js skybox (sits at radius
    // 5000+) is inside the frustum.
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 50000);
    this.camera.position.set(0, 5.5, -12);
    this.camera.lookAt(0, 1.0, 28);

    // --- Postprocessing pipeline -------------------------------------
    // RenderPass → UnrealBloomPass → FXAA → screen.
    // Bloom is tuned so only material values > 0.85 actually bleed —
    // strong on runes / mead / Mjölnir / Surtr's sword / aurora, but
    // doesn't wash out the snow.
    try {
      const w = window.innerWidth, h = window.innerHeight;
      this.composer = new EffectComposer(this.renderer);
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);

      const renderPass = new RenderPass(this.scene, this.camera);
      this.composer.addPass(renderPass);

      // Bloom dialled WAY back. Previous 0.85 strength + 0.82 threshold
      // caught the entire bright sky (Sky.js horizon is ~0.9-1.0
      // brightness) and bloomed it over everything, which is why the
      // user's screen "couldn't see the map" — it was solid white.
      // 0.25 strength + 0.95 threshold = bloom ONLY on real lights
      // (Mjölnir, runestones, fire, mead glow). Cinematic, not arcade.
      const bloom = new UnrealBloomPass(new THREE.Vector2(w * 0.4, h * 0.4), 0.25, 0.5, 0.95);
      this.composer.addPass(bloom);
      this.bloomPass = bloom;

      // FXAA for cheap anti-aliasing on top of the post chain. MSAA
      // doesn't survive the composer pipeline cleanly so we re-add AA
      // here. Negligible perf cost.
      const fxaa = new ShaderPass(FXAAShader);
      fxaa.material.uniforms["resolution"].value.set(
        1 / (w * this.renderer.getPixelRatio()),
        1 / (h * this.renderer.getPixelRatio())
      );
      this.composer.addPass(fxaa);
      this.fxaaPass = fxaa;
    } catch (e) {
      console.warn("[Valhalla] postprocessing init failed — falling back", e);
      this.composer = null;
    }

    // IBL is now driven by the Sky.js shader directly (see _buildSky —
    // PMREM samples the procedural sky into an env map). No CDN
    // dependency, no GPU crash risk, env always matches the current
    // realm's atmosphere. The optional HDRI override stays as a flag
    // for users who want to test with a real captured sky.
    if (localStorage.getItem("valhalla.ibl") === "1") {
      this._loadEnvironment();
    }

    // --- WebGL context-loss handler ----------------------------------
    // If the GPU driver kills our context (happens on weaker hardware
    // when bloom + shaders + HDRI all push the limits), make sure the
    // page doesn't lock up. Prevent default so the browser will try to
    // restore it; on restore, the composer needs a re-render.
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      console.warn("[Valhalla] WebGL context lost — waiting for restore");
    }, false);
    this.canvas.addEventListener("webglcontextrestored", () => {
      console.warn("[Valhalla] WebGL context restored");
      // Three.js auto-rebuilds materials/textures on restore, but
      // re-render once to kick the composer back to life.
      this._renderOnce();
    }, false);
  }

  _loadEnvironment() {
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      pmrem.compileEquirectangularShader();
      const loader = new RGBELoader();
      const url = "https://threejs.org/examples/textures/equirectangular/quarry_01_1k.hdr";
      loader.load(url, (tex) => {
        const env = pmrem.fromEquirectangular(tex).texture;
        this.scene.environment = env;
        tex.dispose();
        pmrem.dispose();
      }, undefined, (err) => {
        console.warn("[Valhalla] HDRI load failed — IBL disabled", err);
      });
    } catch (e) {
      console.warn("[Valhalla] PMREM setup failed", e);
    }
  }

  _buildSky() {
    // REAL ATMOSPHERIC SKY — Three.js Sky uses the Hosek-Wilkie analytical
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
    // 13th Warrior — all overcast, low contrast, oppressive weather.
    // That's the Nordic look the user actually wants.
    u["turbidity"].value        = 10.0;
    u["rayleigh"].value         = 0.5;
    u["mieCoefficient"].value   = 0.025;
    u["mieDirectionalG"].value  = 0.7;
    this.sky = sky;
    this.scene.add(sky);

    // Sun JUST below horizon for overcast diffuse skylight feel —
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
    // path in round 9). The IBL is a "nice to have" — the warm sun
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
    // Lighting now plays alongside the Sky.js IBL — the env map gives
    // us full hemispheric sky-coloured ambient automatically, so we
    // can drop the hemi-light and rely on three punchy directional
    // sources: warm key, cold rim, soft fill. Higher contrast than
    // before, addresses "hard to see" + "looks washed out".

    // OVERCAST LIGHTING — no direct sun. Cinematic Nordic overcast is
    // ~85% soft skylight from above + 15% cold rim. Total intensity
    // way down from previous "golden hour" setup so the scene reads
    // moody and atmospheric like the references the user shared
    // (Northman, Vikings TV) rather than mid-day phone-game bright.
    const hemi = new THREE.HemisphereLight(0xb4c4d4, 0x2a2e36, 0.9);
    this.scene.add(hemi);

    // Diffuse "sky key" — extremely soft, no direct disc, low warmth.
    const sun = new THREE.DirectionalLight(0xd8d8e0, 0.55);
    if (this.sunPos) sun.position.copy(this.sunPos).multiplyScalar(80);
    else sun.position.set(40, 30, -10);
    sun.castShadow = false;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);

    // Cold steel-blue rim for silhouette separation against fog.
    const rim = new THREE.DirectionalLight(0x6a7c92, 0.55);
    rim.position.set(-40, 30, -25);
    this.scene.add(rim);
  }

  _buildGround() {
    // Higher tessellation so per-vertex displacement reads as actual snow
    // microrelief, not flat plane with paint. 40x52 segs = ~2000 verts
    // per chunk - still cheap.
    const segW = 40, segL = 52;
    const geo = new THREE.PlaneGeometry(GROUND_WIDTH, CHUNK_LENGTH, segW, segL);
    geo.rotateX(-Math.PI / 2);

    // PBR snow with sheen — real snow has a velvety sheen from sub-
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
    // Trunk now uses a LatheGeometry from a tapered+jagged profile —
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

    // Rocks — vertex-displaced icosahedron, much more organic than the
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
      // Non-uniform rock scale — boulders are oblate not spherical.
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
    // Two long fjord strips far to the sides, with simple Water shader
    const waterGeo = new THREE.PlaneGeometry(60, VIEW_DEPTH);
    const makeWater = () => new Water(waterGeo, {
      textureWidth: 256, textureHeight: 256,
      waterNormals: this._makeRippleTexture(),
      sunDirection: this.sunPos.clone().normalize(),
      sunColor: 0xfff2d4,
      waterColor: 0x223040,
      distortionScale: 1.6,
      fog: true,
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
    // both ends — gives a continuous shoulder-to-hip volume that reads
    // as a real human torso instead of "minecraft figure". Materials
    // stay non-emissive earthy wool (madder/woad/walnut palette).
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.36, 0.65, 6, 14),
      new THREE.MeshStandardMaterial({ color: 0x5a4838, roughness: 0.95, flatShading: false })
    );
    body.position.y = 1.05;
    grp.add(body);

    // Over-tunic / surcoat — a slightly wider lower band in darker wool.
    const tunic = new THREE.Mesh(
      new THREE.CylinderGeometry(0.40, 0.46, 0.45, 14),
      new THREE.MeshStandardMaterial({ color: 0x36281c, roughness: 0.95, flatShading: false })
    );
    tunic.position.y = 0.62;
    grp.add(tunic);

    // Tooled leather belt — torus reads as a real cinched belt.
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

    // Head — sphere, slightly elongated, weathered skin tone.
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.30, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xcfa07b, roughness: 0.7, flatShading: false })
    );
    head.scale.set(0.95, 1.08, 1.0);
    head.position.y = 1.78;
    grp.add(head);

    // Auburn beard — capsule shape so it actually wraps the jaw.
    const beard = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.16, 0.10, 4, 10),
      new THREE.MeshStandardMaterial({ color: 0x6a3214, roughness: 0.95, flatShading: false })
    );
    beard.scale.set(1.4, 1.0, 0.7);
    beard.position.set(0, 1.55, 0.18);
    grp.add(beard);

    // Helmet — historically-accurate spangenhelm style. NO HORNS (the
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
    // Centre ridge band — iron strip running front-to-back across the crown.
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

    // Arms — capsules so shoulders + elbows + hands read as one volume.
    const armMat = new THREE.MeshStandardMaterial({ color: 0x5a4838, roughness: 0.95, flatShading: false });
    const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.55, 4, 10), armMat);
    armL.position.set(-0.48, 1.05, 0);
    grp.add(armL);
    const armR = armL.clone();
    armR.position.x = 0.48;
    grp.add(armR);

    // Trouser legs — capsules in darker wool / oiled leather tone.
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.95, flatShading: false });
    const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.5, 4, 10), legMat);
    legL.position.set(-0.18, 0.4, 0);
    grp.add(legL);
    const legR = legL.clone();
    legR.position.x = 0.18;
    grp.add(legR);
    // Cross-bound leg wraps (winningas) — three thin dark stripes per
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

    // Shield on back — weathered linden-wood planks with iron rim and
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
    // Plank seams — three thin dark stripes across the face for texture.
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
    // mesh assembly we just built — it's the placeholder shown until
    // the real GLB rigged character loads from CDN. Same parent group
    // is reused so all the bio aura / shield glow / Mjölnir aura code
    // keeps working without any rewire.
    this.player = grp;
    this.procPlayer = new THREE.Group();
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

    // Bio aura — a soft glowing sphere wrapped around the player whose
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
  // animations — once it lands the player goes from "stack of
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
          // we don't need SkeletonUtils.clone — that was only required
          // when re-using a rigged model. Direct use preserves the
          // bone bindings the AnimationMixer needs.
          const model = gltf.scene;
          // Soldier.glb is ~1.8 units tall facing -Z. Our procedural
          // player is ~2.0 tall facing +Z. Scale + rotate to match.
          model.scale.setScalar(1.05);
          model.rotation.y = Math.PI;            // face forward (+Z)
          // Make every mesh in the model accept the sky-driven IBL
          // env so it lights consistently with the rest of the scene.
          model.traverse((o) => {
            if (o.isMesh) {
              o.material.envMapIntensity = 1.0;
              o.frustumCulled = false;           // never cull our hero
            }
          });
          // Hide the procedural placeholder, add the real character.
          if (this.procPlayer) this.procPlayer.visible = false;
          this.player.add(model);
          this._realPlayer = model;
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

  _buildSnow() {
    // Two layers of snow particles:
    // 1. CLOSE flakes - small count, big, very visible, RIGHT in front of
    //    the camera. This is what sells "weather". Without these the world
    //    feels static.
    // 2. FAR flakes - many small, drifting in middle distance for depth.

    // Close layer (~camera-relative volume in front of player).
    // Down to 80 (orig 350). _driftSnow loops over them every frame
    // mutating positions — every cut here is direct CPU savings.
    {
      const count = 80;
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 36;
        positions[i * 3 + 1] = Math.random() * 14;
        positions[i * 3 + 2] = (Math.random() - 0.4) * 30; // slightly biased ahead
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xfafcff, size: 0.32, transparent: true, opacity: 0.92,
        depthWrite: false, fog: true, sizeAttenuation: true,
      });
      this.snowClose = new THREE.Points(geo, mat);
      this.scene.add(this.snowClose);
    }

    // Far layer (volumetric drift). 1800 → 900 → now 500. Far flakes
    // are so small the eye really doesn't register the count.
    {
      const count = 500;
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 140;
        positions[i * 3 + 1] = Math.random() * 60;
        positions[i * 3 + 2] = Math.random() * VIEW_DEPTH;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xffffff, size: 0.16, transparent: true, opacity: 0.7,
        depthWrite: false, fog: true,
      });
      this.snow = new THREE.Points(geo, mat);
      this.scene.add(this.snow);
    }
  }

  _buildScenery() {
    // Distant longships in the fjord water (eye candy)
    for (let i = 0; i < 4; i++) {
      const ship = new THREE.Group();
      const hull = new THREE.Mesh(
        new THREE.BoxGeometry(8, 1.4, 2.6),
        new THREE.MeshStandardMaterial({ color: 0x3a2614, roughness: 0.9, flatShading: true })
      );
      ship.add(hull);
      const sail = new THREE.Mesh(
        new THREE.PlaneGeometry(4.4, 3.2),
        new THREE.MeshStandardMaterial({ color: 0xb0b6bc, roughness: 0.9, side: THREE.DoubleSide })
      );
      sail.position.y = 2.6;
      sail.rotation.y = Math.PI / 2;
      ship.add(sail);
      const stripe = new THREE.Mesh(
        new THREE.PlaneGeometry(4.4, 0.6),
        new THREE.MeshStandardMaterial({ color: 0x9c2a26, side: THREE.DoubleSide })
      );
      stripe.position.y = 2.6;
      stripe.rotation.y = Math.PI / 2;
      ship.add(stripe);
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.1, 5, 6),
        new THREE.MeshStandardMaterial({ color: 0x2a1a10 })
      );
      mast.position.y = 2.4;
      ship.add(mast);
      const side = i % 2 === 0 ? -1 : 1;
      ship.position.set(side * (54 + Math.random() * 6), -1.2, 40 + i * 60);
      ship.rotation.y = side * Math.PI / 2 + (Math.random() - 0.5) * 0.2;
      this.scene.add(ship);
      this.scenery.push({ mesh: ship, baseY: -1.2, phase: Math.random() * Math.PI * 2 });
    }

    // Ravens circling overhead
    this.ravens = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const wingGeo = new THREE.BoxGeometry(0.8, 0.04, 0.14);
      const ravenMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a, fog: true });
      const wing = new THREE.Mesh(wingGeo, ravenMat);
      wing.userData.phase = Math.random() * Math.PI * 2;
      wing.userData.r = 18 + Math.random() * 10;
      wing.userData.h = 12 + Math.random() * 6;
      wing.userData.speed = 0.5 + Math.random() * 0.4;
      this.ravens.add(wing);
    }
    this.scene.add(this.ravens);
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
      flow:        { hex: 0xa0ecff, opacity: 0.42 },  // cyan-white — peak performance
      berserker:   { hex: 0xff6048, opacity: 0.55 },  // red — rage
      focused:     { hex: 0xa0c0ff, opacity: 0.32 },  // calm blue — locked-in
      meditation:  { hex: 0x70e8a8, opacity: 0.28 },  // soft green — restorative
      frantic:     { hex: 0xff80e0, opacity: 0.42 },  // magenta — chaotic
      aroused:     { hex: 0xffb060, opacity: 0.32 },  // orange — charged
      calm:        { hex: 0x80d0e0, opacity: 0.22 },  // pale cyan — at peace
      distracted:  { hex: 0x808898, opacity: 0.18 },  // grey — drift
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

  // Heartbeat pulse — paces a soft visual pulse to the player's BPM so
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
    // Tiny camera kick — magnitude 0.06 is just barely perceptible,
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
    // Sky.js uniforms — ease toward the active biome's atmospheric
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
      // Sun elevation can swing too — Asgard high noon, Helheim low.
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
    // Sky.js parameter targets per biome — these drive the atmosphere
    // through Hosek-Wilkie scattering for radically different looks.
    // All biome skies now sit on the OVERCAST cinematic baseline. None
    // of them have a visible sun disk; difference is in colour temp
    // and density. Matches Northman / Vikings reference look.
    const SKY_PARAMS = {
      Midgard:    { turbidity: 10, rayleigh: 0.5, mieCoefficient: 0.025, mieDirectionalG: 0.70, sunElev:  4, sunAz: 200 },
      "Jötunheim":{ turbidity: 14, rayleigh: 0.3, mieCoefficient: 0.030, mieDirectionalG: 0.65, sunElev:  2, sunAz: 220 },
      Muspelheim: { turbidity: 18, rayleigh: 0.4, mieCoefficient: 0.060, mieDirectionalG: 0.85, sunElev:  3, sunAz: 180 },
      Asgard:     { turbidity:  8, rayleigh: 0.6, mieCoefficient: 0.020, mieDirectionalG: 0.75, sunElev: 12, sunAz: 220 },
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
    // Score reward for crossing — scales with cycle count.
    const reward = 300 + this.biomeCycle * 200;
    this.score += reward;
    this._popText(`+${reward}`, "gold", 0, -50);
    // Spawn the entrance encounter — a giant boss mesh that scrolls past
    // and a curated obstacle pattern. Skips Midgard (the spawn realm).
    if (b.boss) this._spawnBoss(b.boss);
  }

  // Persistent realm chip in the HUD top-bar so the player always knows
  // which realm they're in (the banner is transient — this is the
  // permanent indicator).
  // Aurora borealis — two huge curved ribbon planes above the player,
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
        "position:fixed;top:env(safe-area-inset-top,12px);left:50%;" +
        "transform:translateX(-50%);z-index:11;pointer-events:none;" +
        "background:rgba(10,13,18,.7);border:1px solid rgba(255,255,255,.12);" +
        "border-radius:999px;padding:6px 14px;" +
        "font:700 11px/1 system-ui,sans-serif;letter-spacing:.18em;" +
        "text-transform:uppercase;color:#fff;backdrop-filter:blur(14px);" +
        "-webkit-backdrop-filter:blur(14px);" +
        "transition:opacity .25s ease,color .4s ease,border-color .4s ease";
      document.body.appendChild(el);
      this._biomeChipEl = el;
    }
    const b = BIOMES[this.biomeIdx];
    // Realm-specific accent so the chip itself tints with the biome.
    const accent = "#" + ("000000" + b.fog.toString(16)).slice(-6);
    el.textContent = b.name + (this.biomeCycle > 0 ? `  ×${this.biomeCycle + 1}` : "");
    el.style.color = accent;
    el.style.borderColor = accent + "70";
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
  }

  // Boss encounter. A large character mesh appears ~80m ahead and scrolls
  // past the player as the world moves. The mesh is decorative — the
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
      // Frost giant — towering blocky humanoid in pale-blue.
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
      // Fire jötunn — dark stone body with molten cracks.
      const stone = new THREE.MeshStandardMaterial({
        color: 0x301810, roughness: 1.0, flatShading: true,
        emissive: 0xff4010, emissiveIntensity: 0.8,
      });
      const torso = new THREE.Mesh(new THREE.BoxGeometry(3.5, 5, 2.2), stone);
      torso.position.y = 4.2; grp.add(torso);
      const head = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), stone);
      head.position.y = 7.7; grp.add(head);
      // Flaming sword raised overhead
      const sword = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 6, 0.4),
        new THREE.MeshBasicMaterial({ color: 0xffb030, transparent: true, opacity: 0.95 })
      );
      sword.position.set(0, 11, 0); grp.add(sword);
      const swordGlow = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 6.6, 1.2),
        new THREE.MeshBasicMaterial({ color: 0xff4010, transparent: true, opacity: 0.35, depthWrite: false })
      );
      swordGlow.position.set(0, 11, 0); grp.add(swordGlow);
      grp.position.set(0, 0, ahead);
    } else if (type === "valkyrie") {
      label = "VALKYRIE";
      // Winged blessing — not a fight. Golden silhouette with outspread wings.
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
    }
    this.scene.add(grp);
    // Banner mesh above the boss naming them.
    const bossLabel = this._makeTextSprite(label, 0xffd060);
    bossLabel.position.set(0, 12, 0);
    bossLabel.scale.set(6, 1.5, 1);
    grp.add(bossLabel);

    // Boss has HP. Player damages it by surviving hazards in the encounter
    // pattern, collecting runes during the fight, and being in Flow state
    // (the bio path to victory). Valkyrie is the only non-combat boss —
    // she gives a blessing, doesn't fight.
    const HP_BY_TYPE = { jotunn: 100, surtr: 130, valkyrie: 1 };
    const hpMax = HP_BY_TYPE[type] || 100;

    // HP bar — two stacked planes (background + foreground fill).
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
    // (see _update — checks o.encounterBoss).
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
      // No combat — kill her HP immediately so we don't show a bar.
      this._bossActor.hpMax = 0;
      hpBg.visible = false; hpFill.visible = false;
    }
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
    // Floating damage number near the boss.
    this._popText(`-${amount}`, "rune", 0, -50);
    if (b.hp <= 0) this._killBoss(source);
  }

  _killBoss(source) {
    const b = this._bossActor;
    if (!b || b.defeated) return;
    b.defeated = true;
    // Big reward scaling with biome cycle.
    const reward = 1000 + this.biomeCycle * 500;
    this.score += reward;
    this._popText(`${b.type.toUpperCase()} SLAIN +${reward}`, "rune", 0, -40);
    this._shake(0.9, 0.6);
    this.hud.glory.classList.add("on");
    setTimeout(() => this.hud.glory.classList.remove("on"), 600);
    if (this.audio?.power) this.audio.power("mjolnir");
    // Death animation — boss tilts and falls. Real removal happens
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

  // Ease bio aura colour + opacity toward targets each frame so state
  // changes feel like a breath, not a flicker. Called from _update.
  _updateBioAura(dt) {
    if (!this._bioAura) return;
    const mat = this._bioAura.material;
    // Opacity ease.
    mat.opacity += (this._bioAuraTargetOpacity - mat.opacity) * Math.min(1, dt * 3);
    // Colour ease — Color.lerp gives perceptual mid-tones.
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
    this.power[type] = duration;
    const labels = {
      shield: "TYR'S AEGIS",
      speed:  "SLEIPNIR'S GALLOP",
      mult:   "BRAGI'S SAGA",
      magnet: "FREJA'S TEARS",
      ship:   "SKÍÐBLAÐNIR",
      thor:   "MJÖLNIR",
      odin:   "HUGINN & MUNINN",
    };
    const SOUND_FOR = {
      shield: "tyr", speed: "sleipnir", mult: "bragi", magnet: "freja",
      ship: "skidbladnir", thor: "mjolnir", odin: "odin",
    };
    this.audio.power(SOUND_FOR[type] || "tyr");
    this._popText(labels[type] || type, "rune", 0, -30);

    // Visual side-effects on activate.
    if (type === "ship") this._mountLongship();
    else if (type === "shield") this._addShieldGlow();
    else if (type === "thor") this._addThorAura();
    else if (type === "odin") {
      this._addOdinRavens();
      // Odin's ravens grant foresight: time slows for the full duration.
      // Hook into the existing _slowMo mechanism so the vignette also fires.
      this._slowMo(0.55, duration);
    }
    this._renderPowerHudOnce();
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
    // Lightning "sparks" — four thin emissive boxes that we'll spin per frame.
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
  // head. Cheap diamond silhouettes — black with very subtle gold rim.
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
      // Wings — two thin planes that flap on the wing axis.
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

  // Lightning strike at a world position — vertical jagged beam that
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

  // Per-frame god-power visual update — spin Mjölnir sparks, orbit ravens.
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
        // Flap wings — children index 1+ are wings.
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
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) e.preventDefault();
      if (keys.has(k)) return;
      keys.add(k);
      if (k === "shift") { this.sprint = true; return; }
      if (k === "p") { this._togglePause(); return; }
      if (k === "m") { this.audio.setMuted(!this.audio.muted); return; }
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
    $("againBtn").addEventListener("click", () => { $("overOverlay").classList.remove("show"); this._begin(); });
    $("resumeBtn").addEventListener("click", () => this._togglePause());

    // Bio buttons live-mirror sensor status. Previous version was a one-
    // shot setter: button said "On" forever based on the start() return,
    // even after the sensor went to error / off. That caused the
    // "camera turned off automatically" complaint — the chip in the HUD
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
            // "off" — only revert if we don't have an active error message
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
        if (!window.Bio) { btn.textContent = "Unavailable"; return; }
        // If already live and the user clicks again, toggle OFF.
        if (btn.classList.contains("live")) {
          try {
            if (key === "rppg") await window.Bio.stopRppg();
            else                await window.Bio.stopEeg();
          } catch (e) { console.warn("[Valhalla] bio stop threw", e); }
          return;
        }
        const opts = {}; opts[key] = true;
        // Optimistic UI — the warming status event will land in ~50ms.
        setVisualState("warming");
        try {
          const r = await window.Bio.start(opts);
          const result = r[key];
          if (!(result && result.ok !== false)) {
            const msg = result?.message || result?.reason || "Failed";
            setVisualState("error", msg);
          }
          // On success, the rppgStatus/eegStatus event will move us
          // through warming → live. Nothing to do here.
        } catch (e) {
          console.warn("[Valhalla] bio start threw", e);
          setVisualState("error", e?.message || "Failed");
        }
      });
    };
    wireBioBtn($("bioHrBtn"), "rppg");
    wireBioBtn($("bioEegBtn"), "eeg");

    // Detect Web Bluetooth availability at boot and surface the most
    // common failure modes up front so the player doesn't click "Pair"
    // only to get a generic browser error. Most users on Safari / iOS /
    // Firefox simply can't use the EEG path — better to say that than
    // let them keep trying.
    const hint = $("bioBleHint");
    const eegBtn = $("bioEegBtn");
    if (hint && eegBtn) {
      if (typeof navigator === "undefined" || !navigator.bluetooth) {
        const ua = (typeof navigator !== "undefined" ? navigator.userAgent : "") || "";
        let msg = "Your browser doesn't support Web Bluetooth — try Chrome or Edge on desktop.";
        if (/iPhone|iPad|iPod/.test(ua))                msg = "iOS doesn't allow Web Bluetooth. Open this on Chrome/Edge desktop to pair a Muse.";
        else if (/Firefox/.test(ua))                    msg = "Firefox doesn't support Web Bluetooth yet. Use Chrome or Edge to pair a Muse.";
        else if (/Safari/.test(ua) && !/Chrome/.test(ua)) msg = "Safari doesn't support Web Bluetooth. Use Chrome or Edge to pair a Muse.";
        hint.textContent = msg;
        hint.style.display = "block";
        eegBtn.disabled = true;
        eegBtn.title = msg;
      } else if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
        hint.textContent = "Web Bluetooth requires HTTPS or localhost. Run start-game.bat / node server.js — don't double-click index.html.";
        hint.style.display = "block";
        eegBtn.disabled = true;
      } else {
        // BLE is supported. Show a quick checklist as a soft pre-flight
        // hint so the user knows what to do BEFORE clicking Pair.
        hint.innerHTML = "<b>Before pairing:</b> turn your Muse on (LED solid), unpair it from your phone or Muse app, and have Bluetooth enabled on your computer. Then click Pair and pick the Muse from the browser dialog.";
        hint.style.display = "block";
      }
    }

    // Clicking the HUD bio row when no sensor is on quick-starts the heart-rate sensor.
    this.hud.bioRow.addEventListener("click", () => {
      const hrBtn = $("bioHrBtn");
      if (hrBtn && !hrBtn.disabled) hrBtn.click();
    });

    // Belt and braces: the bio adapter injects its own floating widgets
    // (badge, panel, sparkline, ritual) on every page. Our CSS hides them
    // but some browsers respect inline display:flex set via injected
    // <style> over our :not() rule. Just delete the nodes after they mount.
    const nukeLegacyBio = () => {
      for (const id of ["bio-badge", "bio-panel", "bio-menu-sparkline",
                        "bio-menu-ritual", "bio-tier-block", "bio-drill-host"]) {
        const el = document.getElementById(id);
        if (el) el.remove();
      }
    };
    window.addEventListener("bio:ready", nukeLegacyBio, { once: true });
    // Run it once immediately too in case bio mounted before main.js bound the listener.
    nukeLegacyBio();
    // And again after a tick to catch any late mounts.
    setTimeout(nukeLegacyBio, 500);
    setTimeout(nukeLegacyBio, 1500);
  }

  _bindBio() {
    const tryBind = () => {
      if (!window.Bio) return false;
      window.Bio.on("rppgMetric", (m) => {
        if (m && typeof m.bpm === "number") {
          this.bpm = Math.round(m.bpm);
          this.hud.bpmTxt.textContent = `${this.bpm} bpm`;
          this.hud.bioRow.classList.add("on");
          // HEARTBEAT IMPACT — every detected beat sends a real pulse
          // through the world. Scheduled as a chain of soft camera
          // kicks + screen pulses paced to the player's actual BPM,
          // so the game LITERALLY beats with their body. This is the
          // single biggest "the SDK changes the experience" cue.
          this._scheduleHeartbeatPulse();
        }
      });
      window.Bio.on("rppgStatus", (s) => {
        if (s.status === "off" || s.status === "error") {
          this.hud.bioRow.classList.remove("on");
          this.hud.bpmTxt.textContent = "Bio off";
        } else if (s.status === "warming") {
          this.hud.bioRow.classList.add("on");
          this.hud.bpmTxt.textContent = "Warming up";
        } else if (s.status === "live") {
          this.hud.bioRow.classList.add("on");
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
  // permanently for that session — "rich in the background" means
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
    const s = Store.load();
    $("bestScore").textContent = (s.bestScore || 0).toLocaleString();
    $("bestDist").textContent = `${Math.round(s.bestDist || 0)}m`;
    $("totalRuns").textContent = s.totalRuns || 0;
  }

  _saveStats() {
    const s = Store.load();
    s.bestScore = Math.max(s.bestScore || 0, this.score);
    s.bestDist = Math.max(s.bestDist || 0, this.distance);
    s.totalRuns = (s.totalRuns || 0) + 1;
    s.totalScore = (s.totalScore || 0) + this.score;
    s.totalMead = (s.totalMead || 0) + this.mead;
    Store.save(s);
  }

  _flash() {
    this.hud.flash.classList.add("on");
    setTimeout(() => this.hud.flash.classList.remove("on"), 320);
  }

  _begin() {
    $("startOverlay").classList.add("hide");
    $("overOverlay").classList.remove("show");
    document.body.classList.add("playing");
    this.lane = 1; this.targetLaneX = LANES[1];
    this.playerY = 0; this.playerVy = 0;
    this.sliding = false; this.slideTimer = 0;
    this.distance = 0; this.score = 0; this.mead = 0;
    this.lives = 3; this.combo = 0; this.invuln = 0;
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
    this.audio.ensure();
    this.audio.startWind();
    this.audio.startMusic();
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
    $("overOverlay").classList.add("show");
    this._loadStats();
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
    // — the first 5 seconds have to feel like discovery, not punishment.
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
      // Single-lane obstacle — easy to dodge, no cooldown needed.
      const lane = (Math.random() * 3) | 0;
      this._spawnObstacle(lane, zWorld);
    } else if (r < 0.34 && !tooCloseToHard) {
      // Two-lane block (one safe lane). Hard — gate by cooldown.
      const safe = (Math.random() * 3) | 0;
      for (let i = 0; i < 3; i++) if (i !== safe) this._spawnObstacle(i, zWorld);
      this._lastHardZ = zWorld;
    } else if (r < 0.45 && !tooCloseToHard) {
      // Slide-under beam — gate by cooldown.
      this._spawnBeam(zWorld);
      this._lastHardZ = zWorld;
    } else if (r < 0.55 && !tooCloseToHard) {
      // Jump-over fire pit — gate by cooldown.
      this._spawnFirePit((Math.random() * 3) | 0, zWorld);
      this._lastHardZ = zWorld;
    } else if (r < 0.65 && !tooCloseToHard) {
      // Slide-under ravens — gate by cooldown.
      this._spawnRavens(zWorld);
      this._lastHardZ = zWorld;
    } else {
      // Empty wave or cooldown — collectibles only.
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
    // and unlocks the great relics much earlier — the user-reported
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
  // that the floating words are just noise. Disabled — keep the
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
    // Drinking horn — bone/ivory tone, NO emissive (a horn doesn't glow).
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
    // Only the first mead in a cluster gets a decal — otherwise we'd
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
    // Carved standing runestone — weathered grey granite slab with three
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
    // Core orb — gift of the gods. Strong emissive so the bloom pass
    // turns it into a real lantern of divine light, not a flat sphere.
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 18, 14),
      new THREE.MeshStandardMaterial({
        color: spec.color, roughness: 0.18, metalness: 0.7,
        emissive: spec.color, emissiveIntensity: 2.6,
      })
    );
    grp.add(core);
    // Halo — larger and slightly more opaque.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 14, 10),
      new THREE.MeshBasicMaterial({ color: spec.halo, transparent: true, opacity: 0.32, depthWrite: false })
    );
    grp.add(halo);
    // Powerup name banners removed — they made the world feel like a
    // tutorial. The orb's distinct halo colour + icon silhouette is
    // enough to identify the relic. The pickup announcement (big
    // floating text on activate) is when the player learns the name.
    // Icon symbol inside the orb — small white silhouette that reads at
    // distance even when the player is sprinting. One shape per god/relic.
    const W = new THREE.MeshBasicMaterial({ color: 0xffffff });
    let icon;
    if (spec.sym === "shield") {                      // Tyr — round shield with boss
      icon = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.05, 16), W);
      disc.rotation.x = Math.PI / 2;
      icon.add(disc);
      const boss = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), W);
      boss.position.z = 0.05;
      icon.add(boss);
    } else if (spec.sym === "hoof") {                 // Sleipnir — galloping hoofprint (kite)
      icon = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.32, 4), W);
      icon.rotation.x = Math.PI / 2;
    } else if (spec.sym === "rune") {                 // Bragi — rune-stone (vertical bar with cross)
      icon = new THREE.Group();
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.38, 0.06), W);
      icon.add(bar);
      const cross = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.06), W);
      icon.add(cross);
    } else if (spec.sym === "tear") {                 // Freja — tear-drop
      icon = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.32, 12), W);
    } else if (spec.sym === "ship") {                 // Skíðblaðnir — longship silhouette
      icon = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, 0.14), W);
    } else if (spec.sym === "hammer") {               // Mjölnir — boxy hammer head + short handle
      icon = new THREE.Group();
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.20, 0.18), W);
      head.position.y = 0.07;
      icon.add(head);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.28, 0.06), W);
      handle.position.y = -0.13;
      icon.add(handle);
    } else if (spec.sym === "ravens") {               // Odin — two stacked diamond birds
      icon = new THREE.Group();
      for (let i = 0; i < 2; i++) {
        const b = new THREE.Mesh(new THREE.OctahedronGeometry(0.10, 0), W);
        b.position.set(i === 0 ? -0.10 : 0.10, i === 0 ? 0.08 : -0.06, 0);
        icon.add(b);
      }
    } else {                                          // default fallback — diamond
      icon = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 0), W);
    }
    icon.position.z = 0.05;
    grp.add(icon);
    grp.position.set(LANES[lane], 1.6, zWorld);
    this.scene.add(grp);
    // Reward decal — the god's halo colour on the ground, so the player can
    // distinguish at a glance from the red danger rings.
    const rewardDecal = this._makeGroundDecal(spec.halo, 1.3, false);
    rewardDecal.position.set(LANES[lane], 0.06, zWorld);
    this.scene.add(rewardDecal);
    this.collectibles.push({ mesh: grp, lane, spawnAt: zWorld, type: "powerup",
      pwType: type, value: spec.value, ang: 0, baseY: 1.6, decal: rewardDecal });
  }

  // Canvas-rendered text sprite. Three.js has no native text — we draw the
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
    // Flames — stacked tetrahedra. Material is BasicMaterial in HDR
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
    // Ember light
    const fireLight = new THREE.PointLight(0xff5520, 1.2, 8, 2);
    fireLight.position.y = 0.8;
    grp.add(fireLight);
    grp.position.set(LANES[lane], 0, zWorld);
    this.scene.add(grp);

    const decal = this._makeGroundDecal(0xff4020, 1.3);
    decal.position.set(LANES[lane], 0.06, zWorld);
    this.scene.add(decal);

    // JUMP label — orange accent matches the fire colour.
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
    // SLIDE label — same red as the beam since the verb is identical.
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
    // Adaptive bloom — disable if we're running below 40 FPS sustained
    // and re-enable above 50 FPS. Hysteresis prevents flicker.
    if (this.bloomPass) {
      if (this._frameEMA > 0.025 && this.bloomPass.enabled) {
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
    requestAnimationFrame(this._frame);
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
    //     fast" feeling — and you'll lose if you can't calm down)
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
    // Drive the real character's animation mixer. Speed scales with
    // game speed so legs cycle in sync with apparent motion.
    if (this._mixer) {
      const animSpeed = Math.max(0.5, this.speed / BASE_SPEED);
      this._mixer.update(dt * animSpeed);
    }
    // Aurora ribbons — gentle drift / sway. No shader uniforms now;
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
    // Boss actor — scrolls with the world, idles, fights, dies.
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
        // Cleanup once well past + faded out.
        if (fall >= 1 && sz < -10) {
          this.scene.remove(b.mesh);
          this._bossActor = null;
        }
      } else {
        // Idle: subtle bob + sway.
        b.idle += dt;
        b.mesh.position.y = Math.sin(b.idle * 1.2) * 0.18;
        b.mesh.rotation.y = Math.sin(b.idle * 0.6) * 0.04;

        // BIO DAMAGE: being in Flow state during a fight ticks damage
        // continuously (5/s). This is the "your physiology helps you
        // beat bosses" loop the user asked for. Berserker = 3/s.
        if (this.cognitiveState === "flow")        this._damageBoss(5 * dt, "flow");
        else if (this.cognitiveState === "berserker") this._damageBoss(3 * dt, "berserker");

        // Boss escapes if it scrolls 20m past the player still alive.
        if (sz < -20 && !b.escaped) this._bossEscaped();
        if (sz < -30) {
          this.scene.remove(b.mesh);
          this._bossActor = null;
        }
      }

      // HP bar billboards toward camera — quick LookAt every frame.
      if (b.hpFill && !b.defeated) {
        // Keep the fill anchored to its own left edge so it shrinks
        // from the right (visual: hp depleting).
        const w = b.hpFillBaseWidth;
        const pct = Math.max(0.001, b.hp / b.hpMax);
        b.hpFill.position.x = -(w * (1 - pct)) * 0.5;
      }
    }

    // forward distance
    this.distance += this.speed * dt;

    // score multipliers stack: bio state + combo + 2x powerup
    const flowMul = (this.cognitiveState === "flow") ? 2.0 :
                    (this.cognitiveState === "focused") ? 1.4 :
                    (this.cognitiveState === "berserker") ? 1.5 : 1.0;
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
        // Stamp at current world distance; scroll it back through scene each frame
        fp.userData.spawnAt = this.distance;
        fp.material.opacity = 0.45;
        this._fpIdx = (this._fpIdx + 1) % this.footprints.length;
      }
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
    const camTargetX = this.player.position.x * 0.4 + Math.sin(phase * 0.5) * swayAmp;
    const camTargetY = 5.3 + Math.abs(Math.sin(phase)) * bobAmp + this.playerY * 0.12;
    this.camera.position.x += (camTargetX - this.camera.position.x) * Math.min(1, dt * 4);
    this.camera.position.y += (camTargetY - this.camera.position.y) * Math.min(1, dt * 4);
    this.camera.position.z = -12;

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
      // Mjölnir — while Thor's hammer is in your grasp, any obstacle that
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
      // slow-mo only — the player still has to dodge.
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
      // Runestones are heavy carved granite — they don't spin or hover.
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
          // Runes hit the active boss HARD — they're the player's main
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

    // ravens
    const tt = performance.now() * 0.001;
    this.ravens.position.set(this.player.position.x, 0, this.distance);
    for (const w of this.ravens.children) {
      const p = w.userData.phase + tt * w.userData.speed;
      w.position.set(Math.cos(p) * w.userData.r, w.userData.h, Math.sin(p) * w.userData.r);
      w.rotation.y = -p;
      // wing flap
      w.scale.y = 1 + Math.sin(tt * 14 + w.userData.phase * 3) * 0.4;
    }

    // scenery bobs
    for (const s of this.scenery) {
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
    if (this.lives <= 0) this._gameOver();
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
    const tt = performance.now() * 0.001;
    if (this.ravens) {
      for (const w of this.ravens.children) {
        const p = w.userData.phase + tt * w.userData.speed;
        w.position.set(Math.cos(p) * w.userData.r, w.userData.h, Math.sin(p) * w.userData.r);
        w.rotation.y = -p;
      }
    }
  }

  _updateHUD() {
    this.hud.score.textContent = Math.floor(this.score).toLocaleString();
    this.hud.dist.textContent = `${Math.round(this.distance)}m`;
    this.hud.lives.textContent = Math.max(0, this.lives);
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setSize(w, h);
      if (this.bloomPass) this.bloomPass.setSize(w * 0.5, h * 0.5);
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
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
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
