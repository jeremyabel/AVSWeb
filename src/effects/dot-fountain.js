import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// 256 rings × 30 angular positions
const NUM_GENS = 256;
const NUM_ANG  = 30;
const N        = NUM_GENS * NUM_ANG; // 7680 total particles

// Additive composite — matches original blend_default_1px (g_line_blend_mode=0 → additive)
const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform sampler2D uOverlay;
out vec4 fragColor;
void main() {
  vec3 ov   = texture(uOverlay, vUv).rgb;
  vec3 base = texture(uInput,   vUv).rgb;
  fragColor = vec4(clamp(base + ov, 0.0, 1.0), 1.0);
}`;

// ── Exact port of matrix.cpp ──────────────────────────────────────────────────
// Axis is 1-indexed: 1=X, 2=Y, 3=Z (matching original char m parameter).

function matRot(m, axis, deg) {
  const r = deg * Math.PI / 180;
  m.fill(0);
  m[(axis - 1) * 4 + (axis - 1)] = 1;
  m[15] = 1;
  const m1 = axis % 3;
  const m2 = (m1 + 1) % 3;
  const c = Math.cos(r), s = Math.sin(r);
  m[m1 * 4 + m1] = c;
  m[m1 * 4 + m2] = s;
  m[m2 * 4 + m2] = c;
  m[m2 * 4 + m1] = -s;
}

function matTrans(m, x, y, z) {
  m.fill(0);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[3] = x; m[7] = y; m[11] = z;
}

// dest = src × dest_old  (matches original matrixMultiply semantics)
function matMul(dest, src) {
  const t = dest.slice(); // save dest_old
  for (let i = 0; i < 16; i += 4) {
    dest[i  ] = src[i]*t[0] + src[i+1]*t[4] + src[i+2]*t[8]  + src[i+3]*t[12];
    dest[i+1] = src[i]*t[1] + src[i+1]*t[5] + src[i+2]*t[9]  + src[i+3]*t[13];
    dest[i+2] = src[i]*t[2] + src[i+1]*t[6] + src[i+2]*t[10] + src[i+3]*t[14];
    dest[i+3] = src[i]*t[3] + src[i+1]*t[7] + src[i+2]*t[11] + src[i+3]*t[15];
  }
}

export class DotFountainEffect extends Effect {
  constructor(gl) {
    super(gl);

    // Config — defaults match original (colors stored as [r,g,b], unpacked from 0xBBGGRR)
    // 0x1c6b18→[24,107,28]  0xff0a23→[35,10,255]  0x2a1d74→[116,29,42]
    // 0x9036d9→[217,54,144]  0x6b88ff→[255,136,107]
    this.colors = [
      [24, 107, 28], [35, 10, 255], [116, 29, 42], [217, 54, 144], [255, 136, 107],
    ];
    this.rotationSpeed = 16;   // -50..50
    this.angle         = -20;  // degrees, -90..91
    this._rotation     = 0;    // current spin angle, advances each frame

    // Particle state — flat typed arrays, index = gen*NUM_ANG + ang
    this._rad  = new Float32Array(N); // radius
    this._dRad = new Float32Array(N); // delta_radius
    this._ht   = new Float32Array(N); // height (y in 3D)
    this._dHt  = new Float32Array(N); // delta_height (upward velocity, gravity decelerates)
    this._ax   = new Float32Array(N); // sin(angle) — x direction factor
    this._ay   = new Float32Array(N); // cos(angle) — z direction factor
    this._colR = new Uint8Array(N);
    this._colG = new Uint8Array(N);
    this._colB = new Uint8Array(N);

    // Color map: 4 intervals × 16 lerp steps = 64 entries
    this._mapR = new Uint8Array(64);
    this._mapG = new Uint8Array(64);
    this._mapB = new Uint8Array(64);
    this._initColorMap();

    // Overlay texture (CPU buffer, uploaded each frame)
    this._tex  = null; this._texW = 0; this._texH = 0; this._buf = null;

    this._prog     = createProgram(gl, vertSrc, FRAG);
    this._uInput   = gl.getUniformLocation(this._prog, 'uInput');
    this._uOverlay = gl.getUniformLocation(this._prog, 'uOverlay');

    // Reusable matrix storage (avoids allocation per frame)
    this._m  = new Float32Array(16);
    this._m2 = new Float32Array(16);
  }

  _initColorMap() {
    for (let t = 0; t < 4; t++) {
      const [c1r, c1g, c1b] = this.colors[t];
      const [c2r, c2g, c2b] = this.colors[t + 1];
      // Fixed-point interpolation matching original (<<16 for 16-bit fraction)
      let r = c1r << 16, g = c1g << 16, b = c1b << 16;
      const dr = Math.trunc(((c2r - c1r) << 16) / 16);
      const dg = Math.trunc(((c2g - c1g) << 16) / 16);
      const db = Math.trunc(((c2b - c1b) << 16) / 16);
      for (let x = 0; x < 16; x++) {
        this._mapR[t * 16 + x] = (r >> 16) & 0xff;
        this._mapG[t * 16 + x] = (g >> 16) & 0xff;
        this._mapB[t * 16 + x] = (b >> 16) & 0xff;
        r += dr; g += dg; b += db;
      }
    }
  }

  _ensureTex(gl, w, h) {
    if (this._texW === w && this._texH === h) return;
    this._texW = w; this._texH = h;
    this._buf = new Uint8Array(w * h * 4);
    if (this._tex) gl.deleteTexture(this._tex);
    this._tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  render(ctx) {
    const { gl, visdata, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;
    this._ensureTex(gl, w, h);

    const { _rad: rad, _dRad: drad, _ht: ht, _dHt: dht, _ax: ax, _ay: ay } = this;

    // ── 1. Shift generations 0→1, 1→2, …, 254→255 (high-to-low to avoid overwrite)
    //       Apply physics to each destination after copying.
    for (let gen = 254; gen >= 0; gen--) {
      const accelRadius = 1.3 / (gen + 100);
      const srcBase = gen * NUM_ANG;
      const dstBase = (gen + 1) * NUM_ANG;
      for (let a = 0; a < NUM_ANG; a++) {
        const src = srcBase + a, dst = dstBase + a;
        rad[dst]          = rad[src];
        drad[dst]         = drad[src];
        ht[dst]           = ht[src];
        dht[dst]          = dht[src];
        ax[dst]           = ax[src];
        ay[dst]           = ay[src];
        this._colR[dst]   = this._colR[src];
        this._colG[dst]   = this._colG[src];
        this._colB[dst]   = this._colB[src];
        // Physics (applied to destination, matching original *next = *prev; then update *next)
        rad[dst]  += drad[dst];
        dht[dst]  += 0.05;
        drad[dst] += accelRadius;
        ht[dst]   += dht[dst];
      }
    }

    // ── 2. Spawn new generation 0 from waveform audio
    //       In the original: (uint8_t)visdata[1][0][a] ^ 128
    //       Our visdata[1][0][a] is already uint8 with 128=silence, matching the C++ result.
    const { _mapR: mR, _mapG: mG, _mapB: mB } = this;
    for (let a = 0; a < NUM_ANG; a++) {
      const sample = visdata[1][0][a];
      let audio = Math.trunc(sample * 5 / 4) - 64 + (isBeat ? 128 : 0);
      if (audio > 255) audio = 255;

      rad[a]  = 1.0;
      ht[a]   = 250.0;
      // tmp_ring saved before the shift, but delta_height difference always cancels to 0
      // (points[0] is unchanged by the shift loop), so the formula simplifies to:
      const dr = Math.abs(audio) / 200.0 + 1.0;
      dht[a]  = -dr * 2.8;
      drad[a] = 0.0;

      const colorIdx = Math.max(0, Math.min(63, Math.trunc(audio / 4)));
      this._colR[a] = mR[colorIdx];
      this._colG[a] = mG[colorIdx];
      this._colB[a] = mB[colorIdx];

      const angle = a * Math.PI * 2.0 / NUM_ANG;
      ax[a] = Math.sin(angle);
      ay[a] = Math.cos(angle);
    }

    // ── 3. Build transform: T(0,−20,400) × Rx(angle) × Ry(rotation)
    //       matMul(dest, src) computes dest = src × dest_old
    const m = this._m, m2 = this._m2;
    matRot(m,  2, this._rotation); // Ry(rotation) — spins fountain around Y
    matRot(m2, 1, this.angle);     // Rx(angle)    — tilts forward/back
    matMul(m, m2);                  // m = Rx × Ry
    matTrans(m2, 0.0, -20.0, 400.0);
    matMul(m, m2);                  // m = T × Rx × Ry

    // ── 4. Project all particles and render into overlay buffer (additive)
    const buf = this._buf;
    buf.fill(0);

    // Zoom matches original: scale to fit screen while preserving aspect ratio
    let zoom = w * 440.0 / 640.0;
    const zoom2 = h * 440.0 / 480.0;
    if (zoom2 < zoom) zoom = zoom2;

    const hw = (w / 2) | 0;
    const hh = (h / 2) | 0;
    const { _colR: colR, _colG: colG, _colB: colB } = this;

    // Inline matrixApply to avoid per-particle function call overhead
    const m0=m[0], m1=m[1], m2e=m[2], m3=m[3];
    const m4=m[4], m5=m[5], m6=m[6], m7=m[7];
    const m8=m[8], m9=m[9], m10=m[10], m11=m[11];

    for (let i = 0; i < N; i++) {
      const px = ax[i] * rad[i];
      const py = ht[i];
      const pz = ay[i] * rad[i];

      const ox = px*m0  + py*m1  + pz*m2e + m3;
      const oy = px*m4  + py*m5  + pz*m6  + m7;
      const oz = px*m8  + py*m9  + pz*m10 + m11;

      if (oz > 0.0000001) {
        const zp = zoom / oz;
        const sx = ((ox * zp) | 0) + hw;
        const sy = ((oy * zp) | 0) + hh;  // top-down screen y (matches original)
        if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
          // Flip y for GL bottom-up texture convention:
          // CPU buffer row 0 appears at the bottom of the GL display.
          const pixIdx = ((h - 1 - sy) * w + sx) << 2;
          buf[pixIdx]     = Math.min(255, buf[pixIdx]     + colR[i]);
          buf[pixIdx + 1] = Math.min(255, buf[pixIdx + 1] + colG[i]);
          buf[pixIdx + 2] = Math.min(255, buf[pixIdx + 2] + colB[i]);
          buf[pixIdx + 3] = 255;
        }
      }
    }

    // ── 5. Upload overlay and composite additively onto input
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.uniform1i(this._uOverlay, 1);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    fboManager.swap();

    // ── 6. Advance rotation
    this._rotation += this.rotationSpeed / 5.0;
    if (this._rotation >= 360.0) this._rotation -= 360.0;
    if (this._rotation <    0.0) this._rotation += 360.0;
  }

  getConfig() {
    return {
      color0:        [...this.colors[0]],
      color1:        [...this.colors[1]],
      color2:        [...this.colors[2]],
      color3:        [...this.colors[3]],
      color4:        [...this.colors[4]],
      rotationSpeed: this.rotationSpeed,
      angle:         this.angle,
    };
  }

  setConfig(cfg) {
    let reinit = false;
    for (let i = 0; i < 5; i++) {
      const key = `color${i}`;
      if (cfg[key] !== undefined) { this.colors[i] = [...cfg[key]]; reinit = true; }
    }
    if (cfg.rotationSpeed !== undefined) this.rotationSpeed = cfg.rotationSpeed;
    if (cfg.angle         !== undefined) this.angle         = cfg.angle;
    if (reinit) this._initColorMap();
  }

  getDescriptor() {
    return {
      name: 'Dot Fountain',
      params: [
        { name: 'color0', label: 'Color 1', type: 'color', default: [24,  107, 28]  },
        { name: 'color1', label: 'Color 2', type: 'color', default: [35,  10,  255] },
        { name: 'color2', label: 'Color 3', type: 'color', default: [116, 29,  42]  },
        { name: 'color3', label: 'Color 4', type: 'color', default: [217, 54,  144] },
        { name: 'color4', label: 'Color 5', type: 'color', default: [255, 136, 107] },
        { name: 'rotationSpeed', label: 'Rotation Speed', type: 'range',
          min: -50, max: 50, step: 1, default: 16 },
        { name: 'angle', label: 'Tilt Angle', type: 'range',
          min: -90, max: 91, step: 1, default: -20 },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._tex) this.gl.deleteTexture(this._tex);
  }
}
