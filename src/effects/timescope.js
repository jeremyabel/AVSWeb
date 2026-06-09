import { Effect, createProgram, getQuadVAO } from './effect.js';
import { setPixel } from '../core/line-draw.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBase;
uniform sampler2D uScope;
uniform int uBlend;
out vec4 fragColor;
void main() {
  vec4 base = texture(uBase, vUv);
  vec4 over = texture(uScope, vUv);
  if (over.a > 0.0) {
    fragColor = (uBlend == 1)
      ? vec4(min(base.rgb + over.rgb, vec3(1.0)), 1.0)
      : vec4(over.rgb, 1.0);
  } else {
    fragColor = base;
  }
}
`;

const BINS = 576;

// Scrolling waveform — draws one column per frame, accumulating in a persistent CPU buffer.
export class TimescopeEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.channel = 0;  // 0=left spectrum, 1=right, 2=left wave, 3=right wave
    this.color   = [0, 255, 128];
    this.blend   = 0;  // 0=replace, 1=additive

    this._colIdx = 0;
    this._scopeTex = gl.createTexture();
    this._scopeW = 0; this._scopeH = 0;
    this._scopeBuf = null;

    this._prog  = createProgram(gl, vertSrc, FRAG);
    this._uBase  = gl.getUniformLocation(this._prog, 'uBase');
    this._uScope = gl.getUniformLocation(this._prog, 'uScope');
    this._uBlend = gl.getUniformLocation(this._prog, 'uBlend');
  }

  _ensureScope(gl, w, h) {
    if (this._scopeW === w && this._scopeH === h) return;
    this._scopeW = w; this._scopeH = h;
    this._scopeBuf = new Uint8Array(w * h * 4);
    this._colIdx = 0;
    gl.bindTexture(gl.TEXTURE_2D, this._scopeTex);
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
    this._ensureScope(gl, w, h);

    const buf = this._scopeBuf;
    const isWave = this.channel >= 2;
    const ch = this.channel % 2;
    const audio = visdata[isWave ? 1 : 0][ch];
    const [cr, cg, cb] = this.color;
    const x = this._colIdx;

    // Draw one vertical column at x based on audio data
    for (let y = 0; y < h; y++) {
      const audioIdx = Math.floor((y / h) * BINS);
      const val = audio[audioIdx];
      // spectrum: bar filled from bottom up; waveform: filled up to sample value
      let draw;
      if (isWave) {
        const mid = h / 2;
        const offset = Math.round((val / 128 - 1) * mid);
        draw = (y === Math.round(mid + offset));
      } else {
        const barH = Math.round(val / 255 * h);
        draw = (y >= h - barH);
      }

      const i = (y * w + x) * 4;
      if (draw) {
        buf[i] = cr; buf[i+1] = cg; buf[i+2] = cb; buf[i+3] = 255;
      } else {
        buf[i] = 0; buf[i+1] = 0; buf[i+2] = 0; buf[i+3] = 0;
      }
    }

    // Upload scope to texture
    gl.bindTexture(gl.TEXTURE_2D, this._scopeTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this._colIdx = (this._colIdx + 1) % w;

    // Composite scope over input
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uBase, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._scopeTex);
    gl.uniform1i(this._uScope, 1);
    gl.uniform1i(this._uBlend, this.blend);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return { channel: this.channel, color: [...this.color], blend: this.blend }; }
  setConfig(cfg) {
    if (cfg.channel !== undefined) this.channel = cfg.channel;
    if (cfg.color)                  this.color   = cfg.color;
    if (cfg.blend   !== undefined)  this.blend   = cfg.blend;
  }

  getDescriptor() {
    return {
      name: 'Timescope',
      params: [
        { name: 'channel', label: 'Source', type: 'select', options: [
          { value: 0, label: 'Spectrum L' }, { value: 1, label: 'Spectrum R' },
          { value: 2, label: 'Waveform L' }, { value: 3, label: 'Waveform R' },
        ], default: 2 },
        { name: 'color', label: 'Color', type: 'color', default: [0, 255, 128] },
        { name: 'blend', label: 'Blend', type: 'select',
          options: [{ value: 0, label: 'Replace' }, { value: 1, label: 'Additive' }], default: 0 },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    this.gl.deleteTexture(this._scopeTex);
  }
}
