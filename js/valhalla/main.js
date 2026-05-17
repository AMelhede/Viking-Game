// 3D viking runner. Three lanes, jump+slide. Reads window.Bio if present.

import * as THREE from "three";
import { Water } from "three/addons/objects/Water.js";

// Lane 0 = visually leftmost on screen. Because the camera looks toward +Z
// with default up = +Y, the camera's right vector is -X, so world +X appears
// on the LEFT side of the screen. Lane 0 must therefore be at world x=+3.4.
const LANES = [3.4, 0, -3.4];
const GROUND_WIDTH = 60;
const CHUNK_LENGTH = 60;
const CHUNK_COUNT = 6;
const VIEW_DEPTH = CHUNK_LENGTH * CHUNK_COUNT;
const JUMP_VELOCITY = 12;
const GRAVITY = 30;
const SLIDE_DURATION = 0.32;
const BASE_SPEED = 22;
const MAX_SPEED = 60;

// Norse cosmology biome cycle. Distance ranges are absolute metres from
// run start; after the last range the cycle wraps so the run never ends.
// `fog`+`sky` colours drive the per-frame palette ease. `pitch` is a
// semitone offset for the music loop so each realm has its own modal
// flavour without rewriting the melody. `boss` names the entrance
// encounter that fires at the start of each biome (after Midgard).
const BIOMES = [
  { name: "Midgard",    length: 500, fog: 0xc4d2dc,
    sky: [0x9cb6cc, 0xc2d2dd, 0xdee7ec, 0xc4d2dc], pitch: 0,
    boss: null },
  { name: "Jötunheim",  length: 500, fog: 0x9ab8d0,
    sky: [0x6a8aaa, 0x9ab8d0, 0xc8dceb, 0x9ab8d0], pitch: -2,
    boss: "jotunn" },
  { name: "Muspelheim", length: 500, fog: 0xc06840,
    sky: [0x602010, 0xb04020, 0xe88040, 0xc06840], pitch: 1,
    boss: "surtr" },
  { name: "Asgard",     length: 500, fog: 0xe8c878,
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

      // Cheap stone-hall reverb: 4 delay taps fed back through one delay,
      // then lowpassed for warmth. Sounds like a longhall without needing
      // an impulse-response file.
      const wet = this.ctx.createGain();
      wet.gain.value = 0.32;
      const sum = this.ctx.createGain(); sum.gain.value = 1;
      const taps = [
        { time: 0.053, gain: 0.55 },
        { time: 0.117, gain: 0.38 },
        { time: 0.231, gain: 0.26 },
        { time: 0.453, gain: 0.16 },
      ];
      for (const t of taps) {
        const d = this.ctx.createDelay(0.6);
        d.delayTime.value = t.time;
        const g = this.ctx.createGain(); g.gain.value = t.gain;
        wet.connect(d); d.connect(g); g.connect(sum);
      }
      const feedback = this.ctx.createDelay(0.6);
      feedback.delayTime.value = 0.31;
      const fbGain = this.ctx.createGain();
      fbGain.gain.value = 0.40;
      sum.connect(feedback); feedback.connect(fbGain); fbGain.connect(sum);
      const wetLP = this.ctx.createBiquadFilter();
      wetLP.type = "lowpass"; wetLP.frequency.value = 2200;
      sum.connect(wetLP); wetLP.connect(this.master);
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
  // Lur horn: long, brass-like, used historically by Vikings to signal
  // across fjords. Three detuned saws through a lowpass that opens on
  // attack (~70ms) and closes through sustain, with 5.2 Hz vibrato.
  _lur(when, freq, dur, vol = 0.16) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(180, when);
    lp.frequency.linearRampToValueAtTime(1800, when + 0.07);
    lp.frequency.linearRampToValueAtTime(900, when + Math.max(0.2, dur * 0.8));
    lp.Q.value = 0.7;
    const oscs = [];
    for (const det of [-9, 0, 8]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = freq;
      o.detune.value = det;
      o.connect(lp);
      oscs.push(o);
    }
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibG = ctx.createGain();
    vibG.gain.value = 6;
    vib.connect(vibG);
    for (const o of oscs) vibG.connect(o.detune);
    lp.connect(out);
    this._send(out, 0.45);
    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(vol, when + 0.08);
    out.gain.linearRampToValueAtTime(vol * 0.82, when + Math.max(0.12, dur * 0.7));
    out.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    for (const o of oscs) { o.start(when); o.stop(when + dur + 0.05); }
    vib.start(when); vib.stop(when + dur + 0.05);
  }

  // Tagelharpa: bowed lyre with woody resonance. Two detuned saws through
  // a bandpass at ~2.4× freq, plus quiet high-passed pink noise to model
  // horsehair-on-string friction.
  _tagelharpa(when, freq, dur, vol = 0.12) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = Math.max(450, freq * 2.4);
    bp.Q.value = 2.4;
    for (const det of [-4, 4]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = freq;
      o.detune.value = det;
      o.connect(bp);
      o.start(when); o.stop(when + dur + 0.05);
    }
    const noise = this._noiseSrc(true);
    const nhp = ctx.createBiquadFilter();
    nhp.type = "highpass"; nhp.frequency.value = 2400;
    const ng = ctx.createGain();
    ng.gain.value = vol * 0.08;
    noise.connect(nhp); nhp.connect(ng); ng.connect(out);
    noise.start(when); noise.stop(when + dur + 0.05);

    bp.connect(out);
    this._send(out, 0.55);
    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(vol, when + 0.05);
    out.gain.linearRampToValueAtTime(vol * 0.7, when + dur * 0.7);
    out.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  }

  // Frame drum: sine kick (90→32 Hz) for body + filtered noise burst for
  // the skin slap. Heavy reverb send for that hall thud.
  _drum(when, vol = 0.4) {
    const ctx = this.ctx;
    const k = ctx.createOscillator();
    const kg = ctx.createGain();
    k.type = "sine";
    k.frequency.setValueAtTime(95, when);
    k.frequency.exponentialRampToValueAtTime(32, when + 0.18);
    kg.gain.setValueAtTime(0.0001, when);
    kg.gain.exponentialRampToValueAtTime(vol, when + 0.005);
    kg.gain.exponentialRampToValueAtTime(0.0001, when + 0.32);
    k.connect(kg);
    this._send(kg, 0.4);
    k.start(when); k.stop(when + 0.4);
    const n = this._noiseSrc(false);
    const nbp = ctx.createBiquadFilter();
    nbp.type = "bandpass"; nbp.frequency.value = 900; nbp.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, when);
    ng.gain.exponentialRampToValueAtTime(vol * 0.45, when + 0.003);
    ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.08);
    n.connect(nbp); nbp.connect(ng);
    this._send(ng, 0.5);
    n.start(when); n.stop(when + 0.12);
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

  // Distant raven calls and ocean wash on a loose interval (8–24s).
  _scheduleAmbient() {
    const tick = () => {
      if (!this.ctx) return;
      if (!this.muted) {
        const when = this.ctx.currentTime + 0.05;
        if (Math.random() < 0.55) this._raven(when, 0.05);
        else this._wave(when);
      }
      this.ambientTimer = setTimeout(tick, 8000 + Math.random() * 16000);
    };
    this.ambientTimer = setTimeout(tick, 6000 + Math.random() * 6000);
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
    // Just-intonation-ish ratios for the Phrygian degrees.
    const SCALE = { D:1, Eb:1.0667, F:1.1852, G:1.3333, A:1.5, Bb:1.6, C:1.7778 };
    const BEAT = 0.60;
    const BAR  = BEAT * 4;
    const LOOP = BAR * 4;

    // Drum on every beat, with off-beat ghost hits — frame-drum dum-tek.
    const DRUM = [0, 1.5, 2, 3.5, 4, 5.5, 6, 7.5, 8, 9.5, 10, 11.5, 12, 13.5, 14, 15.5];
    const MELODY = [
      [0,   "F",  1.5],
      [2,   "G",  1.5],
      [4,   "A",  2.0],
      [6,   "G",  1.5],
      [8,   "F",  1.0],
      [9,   "Eb", 1.0],
      [10,  "D",  2.5],
      [13,  "F",  1.5],
      [14.5,"D",  1.5],
    ];
    const playLoop = () => {
      if (!this.musicTimer) return;
      const t0 = this.ctx.currentTime + 0.05;
      // Ease the music pitch one step per loop toward the biome target.
      const diff = this._musicPitchTarget - this._musicPitch;
      if (Math.abs(diff) > 0.01) this._musicPitch += Math.sign(diff) * Math.min(Math.abs(diff), 1);
      const pitchMul = Math.pow(2, this._musicPitch / 12);
      const root = ROOT * pitchMul;
      // Long lur drone holding the (transposed) root for the whole loop.
      this._lur(t0, root, LOOP, 0.09);
      // Tagelharpa melody, octave up.
      for (const [b, deg, dur] of MELODY) {
        this._tagelharpa(t0 + b * BEAT, root * 2 * SCALE[deg], dur * BEAT, 0.11);
      }
      // Frame drum.
      for (const b of DRUM) {
        const accent = (b % 4 === 0);
        this._drum(t0 + b * BEAT, accent ? 0.48 : 0.30);
      }
      // Chant enters every other loop on the root, vowel-shifting.
      if ((this._beat % 2) === 1) {
        this._chant(t0 + 4 * BEAT, root * 2, 8 * BEAT, 0.075, this._beat % 4 === 1 ? "o" : "a");
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
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    // Fog color matches the sky horizon so distant geometry blends in.
    const fogColor = new THREE.Color(0xc4d2dc);
    this.scene.fog = new THREE.Fog(fogColor, 60, 520);
    this.scene.background = fogColor.clone();

    this.camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.1, 1200);
    this.camera.position.set(0, 4.0, -11.5);
    this.camera.lookAt(0, 2.0, 22);
  }

  _buildSky() {
    // 4-stop vertical gradient sphere. Cheaper than the physical Sky shader
    // and easier to keep readable at our exposure.
    const skyGeo = new THREE.SphereGeometry(1000, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        topColor:    { value: new THREE.Color(0x9cb6cc) },
        midColor:    { value: new THREE.Color(0xc2d2dd) },
        horizColor:  { value: new THREE.Color(0xdee7ec) },
        groundColor: { value: new THREE.Color(0xc4d2dc) },  // matches fog
        offset:      { value: 0.0 },
        exponent:    { value: 0.55 },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 horizColor;
        uniform vec3 groundColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPos;
        void main() {
          float h = normalize(vWorldPos + vec3(0.0, offset, 0.0)).y;
          vec3 col;
          if (h >= 0.0) {
            float t1 = pow(clamp(h, 0.0, 1.0), exponent);
            // horiz -> mid -> top
            vec3 lower = mix(horizColor, midColor, smoothstep(0.0, 0.45, t1));
            col = mix(lower, topColor, smoothstep(0.45, 1.0, t1));
          } else {
            col = mix(horizColor, groundColor, smoothstep(0.0, 0.2, -h));
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(this.sky);

    // Keep the sun position vector for the directional light + sun disc.
    // Place sun moderately high on the right.
    const phi = THREE.MathUtils.degToRad(58);
    const theta = THREE.MathUtils.degToRad(120);
    this.sunPos = new THREE.Vector3();
    this.sunPos.setFromSphericalCoords(1, phi, theta);

    // Skip the rest of the old Sky-shader setup
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
    // Hemi + sun balanced for exposure = 1.0 (gradient-sky build).
    // Hemi is the dominant fill so snow reads bright; sun adds raking warmth.
    const hemi = new THREE.HemisphereLight(0xe8eff5, 0x32404e, 1.1);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff0d2, 2.0);
    sun.position.set(60, 55, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 220;
    sun.shadow.camera.left = -40;
    sun.shadow.camera.right = 40;
    sun.shadow.camera.top = 50;
    sun.shadow.camera.bottom = -30;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);

    // Cool blue rim from the "north" - makes silhouettes pop against the fog
    const rim = new THREE.DirectionalLight(0x8aa8c8, 0.55);
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

    // Procedural noise texture for the snow surface. Repeated across the
    // plane, this gives the ground actual visual detail under the sun
    // without needing an asset download. Tiles seamlessly.
    const tex = this._makeSnowTexture();
    const snowMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.88, metalness: 0.0,
      flatShading: false,
      map: tex,
      bumpMap: tex,
      bumpScale: 0.18,
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
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.22, 1.4, 5);
    trunkGeo.translate(0, 0.7, 0);
    const lowGeo = new THREE.ConeGeometry(1.3, 1.5, 6);
    lowGeo.translate(0, 1.4 + 0.45, 0);
    const midGeo = new THREE.ConeGeometry(1.0, 1.5, 6);
    midGeo.translate(0, 1.4 + 0.85 + 0.45, 0);
    const topGeo = new THREE.ConeGeometry(0.7, 1.5, 6);
    topGeo.translate(0, 1.4 + 1.7 + 0.45, 0);
    const capGeo = new THREE.ConeGeometry(0.4, 0.5, 6);
    capGeo.translate(0, 1.4 + 3.0, 0);

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x32200f, roughness: 0.95, flatShading: true });
    const lowMat = new THREE.MeshStandardMaterial({ color: 0x1a3221, roughness: 0.92, flatShading: true });
    const midMat = new THREE.MeshStandardMaterial({ color: 0x244430, roughness: 0.9, flatShading: true });
    const topMat = new THREE.MeshStandardMaterial({ color: 0x2c5440, roughness: 0.88, flatShading: true });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xf3f6f8, roughness: 0.4, flatShading: true });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, TREE_COUNT);
    const lows = new THREE.InstancedMesh(lowGeo, lowMat, TREE_COUNT);
    const mids = new THREE.InstancedMesh(midGeo, midMat, TREE_COUNT);
    const tops = new THREE.InstancedMesh(topGeo, topMat, TREE_COUNT);
    const caps = new THREE.InstancedMesh(capGeo, capMat, TREE_COUNT);
    for (const m of [trunks, lows, mids, tops, caps]) {
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    }

    for (let i = 0; i < TREE_COUNT; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      // Two bands: close-forest (8-24) and far-forest (24-55). Far band gets
      // smaller and more drift, so it reads as receding into haze.
      const farBand = Math.random() < 0.55;
      const x = side * (farBand ? 24 + Math.random() * 31 : 8 + Math.random() * 16);
      const z = zStart + Math.random() * CHUNK_LENGTH;
      const scale = (farBand ? 1.1 : 0.85) + Math.random() * 0.9;
      const y = groundHeight(x, z) - 0.1;
      tmp.position.set(x, y, z);
      tmp.rotation.set(0, Math.random() * Math.PI * 2, 0);
      tmp.scale.setScalar(scale);
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

    // Rocks - also instanced.
    const ROCK_COUNT = 22;
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x676d75, roughness: 0.96, flatShading: true });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, ROCK_COUNT);
    rocks.castShadow = true; rocks.receiveShadow = true; rocks.frustumCulled = false;
    for (let i = 0; i < ROCK_COUNT; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * (6.5 + Math.random() * 26);
      const z = zStart + Math.random() * CHUNK_LENGTH;
      const r = 0.5 + Math.random() * 1.6;
      tmp.position.set(x, groundHeight(x, z) + r * 0.25, z);
      tmp.rotation.set(Math.random(), Math.random(), Math.random());
      tmp.scale.setScalar(r);
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

    // Cloak / body
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 1.0, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x6e3220, roughness: 0.85, flatShading: true })
    );
    body.position.y = 1.0;
    body.castShadow = true;
    grp.add(body);

    // Tunic detail
    const tunic = new THREE.Mesh(
      new THREE.BoxGeometry(0.84, 0.55, 0.58),
      new THREE.MeshStandardMaterial({ color: 0x3d2a1a, roughness: 0.9, flatShading: true })
    );
    tunic.position.y = 0.7;
    tunic.castShadow = true;
    grp.add(tunic);

    // Belt
    const belt = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 0.12, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 0.6 })
    );
    belt.position.y = 0.95;
    grp.add(belt);

    // Head
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.55, 0.55),
      new THREE.MeshStandardMaterial({ color: 0xd9b78a, roughness: 0.8, flatShading: true })
    );
    head.position.y = 1.78;
    head.castShadow = true;
    grp.add(head);

    // Beard (red)
    const beard = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.32, 0.25),
      new THREE.MeshStandardMaterial({ color: 0x9c4a1d, roughness: 0.95, flatShading: true })
    );
    beard.position.set(0, 1.55, 0.18);
    grp.add(beard);

    // Helmet (iron grey + horns)
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.36, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.4, metalness: 0.6, flatShading: true })
    );
    helmet.position.y = 2.02;
    helmet.castShadow = true;
    grp.add(helmet);
    const noseGuard = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.32, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x5a5d62, metalness: 0.6, roughness: 0.4 })
    );
    noseGuard.position.set(0, 1.82, 0.28);
    grp.add(noseGuard);
    // horns
    for (const dir of [-1, 1]) {
      const horn = new THREE.Mesh(
        new THREE.ConeGeometry(0.09, 0.55, 6),
        new THREE.MeshStandardMaterial({ color: 0xe8e1c8, roughness: 0.6, flatShading: true })
      );
      horn.position.set(dir * 0.32, 2.16, 0);
      horn.rotation.z = dir * -0.7;
      horn.rotation.x = -0.2;
      grp.add(horn);
    }

    // Arms
    const armMat = new THREE.MeshStandardMaterial({ color: 0x6e3220, roughness: 0.9, flatShading: true });
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.78, 0.22), armMat);
    armL.position.set(-0.5, 1.05, 0);
    armL.castShadow = true;
    grp.add(armL);
    const armR = armL.clone();
    armR.position.x = 0.5;
    grp.add(armR);

    // Legs
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.95, flatShading: true });
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.7, 0.28), legMat);
    legL.position.set(-0.18, 0.35, 0);
    legL.castShadow = true;
    grp.add(legL);
    const legR = legL.clone();
    legR.position.x = 0.18;
    grp.add(legR);

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

    // shield on back
    const shield = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.45, 0.06, 16),
      new THREE.MeshStandardMaterial({ color: 0x9c2a26, roughness: 0.7 })
    );
    shield.rotation.x = Math.PI / 2;
    shield.position.set(0, 1.05, -0.32);
    grp.add(shield);
    const shieldRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.04, 6, 24),
      new THREE.MeshStandardMaterial({ color: 0x2a2018, metalness: 0.7, roughness: 0.5 })
    );
    shieldRim.rotation.x = Math.PI / 2;
    shieldRim.position.set(0, 1.05, -0.32);
    grp.add(shieldRim);
    const shieldBoss = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xd0bb70, metalness: 0.8, roughness: 0.3 })
    );
    shieldBoss.position.set(0, 1.05, -0.36);
    grp.add(shieldBoss);

    // Save references for animation
    this.player = grp;
    this.playerParts = { armL, armR, legL, legR, head, helmet, body };
    this.scene.add(grp);

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

  _buildSnow() {
    // Two layers of snow particles:
    // 1. CLOSE flakes - small count, big, very visible, RIGHT in front of
    //    the camera. This is what sells "weather". Without these the world
    //    feels static.
    // 2. FAR flakes - many small, drifting in middle distance for depth.

    // Close layer (~camera-relative volume in front of player).
    // Reduced 350→200 — the close flakes were the biggest GC source
    // because their positions are touched every frame in _driftSnow.
    {
      const count = 200;
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

    // Far layer (volumetric drift). Reduced 1800→900 — far flakes are
    // small enough that the eye doesn't notice the halving, but it cuts
    // _driftSnow's per-frame loop in half.
    {
      const count = 900;
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
    if (this.sky && this.sky.material && this.sky.material.uniforms) {
      const u = this.sky.material.uniforms;
      const keys = ["topColor", "midColor", "horizColor", "groundColor"];
      for (let i = 0; i < 4; i++) {
        u[keys[i]].value.lerp(this._biomeSkyTargets[i], Math.min(1, dt * 0.6));
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
    // Re-pitch the music loop to the biome's modal centre.
    if (this.audio && typeof this.audio.setBiomePitch === "function") {
      this.audio.setBiomePitch(b.pitch);
    }
    this._showBiomeBanner(b.name);
    // Score reward for crossing — scales with cycle count.
    const reward = 300 + this.biomeCycle * 200;
    this.score += reward;
    this._popText(`+${reward}`, "gold", 0, -50);
    // Spawn the entrance encounter — a giant boss mesh that scrolls past
    // and a curated obstacle pattern. Skips Midgard (the spawn realm).
    if (b.boss) this._spawnBoss(b.boss);
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
    const ahead = this.distance + 70;
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
    // Track so we can scroll it with the world + remove after passing.
    this._bossActor = { mesh: grp, spawnAt: ahead, type };
    // Curated obstacle pattern for the encounter — 4 hazards, well-spaced.
    const patternZ = ahead - 20;
    if (type === "jotunn") {
      // Three boulder forces — lane pressure
      this._spawnObstacle(0, patternZ);
      this._spawnObstacle(2, patternZ + 14);
      this._spawnObstacle(1, patternZ + 28);
    } else if (type === "surtr") {
      // Two beams + one fire pit — slide-jump rhythm
      this._spawnBeam(patternZ);
      this._spawnFirePit(1, patternZ + 16);
      this._spawnBeam(patternZ + 30);
    } else if (type === "valkyrie") {
      // Loot run — runes only, no hazards
      for (let i = 0; i < 4; i++) {
        this._spawnRune(i % 3, patternZ + i * 8);
      }
    }
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

    const wireBioBtn = (btn, key) => {
      if (!btn) return;
      // Cache the original button text for "reset on failure" UX.
      const originalText = btn.textContent;
      btn.addEventListener("click", async () => {
        if (!window.Bio) { btn.textContent = "Unavailable"; return; }
        const opts = {}; opts[key] = true;
        btn.textContent = key === "eeg" ? "Pairing…" : "Requesting…";
        btn.disabled = true;
        btn.classList.remove("error", "live");
        try {
          const r = await window.Bio.start(opts);
          const result = r[key];
          if (result && result.ok !== false) {
            btn.textContent = "On";
            btn.classList.add("live");
          } else {
            // Surface the human message from the sensor wrapper so the
            // user knows what to fix (timeout, no device, blocked perm).
            // Fallback to "Failed" if no message was provided.
            const msg = result?.message || result?.reason || "Failed";
            btn.textContent = msg.length > 32 ? msg.slice(0, 30) + "…" : msg;
            btn.title = msg;
            btn.classList.add("error");
            btn.disabled = false;
            // Reset the label back to "Enable" after a few seconds so the
            // button remains usable for retry.
            setTimeout(() => {
              if (btn.classList.contains("error")) {
                btn.textContent = originalText;
                btn.classList.remove("error");
              }
            }, 5000);
          }
        } catch (e) {
          // Final fallback — wrapper should normally catch its own errors,
          // but if anything thrown bubbles up we still want a usable button.
          const msg = e?.message || "Failed";
          console.warn("[Valhalla] bio start threw", e);
          btn.textContent = msg.length > 32 ? msg.slice(0, 30) + "…" : msg;
          btn.title = msg;
          btn.classList.add("error");
          btn.disabled = false;
          setTimeout(() => {
            if (btn.classList.contains("error")) {
              btn.textContent = originalText;
              btn.classList.remove("error");
            }
          }, 5000);
        }
      });
    };
    wireBioBtn($("bioHrBtn"), "rppg");
    wireBioBtn($("bioEegBtn"), "eeg");

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
    this.audio.ensure();
    this.audio.startWind();
    this.audio.startMusic();
  }

  _gameOver() {
    if (this.over) return;
    this.over = true; this.running = false;
    this.audio.stopMusic();
    this.audio.death();
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
    // Pattern-safety rules. Some hazards are unavoidable if you can't
    // react in time to the previous one:
    //   - beam / ravens need a slide
    //   - fire pit needs a jump
    //   - 2-lane block needs a lane change
    // Track the z of the last "must-act" hazard and refuse to spawn another
    // within 14m so the player always has time to reset their stance.
    this._lastHardZ = this._lastHardZ || -999;
    const tooCloseToHard = (zWorld - this._lastHardZ) < 14;

    const r = Math.random();
    if (r < 0.20) {
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

    // God-blessing orbs. Pools grow as the player travels further into
    // Valhalla — early stretch only grants the lighter blessings so the
    // run still has stakes; the great relics (Mjölnir, Skíðblaðnir,
    // Huginn & Muninn) appear once you've proven yourself.
    if (Math.random() < 0.08) {
      let pool;
      if (this.distance < 80) pool = ["speed", "mult", "magnet"];
      else if (this.distance < 220) pool = ["shield", "speed", "mult", "magnet", "ship"];
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
    this.obstacles.push({ mesh, lane, spawnAt: zWorld, type, w, h, slidable: false, decal });
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
    this.obstacles.push({
      mesh: grp, lane: -1, spawnAt: zWorld, type: "beam",
      w: 999, h: 0.55, slidable: true, yMin: 1.6, decal: decals,
    });
  }

  _spawnMead(lane, zWorld, baseY = 1.2, leadDecal = false) {
    const grp = new THREE.Group();
    const horn = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.8, 8),
      new THREE.MeshStandardMaterial({ color: 0xd9a04a, roughness: 0.4, metalness: 0.5, emissive: 0x553014, emissiveIntensity: 0.4 })
    );
    horn.rotation.z = Math.PI;
    grp.add(horn);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.04, 6, 14),
      new THREE.MeshStandardMaterial({ color: 0xf0c878, metalness: 0.8, roughness: 0.3 })
    );
    rim.position.y = 0.4;
    grp.add(rim);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd066, transparent: true, opacity: 0.18, depthWrite: false })
    );
    grp.add(glow);
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
    const mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.55, 0),
      new THREE.MeshStandardMaterial({
        color: 0x9adfff, roughness: 0.2, metalness: 0.3,
        emissive: 0x1c8db8, emissiveIntensity: 1.2,
      })
    );
    mesh.position.set(LANES[lane], 1.6, zWorld);
    this.scene.add(mesh);
    // Cyan reward ring so runes are obviously not-a-threat from afar.
    const decal = this._makeGroundDecal(0x60d0ff, 1.0, false);
    decal.position.set(LANES[lane], 0.06, zWorld);
    this.scene.add(decal);
    this.collectibles.push({ mesh, lane, spawnAt: zWorld, type: "rune", ang: 0, value: 100, baseY: 1.6, decal });
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
    // Core orb — larger and brighter than before. These are gifts of the
    // gods; they should be unmissable.
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 16, 12),
      new THREE.MeshStandardMaterial({
        color: spec.color, roughness: 0.25, metalness: 0.6,
        emissive: spec.color, emissiveIntensity: 1.3,
      })
    );
    grp.add(core);
    // Halo — larger and slightly more opaque.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 14, 10),
      new THREE.MeshBasicMaterial({ color: spec.halo, transparent: true, opacity: 0.32, depthWrite: false })
    );
    grp.add(halo);
    // Floating name banner — Canvas sprite. Names the relic so the player
    // can decide whether to grab it or not. Always faces the camera.
    const banner = this._makeTextSprite(spec.label, spec.halo);
    banner.position.y = 1.3;
    banner.scale.set(2.4, 0.6, 1);
    grp.add(banner);
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
    // Flames: stacked tetrahedra with orange/red colors and emissive glow
    const flames = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const h = 0.7 + i * 0.18;
      const r = 0.5 - i * 0.08;
      const flame = new THREE.Mesh(
        new THREE.TetrahedronGeometry(r, 0),
        new THREE.MeshBasicMaterial({
          color: i < 2 ? 0xff4810 : i < 4 ? 0xffa030 : 0xffe070,
          transparent: true, opacity: 0.85, fog: true,
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

    this.obstacles.push({
      mesh: grp, lane, spawnAt: zWorld, type: "fire",
      w: 1.9, h: 0.6, slidable: false, decal,
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
    this.obstacles.push({
      mesh: grp, lane: -1, spawnAt: zWorld, type: "ravens",
      w: 999, h: 0.55, slidable: true, yMin: 1.5, decal: decals,
    });
  }

  // ---------- Frame ----------
  _frame(now) {
    const realDt = Math.min(0.05, (now - this._lastT) / 1000);
    this._lastT = now;
    // Ease toward the active time scale (1 normally, 0.35 during rune slow-mo).
    this._timeScale += (this._timeScaleTarget - this._timeScale) * Math.min(1, realDt * 8);
    const dt = realDt * this._timeScale;
    if (!this.paused) this._update(dt);
    // Half-rate render when not playing (menu, game-over). The scene still
    // exists and snow still drifts, but we draw at ~30 FPS instead of 60
    // because nothing is fast-moving and the player isn't reacting to
    // anything. Halves GPU load on the title screen — the biggest source
    // of "lag on the menu" complaints.
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

    // speed ramp; bio nudges
    let target = BASE_SPEED + Math.min(this.distance * 0.012, MAX_SPEED - BASE_SPEED);
    if (this.sprint) target *= 1.18;
    if (this.cognitiveState === "berserker") target *= 1.12;
    else if (this.cognitiveState === "meditation") target *= 0.9;
    // Powerup-driven speed multipliers
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
    // Boss mesh scrolls with the world; remove once well behind the player.
    if (this._bossActor) {
      const sz = this._bossActor.spawnAt - this.distance;
      this._bossActor.mesh.position.z = sz;
      // Subtle idle motion so they feel alive
      this._bossActor.mesh.position.y = Math.sin(performance.now() * 0.0015) * 0.2;
      if (sz < -25) {
        this.scene.remove(this._bossActor.mesh);
        this._bossActor = null;
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

    // camera follow with subtle sway
    // Running cam bob: bigger amplitude tied to speed. Sells motion.
    const bobAmp = 0.08 + Math.min(0.18, (this.speed - BASE_SPEED) * 0.005);
    const camTargetX = this.player.position.x * 0.4 + Math.sin(t * 0.3) * 0.18;
    const camTargetY = 4.0 + Math.sin(t * 1.6) * bobAmp + this.playerY * 0.15;
    this.camera.position.x += (camTargetX - this.camera.position.x) * Math.min(1, dt * 4);
    this.camera.position.y += (camTargetY - this.camera.position.y) * Math.min(1, dt * 4);
    this.camera.position.z = -11.5;

    // Trauma-based camera shake (decays, applied as offset)
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
    this.camera.lookAt(this.player.position.x * 0.6 + shakeX * 0.5, 1.7 + this.playerY * 0.4 + shakeY * 0.5, 22);

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
      c.mesh.rotation.y = c.ang;
      const baseY = c.baseY != null ? c.baseY : (c.type === "rune" ? 1.6 : 1.2);
      c.mesh.position.y = baseY + Math.sin(c.ang * 1.3) * 0.12;
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
  }

  _renderOnce() { this.renderer.render(this.scene, this.camera); }
  _render() { this.renderer.render(this.scene, this.camera); }
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
