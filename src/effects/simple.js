import { Effect, createProgram, getQuadVAO } from './effect.js';
import { drawLine, drawVBar, setPixel } from '../core/line-draw.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;   // previous frame
uniform sampler2D uOverlay; // drawn lines
uniform int uBlend;         // 0=replace, 1=additive
out vec4 fragColor;
void main() {
  vec4 base = texture(uInput, vUv);
  vec4 over = texture(uOverlay, vUv);
  if (over.a > 0.0) {
    if (uBlend == 1) {
      fragColor = vec4(min(base.rgb + over.rgb, vec3(1.0)), 1.0);
    } else {
      fragColor = over;
    }
  } else {
    fragColor = base;
  }
}
`;

// Simple waveform/spectrum renderer — mirrors r_simple.cpp
export class SimpleEffect extends Effect {
  constructor(gl) {
    super(gl);
    // mode: 0=solid analyzer, 1=line analyzer, 2=line scope, 3=solid scope
    this.mode    = 2;  // line scope default
    this.channel = 0;  // 0=L, 1=R, 2=mix
    this.colors  = [[255, 255, 255]];
    this.blend   = 0;  // 0=replace, 1=additive
    this.position = 1; // 0=top, 1=center, 2=bottom

    this._colorPos = 0;

    this._prog = createProgram(gl, vertSrc, FRAG);
    this._uInput   = gl.getUniformLocation(this._prog, 'uInput');
    this._uOverlay = gl.getUniformLocation(this._prog, 'uOverlay');
    this._uBlend   = gl.getUniformLocation(this._prog, 'uBlend');

    this._overlayTex = gl.createTexture();
    this._overlayFBO = gl.createFramebuffer();
    this._overlayW = 0;
    this._overlayH = 0;
    this._overlayBuf = null;
  }

  _ensureOverlay(gl, w, h) {
    if (this._overlayW === w && this._overlayH === h) return;
    this._overlayW = w; this._overlayH = h;
    this._overlayBuf = new Uint8Array(w * h * 4);
    gl.bindTexture(gl.TEXTURE_2D, this._overlayTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._overlayFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._overlayTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  _getColor() {
    if (this.colors.length === 0) return [255, 255, 255];
    if (this.colors.length === 1) return this.colors[0];
    // Animate through color list at 64 frames per color
    const total = this.colors.length * 64;
    this._colorPos = (this._colorPos + 1) % total;
    const seg = Math.floor(this._colorPos / 64);
    const t   = (this._colorPos % 64) / 64;
    const c0 = this.colors[seg % this.colors.length];
    const c1 = this.colors[(seg + 1) % this.colors.length];
    return [
      Math.round(c0[0] * (1-t) + c1[0] * t),
      Math.round(c0[1] * (1-t) + c1[1] * t),
      Math.round(c0[2] * (1-t) + c1[2] * t),
    ];
  }

  render(ctx) {
    const { gl, visdata, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;
    this._ensureOverlay(gl, w, h);

    const buf = this._overlayBuf;
    buf.fill(0);

    const [r, g, b] = this._getColor();

    // Select audio source
    const BINS = 576;
    let spectrum, waveform;
    if (this.channel === 2) {
      spectrum = new Float32Array(BINS);
      waveform = new Float32Array(BINS);
      for (let i = 0; i < BINS; i++) {
        spectrum[i] = (visdata[0][0][i] + visdata[0][1][i]) * 0.5;
        waveform[i] = (visdata[1][0][i] + visdata[1][1][i]) * 0.5;
      }
    } else {
      spectrum = visdata[0][this.channel];
      waveform = visdata[1][this.channel];
    }

    const h2 = Math.floor(h / 2);
    let yBase;
    if (this.position === 0) yBase = 0;
    else if (this.position === 2) yBase = h - 1;
    else yBase = h2;

    if (this.mode === 0 || this.mode === 1) {
      // Analyzer modes: spectrum data
      const xscale = BINS / w;
      let prevX = 0, prevY = yBase;
      for (let x = 0; x < w; x++) {
        const r2 = x * xscale;
        const lo = Math.floor(r2), hi = Math.min(lo + 1, BINS - 1);
        const frac = r2 - lo;
        const val = spectrum[lo] * (1 - frac) + spectrum[hi] * frac;
        const barH = Math.round(val / 255 * h2);
        const y = yBase - barH;
        if (this.mode === 0) {
          drawVBar(buf, x, y, yBase, w, h, r, g, b, 0);
        } else {
          if (x > 0) drawLine(buf, prevX, prevY, x, y, w, h, r, g, b, 0);
        }
        prevX = x; prevY = y;
      }
    } else {
      // Scope modes: waveform data
      const xscale = BINS / w;
      let prevX = 0, prevY = yBase;
      for (let x = 0; x < w; x++) {
        const r2 = x * xscale;
        const lo = Math.floor(r2), hi = Math.min(lo + 1, BINS - 1);
        const frac = r2 - lo;
        const val = waveform[lo] * (1 - frac) + waveform[hi] * frac;
        // val is 0..255 where 128 = zero crossing (matching original ^128 xorv)
        const offset = Math.round((val - 128) / 128 * h2);
        const y = yBase + offset;
        if (this.mode === 2) {
          if (x > 0) drawLine(buf, prevX, prevY, x, y, w, h, r, g, b, 0);
        } else {
          drawVBar(buf, x, yBase, y, w, h, r, g, b, 0);
        }
        prevX = x; prevY = y;
      }
    }

    // Upload overlay to GPU
    gl.bindTexture(gl.TEXTURE_2D, this._overlayTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Composite
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._overlayTex);
    gl.uniform1i(this._uOverlay, 1);
    gl.uniform1i(this._uBlend, this.blend);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return { mode: this.mode, channel: this.channel, colors: this.colors.map(c => [...c]), blend: this.blend, position: this.position };
  }

  setConfig(cfg) {
    if (cfg.mode    !== undefined) this.mode    = cfg.mode;
    if (cfg.channel !== undefined) this.channel = cfg.channel;
    if (cfg.colors)  this.colors  = cfg.colors.map(c => [...c]);
    if (cfg.blend   !== undefined) this.blend   = cfg.blend;
    if (cfg.position !== undefined) this.position = cfg.position;
  }

  getDescriptor() {
    return {
      name: 'Simple',
      params: [
        { name: 'mode', label: 'Mode', type: 'select', options: [
          { value: 0, label: 'Solid Analyzer' }, { value: 1, label: 'Line Analyzer' },
          { value: 2, label: 'Line Scope' },     { value: 3, label: 'Solid Scope' },
        ], default: 2 },
        { name: 'channel', label: 'Channel', type: 'select', options: [
          { value: 0, label: 'Left' }, { value: 1, label: 'Right' }, { value: 2, label: 'Mono Mix' },
        ], default: 0 },
        { name: 'position', label: 'Position', type: 'select', options: [
          { value: 0, label: 'Top' }, { value: 1, label: 'Center' }, { value: 2, label: 'Bottom' },
        ], default: 1 },
        { name: 'colors', label: 'Color', type: 'color', default: [255, 255, 255] },
        { name: 'blend', label: 'Blend', type: 'select', options: [
          { value: 0, label: 'Replace' }, { value: 1, label: 'Additive' },
        ], default: 0 },
      ],
    };
  }

  destroy() {
    const gl = this.gl;
    gl.deleteProgram(this._prog);
    gl.deleteTexture(this._overlayTex);
    gl.deleteFramebuffer(this._overlayFBO);
  }
}
