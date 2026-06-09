import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const BLEND_OPTIONS = [
  { value: 0, label: 'Replace'  },
  { value: 1, label: 'Additive' },
  { value: 2, label: '50/50'    },
  { value: 3, label: 'Default'  },
];

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform sampler2D uDots;
uniform int uBlend;
out vec4 fragColor;

void main() {
  vec4 base = texture(uInput, vUv);
  vec4 dot  = texture(uDots,  vUv);
  if (dot.a < 0.5) { fragColor = base; return; }
  vec3 b = base.rgb;
  vec3 s = dot.rgb;
  vec3 r;
  if      (uBlend == 1) r = min(b + s, vec3(1.0)); // Additive
  else if (uBlend == 2) r = (b + s) * 0.5;         // 50/50
  else if (uBlend == 3) r = b + s - b * s;         // Default (screen)
  else                  r = s;                       // Replace
  fragColor = vec4(r, 1.0);
}`;

export class DotGridEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.colors    = [[255, 255, 255]]; // 1..16 [r,g,b] entries, cycled with interpolation
    this.spacing   = 8;    // pixels between dots (min 2)
    this.speedX    = 128;  // fixed-point 8.8: 128 = 0.5 px/frame
    this.speedY    = 128;
    this.blendMode = 3;    // 0=Replace 1=Additive 2=50/50 3=Default

    // Persistent scrolling state (fixed-point 8.8: value >> 8 = screen pixels)
    this._xp = 0;
    this._yp = 0;
    // Color cycling position (0 .. colors.length*64 - 1, incremented each frame)
    this._colorPos = 0;

    this._dotsTex = null;
    this._dotsW   = 0;
    this._dotsH   = 0;
    this._dotsBuf = null;

    this._prog   = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uDots  = gl.getUniformLocation(this._prog, 'uDots');
    this._uBlend = gl.getUniformLocation(this._prog, 'uBlend');
  }

  _ensureDots(gl, w, h) {
    if (this._dotsW === w && this._dotsH === h) return;
    this._dotsW   = w;
    this._dotsH   = h;
    this._dotsBuf = new Uint8Array(w * h * 4);
    if (this._dotsTex) gl.deleteTexture(this._dotsTex);
    this._dotsTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._dotsTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;
    if (!this.colors.length) { fboManager.swap(); return; }
    this._ensureDots(gl, w, h);

    // Advance color cycle and interpolate between adjacent colors (64 steps per pair).
    this._colorPos++;
    const cycle = this.colors.length * 64;
    if (this._colorPos >= cycle) this._colorPos = 0;
    const p  = (this._colorPos / 64) | 0;
    const fr = this._colorPos & 63;                          // fractional 0..63
    const c1 = this.colors[p];
    const c2 = this.colors[(p + 1) % this.colors.length];
    const cr = ((c1[0] * (63 - fr) + c2[0] * fr) / 64) | 0;
    const cg = ((c1[1] * (63 - fr) + c2[1] * fr) / 64) | 0;
    const cb = ((c1[2] * (63 - fr) + c2[2] * fr) / 64) | 0;

    const spacing = Math.max(2, this.spacing);
    // Grid pixel offset: fixed-point >> 8 gives pixels, wrapped to [0, spacing).
    // The extra +spacing before % handles negative xp/yp without a while loop.
    const sx = ((this._xp >> 8) % spacing + spacing) % spacing;
    const sy = ((this._yp >> 8) % spacing + spacing) % spacing;

    // Draw one pixel per grid point. Y is flipped because WebGL tex origin is bottom-left.
    const buf = this._dotsBuf;
    buf.fill(0);
    for (let gy = sy; gy < h; gy += spacing) {
      const row = (h - 1 - gy) * w;
      for (let gx = sx; gx < w; gx += spacing) {
        const i    = (row + gx) * 4;
        buf[i]     = cr;
        buf[i + 1] = cg;
        buf[i + 2] = cb;
        buf[i + 3] = 255;
      }
    }

    gl.bindTexture(gl.TEXTURE_2D, this._dotsTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._dotsTex);
    gl.uniform1i(this._uDots,  1);
    gl.uniform1i(this._uBlend, this.blendMode);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    // Advance scrolling position after rendering (matching original xp/yp update order).
    this._xp += this.speedX;
    this._yp += this.speedY;

    fboManager.swap();
  }

  getConfig() {
    return {
      colors:    this.colors.map(c => [...c]),
      color:     [...this.colors[0]],   // convenience alias for the UI color picker
      spacing:   this.spacing,
      speedX:    this.speedX,
      speedY:    this.speedY,
      blendMode: this.blendMode,
    };
  }

  setConfig(cfg) {
    if (cfg.colors !== undefined) {
      this.colors    = cfg.colors.map(c => [...c]);
      this._colorPos = 0; // reset to avoid out-of-bounds after color list changes
    }
    if (cfg.color     !== undefined) this.colors[0] = [...cfg.color]; // UI sets colors[0]
    if (cfg.spacing   !== undefined) this.spacing   = cfg.spacing;
    if (cfg.speedX    !== undefined) this.speedX    = cfg.speedX;
    if (cfg.speedY    !== undefined) this.speedY    = cfg.speedY;
    if (cfg.blendMode !== undefined) this.blendMode = cfg.blendMode;
  }

  getDescriptor() {
    return {
      name: 'Dot Grid',
      params: [
        { name: 'color',     label: 'Color',      type: 'color',  default: [255, 255, 255] },
        { name: 'spacing',   label: 'Spacing',    type: 'range',  min: 2, max: 64, step: 1, default: 8 },
        { name: 'speedX',    label: 'Speed X',    type: 'range',  min: -512, max: 544, step: 1, default: 128 },
        { name: 'speedY',    label: 'Speed Y',    type: 'range',  min: -512, max: 544, step: 1, default: 128 },
        { name: 'blendMode', label: 'Blend Mode', type: 'select', options: BLEND_OPTIONS, default: 3 },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._dotsTex) this.gl.deleteTexture(this._dotsTex);
  }
}
