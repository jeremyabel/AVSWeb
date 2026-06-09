import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform sampler2D uOverlay;
uniform int uBlendMode;
out vec4 fragColor;
void main() {
  vec4 ov = texture(uOverlay, vUv);
  vec4 base = texture(uInput, vUv);
  if (ov.a < 0.5) { fragColor = base; return; }
  vec3 col = ov.rgb;
  if (uBlendMode == 0) {        // Replace
    fragColor = vec4(col, 1.0);
  } else if (uBlendMode == 2) { // 50/50
    fragColor = vec4((base.rgb + col) * 0.5, 1.0);
  } else {                      // Additive (1) and Default (3)
    fragColor = vec4(min(base.rgb + col, vec3(1.0)), 1.0);
  }
}`;

export class MovingParticleEffect extends Effect {
  constructor(gl) {
    super(gl);

    // Config — defaults match original
    this.color            = [255, 255, 255]; // 0xffffff
    this.distance         = 16;  // 1..32
    this.size             = 8;   // 1..128
    this.onBeatSizeChange = false;
    this.onBeatSize       = 8;   // 1..128
    this.blendMode        = 1;   // 0=Replace 1=Additive 2=50/50 3=Default

    // Physics state — exact values from original constructor
    this._c = [0.0, 0.0];          // attractor position
    this._v = [-0.01551, 0.0];     // velocity
    this._p = [-0.6, 0.3];         // particle position
    this._curSize = this.size;     // smoothly-interpolated draw size

    this._tex  = null;
    this._texW = 0;
    this._texH = 0;
    this._buf  = null;

    this._prog     = createProgram(gl, vertSrc, FRAG);
    this._uInput   = gl.getUniformLocation(this._prog, 'uInput');
    this._uOverlay = gl.getUniformLocation(this._prog, 'uOverlay');
    this._uBlend   = gl.getUniformLocation(this._prog, 'uBlendMode');
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
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;
    this._ensureTex(gl, w, h);

    // On beat: move attractor to new random position in [-16/48, 16/48]
    // (rand() % 33 - 16) / 48.0 in original
    if (isBeat) {
      this._c[0] = (Math.floor(Math.random() * 33) - 16) / 48.0;
      this._c[1] = (Math.floor(Math.random() * 33) - 16) / 48.0;
    }

    // Spring-damper physics (exact constants from original)
    this._v[0] -= 0.004 * (this._p[0] - this._c[0]);
    this._v[1] -= 0.004 * (this._p[1] - this._c[1]);
    this._p[0] += this._v[0];
    this._p[1] += this._v[1];
    this._v[0] *= 0.991;
    this._v[1] *= 0.991;

    // Pixel-space position
    const ss = Math.min(h / 2, (w * 3) / 8);
    const xp = Math.trunc(this._p[0] * ss * (this.distance / 32.0)) + Math.trunc(w / 2);
    const yp = Math.trunc(this._p[1] * ss * (this.distance / 32.0)) + Math.trunc(h / 2);

    // On-beat size snap (before size smoothing, so the snap is visible this frame)
    if (isBeat && this.onBeatSizeChange) {
      this._curSize = this.onBeatSize;
    }

    // Capture draw size, then smooth curSize toward target for next frame
    const drawSize = this._curSize;
    this._curSize = Math.trunc((this._curSize + this.size) / 2);

    // Draw solid circle into overlay buffer
    const buf = this._buf;
    buf.fill(0);
    const [cr, cg, cb] = this.color;
    const size = Math.min(drawSize, 128);

    if (size <= 1) {
      if (xp >= 0 && xp < w && yp >= 0 && yp < h) {
        const idx = (yp * w + xp) * 4;
        buf[idx] = cr; buf[idx + 1] = cg; buf[idx + 2] = cb; buf[idx + 3] = 255;
      }
    } else {
      const md = size * size * 0.25;        // (size/2)^2
      const ypTop = yp - Math.trunc(size / 2);
      for (let y = 0; y < size; y++) {
        const row = ypTop + y;
        if (row < 0 || row >= h) continue;
        const yd = y - size * 0.5;
        const l = Math.sqrt(md - yd * yd);
        const xs = Math.max(1, Math.trunc(l + 0.99));  // ceil(l), matches (int32_t)(l+0.99)
        const xStart = Math.max(0, xp - xs);
        const xEnd   = Math.min(w, xp + xs);
        const rowBase = row * w * 4;
        for (let x = xStart; x < xEnd; x++) {
          const idx = rowBase + x * 4;
          buf[idx] = cr; buf[idx + 1] = cg; buf[idx + 2] = cb; buf[idx + 3] = 255;
        }
      }
    }

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
    gl.uniform1i(this._uBlend, this.blendMode);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    fboManager.swap();
  }

  getConfig() {
    return {
      color: [...this.color],
      distance: this.distance,
      size: this.size,
      onBeatSizeChange: this.onBeatSizeChange,
      onBeatSize: this.onBeatSize,
      blendMode: this.blendMode,
    };
  }

  setConfig(cfg) {
    if (cfg.color            !== undefined) this.color            = cfg.color;
    if (cfg.distance         !== undefined) this.distance         = cfg.distance;
    if (cfg.size             !== undefined) this.size             = cfg.size;
    if (cfg.onBeatSizeChange !== undefined) this.onBeatSizeChange = cfg.onBeatSizeChange;
    if (cfg.onBeatSize       !== undefined) this.onBeatSize       = cfg.onBeatSize;
    if (cfg.blendMode        !== undefined) this.blendMode        = cfg.blendMode;
  }

  getDescriptor() {
    return {
      name: 'Moving Particle',
      params: [
        { name: 'color',            label: 'Color',               type: 'color',  default: [255, 255, 255] },
        { name: 'distance',         label: 'Distance',            type: 'range',  min: 1, max: 32,  step: 1, default: 16 },
        { name: 'size',             label: 'Size',                type: 'range',  min: 1, max: 128, step: 1, default: 8 },
        { name: 'onBeatSizeChange', label: 'On Beat Size Change', type: 'bool',   default: false },
        { name: 'onBeatSize',       label: 'On Beat Size',        type: 'range',  min: 1, max: 128, step: 1, default: 8 },
        { name: 'blendMode',        label: 'Blend Mode',          type: 'select',
          options: [
            { value: 0, label: 'Replace'  },
            { value: 1, label: 'Additive' },
            { value: 2, label: '50/50'    },
            { value: 3, label: 'Default'  },
          ], default: 1 },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._tex) this.gl.deleteTexture(this._tex);
  }
}
