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

// ---------------- Audio ----------------
class Audio {
  constructor() {
    this.muted = localStorage.getItem("valhalla.muted") === "true";
    this.ctx = null;
    this.master = null;
    this.windNode = null;
    this.musicLoop = null;
    this._beat = 0;
  }
  ensure() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
    } catch (e) { console.warn("[Valhalla] audio init failed", e); }
  }
  setMuted(m) {
    this.muted = m;
    localStorage.setItem("valhalla.muted", String(m));
    if (this.master) this.master.gain.linearRampToValueAtTime(m ? 0 : 0.5, this.ctx.currentTime + 0.2);
  }
  startWind() {
    this.ensure();
    if (!this.ctx || this.windNode) return;
    const bufSize = 2 * this.ctx.sampleRate;
    const noise = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const out = noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bufSize; i++) {
      const w = Math.random() * 2 - 1;
      // pink-ish noise for wind
      last = 0.985 * last + 0.015 * w;
      out[i] = last * 3.5;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 380;
    filter.Q.value = 0.6;
    const g = this.ctx.createGain();
    g.gain.value = 0.18;
    src.connect(filter); filter.connect(g); g.connect(this.master);
    src.start();
    this.windNode = { src, filter, g };
    // gentle LFO on filter cutoff for breathing wind
    setInterval(() => {
      if (!this.windNode) return;
      const t = this.ctx.currentTime;
      const target = 280 + Math.random() * 220;
      this.windNode.filter.frequency.linearRampToValueAtTime(target, t + 1.4);
    }, 1400);
  }
  startMusic() {
    this.ensure();
    if (!this.ctx || this.musicLoop) return;
    // simple Norse drone: low Aeolian motif
    const notes = [110, 110, 130.81, 146.83, 130.81, 110, 98, 110]; // A2 A2 C3 D3 C3 A2 G2 A2
    const beatMs = 720;
    const playBeat = () => {
      if (!this.musicLoop) return;
      const t = this.ctx.currentTime;
      const f = notes[this._beat % notes.length];
      // drum
      const drumOsc = this.ctx.createOscillator();
      const drumG = this.ctx.createGain();
      drumOsc.type = "sine";
      drumOsc.frequency.setValueAtTime(80, t);
      drumOsc.frequency.exponentialRampToValueAtTime(35, t + 0.18);
      drumG.gain.setValueAtTime(0.0001, t);
      drumG.gain.exponentialRampToValueAtTime(0.45, t + 0.005);
      drumG.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      drumOsc.connect(drumG); drumG.connect(this.master);
      drumOsc.start(t); drumOsc.stop(t + 0.42);
      // horn drone
      const o = this.ctx.createOscillator();
      const og = this.ctx.createGain();
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 900;
      o.type = "sawtooth";
      o.frequency.setValueAtTime(f, t);
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(0.06, t + 0.08);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
      o.connect(lp); lp.connect(og); og.connect(this.master);
      o.start(t); o.stop(t + 0.65);
      this._beat++;
    };
    this.musicLoop = setInterval(playBeat, beatMs);
    playBeat();
  }
  stopMusic() {
    if (this.musicLoop) { clearInterval(this.musicLoop); this.musicLoop = null; }
  }
  blip(freq = 880, dur = 0.12, type = "triangle", gain = 0.12) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * 0.6), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  jump() { this.blip(620, 0.18, "triangle", 0.16); }
  collect() { this.blip(1200, 0.14, "sine", 0.18); setTimeout(() => this.blip(1600, 0.12, "sine", 0.12), 60); }
  hit() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.45);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.55);
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

    this.cognitiveState = "neutral";
    this.bpm = null;

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
    // Visible sun disc + halo, placed in the sky direction. Pure visual
    // anchor - gives the eye something to read as "that's the sun".
    const sunGeo = new THREE.SphereGeometry(12, 16, 12);
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xfff6d8, fog: false, transparent: true, opacity: 0.98,
      depthWrite: false,
    });
    this.sunDisc = new THREE.Mesh(sunGeo, sunMat);
    this.sunDisc.position.copy(this.sunPos).multiplyScalar(600);
    this.scene.add(this.sunDisc);

    // Diffuse halo around the sun
    const haloGeo = new THREE.SphereGeometry(48, 16, 12);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xffe9b0, fog: false, transparent: true, opacity: 0.22,
      depthWrite: false,
    });
    this.sunHalo = new THREE.Mesh(haloGeo, haloMat);
    this.sunHalo.position.copy(this.sunPos).multiplyScalar(600);
    this.scene.add(this.sunHalo);
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
    // Six tiled ground chunks with displaced vertices for relief.
    const segW = 24, segL = 32;
    const geo = new THREE.PlaneGeometry(GROUND_WIDTH, CHUNK_LENGTH, segW, segL);
    geo.rotateX(-Math.PI / 2);

    // Vertex colors: snow on the path band, mossy/rock further out
    const snowMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0.0,
      flatShading: true,
    });

    this.chunkGeo = geo;
    this.chunkMat = snowMat;

    for (let i = 0; i < CHUNK_COUNT; i++) {
      const chunk = this._makeChunk(i * CHUNK_LENGTH);
      this.chunks.push(chunk);
      this.scene.add(chunk.mesh);
    }
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
  }

  _buildSnow() {
    // Two layers of snow particles:
    // 1. CLOSE flakes - small count, big, very visible, RIGHT in front of
    //    the camera. This is what sells "weather". Without these the world
    //    feels static.
    // 2. FAR flakes - many small, drifting in middle distance for depth.

    // Close layer (~camera-relative volume in front of player)
    {
      const count = 350;
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

    // Far layer (existing volumetric drift)
    {
      const count = 1800;
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

  _doAction(action) {
    if (this.over || !this.running) return;
    switch (action) {
      case "left":
        if (this.lane > 0) { this.lane--; this.targetLaneX = LANES[this.lane]; this.audio.blip(420, 0.06, "triangle", 0.08); }
        break;
      case "right":
        if (this.lane < 2) { this.lane++; this.targetLaneX = LANES[this.lane]; this.audio.blip(420, 0.06, "triangle", 0.08); }
        break;
      case "jump":
        if (this.playerY <= 0.001 && !this.sliding) {
          this.playerVy = JUMP_VELOCITY; this.audio.jump();
        }
        break;
      case "slide":
        if (this.playerY <= 0.001 && !this.sliding) {
          this.sliding = true; this.slideTimer = SLIDE_DURATION;
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
      btn.addEventListener("click", async () => {
        if (!window.Bio) { btn.textContent = "Unavailable"; return; }
        const opts = {}; opts[key] = true;
        btn.textContent = "Starting";
        btn.disabled = true;
        btn.classList.remove("error", "live");
        try {
          const r = await window.Bio.start(opts);
          if (r[key] && r[key].ok !== false) {
            btn.textContent = "On";
            btn.classList.add("live");
          } else {
            btn.textContent = "Failed";
            btn.classList.add("error");
            btn.disabled = false;
          }
        } catch (e) {
          btn.textContent = "Failed";
          btn.classList.add("error");
          btn.disabled = false;
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
    this._showCombo();
    this._updateHUD();
    for (const o of this.obstacles) {
      this.scene.remove(o.mesh);
      if (o.decal) {
        if (Array.isArray(o.decal)) for (const d of o.decal) this.scene.remove(d);
        else this.scene.remove(o.decal);
      }
    }
    for (const c of this.collectibles) this.scene.remove(c.mesh);
    this.obstacles = []; this.collectibles = [];
    // First obstacle wave is ~55m ahead so the opening reads as world, not gauntlet.
    this._spawnZ = 55;
    this.running = true; this.over = false; this.paused = false;
    this.audio.ensure();
    this.audio.startWind();
    this.audio.startMusic();
  }

  _gameOver() {
    if (this.over) return;
    this.over = true; this.running = false;
    this.audio.stopMusic();
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
    // spawn a wave roughly every 12-22m of forward distance
    while (this._spawnZ < this.distance + VIEW_DEPTH * 0.7) {
      this._spawnWave(this._spawnZ);
      this._spawnZ += 14 + Math.random() * 10;
    }
  }

  _spawnWave(zWorld) {
    // zWorld = world distance where this wave appears.
    // We convert to scene Z (which scrolls toward the player).
    // Internally we track each entity by an absolute "spawnAt" world distance,
    // and compute its current scene z = (spawnAt - distance).
    const r = Math.random();
    // pattern selection
    const lanesAvail = [0, 1, 2];
    if (r < 0.35) {
      // single obstacle
      const lane = lanesAvail[(Math.random() * 3) | 0];
      this._spawnObstacle(lane, zWorld);
    } else if (r < 0.6) {
      // two-lane wall (force one specific lane)
      const safe = (Math.random() * 3) | 0;
      for (let i = 0; i < 3; i++) if (i !== safe) this._spawnObstacle(i, zWorld);
    } else if (r < 0.8) {
      // overhead beam (must slide) on all lanes
      this._spawnBeam(zWorld);
    } else {
      // empty wave - collectibles only
    }
    // collectibles
    const coinLane = (Math.random() * 3) | 0;
    const coinCount = 3 + ((Math.random() * 4) | 0);
    for (let i = 0; i < coinCount; i++) {
      this._spawnMead(coinLane, zWorld + i * 1.6);
    }
    // occasional rune (rare, big bonus)
    if (Math.random() < 0.18) {
      const lane = (Math.random() * 3) | 0;
      this._spawnRune(lane, zWorld + 4);
    }
  }

  // Each obstacle has a saturated emissive color so it reads against snow,
  // and a red ground-ring decal directly under it so the player sees the
  // threatened lane before reacting.
  _makeGroundDecal(color = 0xff3030, radius = 1.0) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.65, radius, 24),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.55, depthWrite: false,
        side: THREE.DoubleSide, fog: false,
      })
    );
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  _spawnObstacle(lane, zWorld) {
    const r = Math.random();
    let mesh, w, h, type;
    if (r < 0.34) {
      // Boulder: dark stone cracked with hot orange lava streaks.
      mesh = new THREE.Group();
      const rock = new THREE.Mesh(
        new THREE.DodecahedronGeometry(1.25, 0),
        new THREE.MeshStandardMaterial({
          color: 0x2a2a32, roughness: 0.95, flatShading: true,
          emissive: 0x4a1010, emissiveIntensity: 0.35,
        })
      );
      rock.position.y = 1.2;
      rock.rotation.set(Math.random(), Math.random(), Math.random());
      rock.castShadow = true;
      mesh.add(rock);
      for (let i = 0; i < 3; i++) {
        const streak = new THREE.Mesh(
          new THREE.BoxGeometry(0.14, 1.6, 0.14),
          new THREE.MeshBasicMaterial({ color: 0xff7020 })
        );
        streak.position.set((Math.random() - 0.5) * 0.9, 1.2, 0.85 + Math.random() * 0.15);
        streak.rotation.z = (Math.random() - 0.5) * 1.0;
        mesh.add(streak);
      }
      w = 2.0; h = 2.0; type = "boulder";
    } else if (r < 0.67) {
      // Troll: tall dark silhouette, glowing red chest + eyes, single horn.
      mesh = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 1.8, 1.0),
        new THREE.MeshStandardMaterial({
          color: 0x1a2418, roughness: 0.92, flatShading: true,
          emissive: 0x2c0e0e, emissiveIntensity: 0.4,
        })
      );
      body.position.y = 0.9;
      body.castShadow = true;
      mesh.add(body);
      const chest = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.34, 0),
        new THREE.MeshBasicMaterial({ color: 0xff2820 })
      );
      chest.position.set(0, 1.15, 0.55);
      mesh.add(chest);
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(0.85, 0.7, 0.78),
        new THREE.MeshStandardMaterial({
          color: 0x1a2418, roughness: 0.9, flatShading: true,
        })
      );
      head.position.y = 2.15;
      head.castShadow = true;
      mesh.add(head);
      for (const dx of [-0.2, 0.2]) {
        const eye = new THREE.Mesh(
          new THREE.SphereGeometry(0.1, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xff4020 })
        );
        eye.position.set(dx, 2.25, 0.4);
        mesh.add(eye);
      }
      const horn = new THREE.Mesh(
        new THREE.ConeGeometry(0.18, 0.65, 6),
        new THREE.MeshStandardMaterial({ color: 0x383838, roughness: 0.5, flatShading: true })
      );
      horn.position.y = 2.75;
      mesh.add(horn);
      w = 1.7; h = 2.6; type = "troll";
    } else {
      // Ice wall: opaque bright cyan slab with jagged tip ridge.
      mesh = new THREE.Group();
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 1.7, 0.55),
        new THREE.MeshStandardMaterial({
          color: 0x9eddee, roughness: 0.25, metalness: 0.2,
          flatShading: true, emissive: 0x4080a0, emissiveIntensity: 0.5,
        })
      );
      slab.position.y = 0.85;
      slab.castShadow = true;
      mesh.add(slab);
      for (let i = -1; i <= 1; i++) {
        const tip = new THREE.Mesh(
          new THREE.ConeGeometry(0.32, 0.75, 4),
          new THREE.MeshStandardMaterial({
            color: 0xcaecf3, roughness: 0.2, flatShading: true,
            emissive: 0x6098b0, emissiveIntensity: 0.45,
          })
        );
        tip.position.set(i * 0.46, 2.05, 0);
        mesh.add(tip);
      }
      w = 1.7; h = 2.4; type = "ice";
    }
    // Ground decal under the obstacle. Sits in world plane, not parented,
    // so we can scroll/fade it independently.
    const decal = this._makeGroundDecal(0xff2820, 1.15);
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

  _spawnMead(lane, zWorld) {
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
    // glow
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd066, transparent: true, opacity: 0.18, depthWrite: false })
    );
    grp.add(glow);
    grp.position.set(LANES[lane], 1.2, zWorld);
    this.scene.add(grp);
    this.collectibles.push({ mesh: grp, lane, spawnAt: zWorld, type: "mead", ang: 0, value: 5 });
  }

  _spawnRune(lane, zWorld) {
    const mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.5, 0),
      new THREE.MeshStandardMaterial({
        color: 0x9adfff, roughness: 0.2, metalness: 0.3,
        emissive: 0x1c8db8, emissiveIntensity: 0.9,
      })
    );
    mesh.position.set(LANES[lane], 1.6, zWorld);
    this.scene.add(mesh);
    this.collectibles.push({ mesh, lane, spawnAt: zWorld, type: "rune", ang: 0, value: 100 });
  }

  // ---------- Frame ----------
  _frame(now) {
    const realDt = Math.min(0.05, (now - this._lastT) / 1000);
    this._lastT = now;
    // Ease toward the active time scale (1 normally, 0.35 during rune slow-mo).
    this._timeScale += (this._timeScaleTarget - this._timeScale) * Math.min(1, realDt * 8);
    const dt = realDt * this._timeScale;
    if (!this.paused) this._update(dt);
    this._render();
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
    // Bio influence: berserker -> faster, meditation -> slower, flow -> smoother (multiplier on score)
    if (this.cognitiveState === "berserker") target *= 1.12;
    else if (this.cognitiveState === "meditation") target *= 0.9;
    this.speed += (target - this.speed) * Math.min(1, dt * 2);

    // forward distance
    this.distance += this.speed * dt;

    // score gain (boosted by combo, flow)
    const flowMul = (this.cognitiveState === "flow") ? 2.0 :
                    (this.cognitiveState === "focused") ? 1.4 :
                    (this.cognitiveState === "berserker") ? 1.5 : 1.0;
    this.score += dt * this.speed * 0.6 * (1 + this.combo * 0.05) * flowMul;

    // lane lerp
    const px = this.player.position.x;
    this.player.position.x = px + (this.targetLaneX - px) * Math.min(1, dt * 11);

    // jump physics
    this.playerVy -= GRAVITY * dt;
    this.playerY += this.playerVy * dt;
    if (this.playerY < 0) { this.playerY = 0; this.playerVy = 0; }
    this.player.position.y = this.playerY;

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
    const camTargetX = this.player.position.x * 0.4 + Math.sin(t * 0.3) * 0.15;
    const camTargetY = 4.0 + Math.sin(t * 0.25) * 0.08 + this.playerY * 0.15;
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
      if (!this.invuln && Math.abs(sz) < 1.0) {
        const hit = this._hitsPlayer(o);
        if (hit) {
          this._takeHit();
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
        if (o.lane === this.lane && o.type !== "beam") {
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
      c.mesh.position.z = sz;
      c.ang += dt * 3;
      c.mesh.rotation.y = c.ang;
      c.mesh.position.y = (c.type === "rune" ? 1.6 : 1.2) + Math.sin(c.ang * 1.3) * 0.12;
      if (Math.abs(sz) < 0.9 && Math.abs(this.player.position.x - LANES[c.lane]) < 1.2 &&
          this.playerY < 2.4 && this.playerY > -0.2) {
        if (c.type === "mead") {
          this.mead++;
          const gain = 25;
          this.score += gain;
          this.audio.collect();
          this._popText(`+${gain}`, "gold", (Math.random() - 0.5) * 60, 0);
        }
        if (c.type === "rune") {
          this.score += c.value;
          this.audio.collect();
          this._popText(`+${c.value}`, "rune", 0, -20);
          this._slowMo(0.35, 0.7);
          this.hud.glory.classList.add("on");
          setTimeout(() => this.hud.glory.classList.remove("on"), 350);
        }
        this.scene.remove(c.mesh);
        this.collectibles.splice(i, 1);
      } else if (sz < -8) {
        this.scene.remove(c.mesh);
        this.collectibles.splice(i, 1);
      }
    }

    // spawn ahead
    this._spawnAhead(dt);

    // snow drift
    this._driftSnow(dt);

    // mountain ring follows the player slowly so they always feel distant
    this.mountainRing.position.z = this.distance;
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
    if (o.type === "beam") {
      // overhead beam: hits unless we're sliding (low) or fully airborne above 2m? must SLIDE.
      return !this.sliding;
    }
    if (Math.abs(px - LANES[o.lane]) > (o.w * 0.5 + 0.55)) return false;
    if (this.playerY > o.h - 0.3) return false; // jumped over
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

// Boot - modules are deferred, so DOM is already parsed when this runs.
function boot() {
  try {
    window.__valhalla = new Valhalla();
    console.log("[Valhalla] booted");
  } catch (e) {
    console.error("[Valhalla] init failed", e);
    const ldr = $("loader");
    if (ldr) ldr.innerHTML = `<div style='text-align:center;line-height:1.5'>Failed to load.<br><br><span style='font-size:11px;opacity:.7'>${(e && e.message) || e}</span><br><br><a href='./index.html' style='color:#fff'>Back to menu</a></div>`;
  }
}
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
