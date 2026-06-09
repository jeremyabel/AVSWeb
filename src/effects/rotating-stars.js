import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';
import { drawLine } from '../core/line-draw.js';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform sampler2D uOverlay;
out vec4 fragColor;
void main() {
  vec4 ov = texture(uOverlay, vUv);
  vec4 base = texture(uInput, vUv);
  if (ov.a < 0.5) { fragColor = base; return; }
  fragColor = vec4(ov.rgb, 1.0);
}`;

// Angle step of 4π/5 (144°) between star vertices — connects every-other pentagon
// vertex, producing the crossing lines of a 5-pointed star.
const FOUR_PI_OVER_5 = Math.PI * 4.0 / 5.0;

export class RotatingStarsEffect extends Effect {
  constructor(gl) {
    super(gl);

    this.colors = [[255, 255, 255]]; // list of [r,g,b], 1..16 entries

    this._colorPos = 0;
    this._r        = 0.0; // global rotation accumulator, +0.1 per frame

    this._tex  = null;
    this._texW = 0;
    this._texH = 0;
    this._buf  = null;

    this._prog     = createProgram(gl, vertSrc, FRAG);
    this._uInput   = gl.getUniformLocation(this._prog, 'uInput');
    this._uOverlay = gl.getUniformLocation(this._prog, 'uOverlay');
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
    const { gl, visdata, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    if (this.colors.length === 0) return;

    this._ensureTex(gl, w, h);

    // Color cycling — identical to Ring
    this._colorPos++;
    const cycleLen = this.colors.length * 64;
    if (this._colorPos >= cycleLen) this._colorPos = 0;

    const p    = Math.floor(this._colorPos / 64);
    const frac = this._colorPos & 63;
    const c1   = this.colors[p];
    const c2   = this.colors[(p + 1) % this.colors.length];
    const cr   = Math.trunc((c1[0] * (63 - frac) + c2[0] * frac) / 64);
    const cg   = Math.trunc((c1[1] * (63 - frac) + c2[1] * frac) / 64);
    const cb   = Math.trunc((c1[2] * (63 - frac) + c2[2] * frac) / 64);

    // Orbit: both stars rotate around the center on opposite sides
    const orbitX = Math.trunc(Math.cos(this._r) * w / 4);
    const orbitY = Math.trunc(Math.sin(this._r) * h / 4);

    const buf = this._buf;
    buf.fill(0);

    // Draw two stars — c=0: left channel, c=1: right channel
    for (let c = 0; c < 2; c++) {
      // Find loudest local-maximum peak in spectrum bins 3..13.
      // A bin qualifies only if it exceeds both neighbours by at least 4.
      let s = 0;
      for (let l = 3; l < 14; l++) {
        const val = visdata[0][c][l];
        if (val > s && val > visdata[0][c][l + 1] + 4 && val > visdata[0][c][l - 1] + 4) {
          s = val;
        }
      }

      // c=0 orbits at (+orbitX, +orbitY), c=1 at the opposite side
      const cx = Math.trunc(w / 2) + (c === 0 ? orbitX : -orbitX);
      const cy = Math.trunc(h / 2) + (c === 0 ? orbitY : -orbitY);

      // Star size scales with peak amplitude; minimum size at silence: (s+9)/88 ≈ 0.10
      const vw = (w / 8.0) * (s + 9) / 88.0;
      const vh = (h / 8.0) * (s + 9) / 88.0;

      // Draw 5-pointed star: vertices at -r + k*(4π/5), connected in order.
      // The 4π/5 step (144°) between lines is what creates the star crossing pattern.
      let angle = -this._r;
      let lx = Math.trunc(Math.cos(angle) * vw) + cx;
      let ly = Math.trunc(Math.sin(angle) * vh) + cy;
      angle += FOUR_PI_OVER_5;

      for (let t = 0; t < 5; t++) {
        const nx = Math.trunc(Math.cos(angle) * vw) + cx;
        const ny = Math.trunc(Math.sin(angle) * vh) + cy;
        angle += FOUR_PI_OVER_5;

        if ((nx >= 0 && nx < w && ny >= 0 && ny < h) ||
            (lx >= 0 && lx < w && ly >= 0 && ly < h)) {
          drawLine(buf, lx, ly, nx, ny, w, h, cr, cg, cb, 0);
        }
        lx = nx;
        ly = ny;
      }
    }

    this._r += 0.1;

    // Upload overlay and composite over input
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
  }

  getConfig() {
    return { colors: this.colors.map(c => [...c]) };
  }

  setConfig(cfg) {
    if (cfg.colors !== undefined) this.colors = cfg.colors.map(c => [...c]);
    if (this.colors.length === 0) this.colors = [[255, 255, 255]];
  }

  getDescriptor() {
    return {
      name: 'Rotating Stars',
      params: [
        { name: 'colors', label: 'Colors', type: 'color', default: [[255, 255, 255]] },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._tex) this.gl.deleteTexture(this._tex);
  }
}
