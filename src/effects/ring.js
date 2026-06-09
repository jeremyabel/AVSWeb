import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';
import { drawLine } from '../core/line-draw.js';

// Composite overlay onto input; transparent pixels reveal the input.
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

export class RingEffect extends Effect {
  constructor(gl) {
    super(gl);

    // Config — defaults match original
    this.colors       = [[255, 255, 255]]; // list of [r,g,b], 1..16 entries
    this.size         = 8;   // 1..64
    this.audioSource  = 0;   // 0=waveform, 1=spectrum
    this.audioChannel = 2;   // 0=left, 1=right, 2=center
    this.position     = 2;   // 0=left, 1=right, 2=center

    // Color cycling state (advances each frame)
    this._colorPos = 0;

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

    // Advance color position; cycle length = numColors * 64 steps
    this._colorPos++;
    const cycleLen = this.colors.length * 64;
    if (this._colorPos >= cycleLen) this._colorPos = 0;

    // Interpolate current color between colors[p] and colors[p+1]
    const p = Math.floor(this._colorPos / 64);
    const r = this._colorPos & 63;
    const c1 = this.colors[p];
    const c2 = this.colors[(p + 1) % this.colors.length];
    const cr = Math.trunc((c1[0] * (63 - r) + c2[0] * r) / 64);
    const cg = Math.trunc((c1[1] * (63 - r) + c2[1] * r) / 64);
    const cb = Math.trunc((c1[2] * (63 - r) + c2[2] * r) / 64);

    // Build audio data array for the 80-segment lookup.
    // Original: visdata[!audio_source][channel] — waveform is at index 1, spectrum at 0.
    // Center channel averages L+R using signed arithmetic for waveform.
    let faData;
    if (this.audioChannel === 2) {
      const center = new Uint8Array(576);
      if (this.audioSource === 0) {
        // waveform: int8_t average, stored as uint8_t (same bit pattern as int8)
        // In our visdata, 128 = zero amplitude, so int8 = visdata[1][ch][i] − 128.
        // Result: (int8_L/2 + int8_R/2) as int8 → uint8 encoding.
        for (let i = 0; i < 576; i++) {
          center[i] = (Math.trunc((visdata[1][0][i] - 128) / 2)
                     + Math.trunc((visdata[1][1][i] - 128) / 2) + 128) & 0xff;
        }
      } else {
        // spectrum: uint8 average
        for (let i = 0; i < 576; i++) {
          center[i] = Math.trunc(visdata[0][0][i] / 2) + Math.trunc(visdata[0][1][i] / 2);
        }
      }
      faData = center;
    } else {
      faData = visdata[this.audioSource === 0 ? 1 : 0][this.audioChannel];
    }

    // Ring geometry: size controls radius as a fraction of the smaller screen dimension
    const fsize = this.size / 32.0;
    const sizePx = Math.min(h * fsize, w * fsize);
    const cy = Math.trunc(h / 2);
    let cx;
    if (this.position === 2) {        // center
      cx = Math.trunc(w / 2);
    } else if (this.position === 0) { // left
      cx = Math.trunc(w / 4);
    } else {                          // right
      cx = Math.trunc(w / 2) + Math.trunc(w / 4);
    }

    // Draw ring as 80 line segments into transparent overlay buffer.
    // Angles go backwards from 0 (right) around the full circle.
    // Audio data is mirrored at q=40 so both halves of the ring carry the same values,
    // making the ring symmetric and visually identical when y is flipped in GL.
    const buf = this._buf;
    buf.fill(0);

    const TWO_PI_OVER_80 = Math.PI * 2.0 / 80.0;

    // Initial point at q=0, a=0
    let sca0;
    if (this.audioSource === 0) {
      sca0 = 0.1 + ((faData[0] ^ 128) / 255.0) * 0.9;
    } else {
      sca0 = 0.1 + ((faData[0] / 2 + faData[1] / 2) / 255.0) * 0.9;
    }
    let lx = Math.trunc(cx + Math.cos(0) * sizePx * sca0);
    let ly = Math.trunc(cy + Math.sin(0) * sizePx * sca0);

    let a = 0.0;
    for (let q = 1; q <= 80; q++) {
      a -= TWO_PI_OVER_80;

      // Mirror audio data: q=1..40 uses bins 1..40, q=41..80 uses 39..0
      const idx = q > 40 ? 80 - q : q;
      let sca;
      if (this.audioSource === 0) {
        sca = 0.1 + ((faData[idx] ^ 128) / 255.0) * 0.9;
      } else {
        const si = idx * 2;
        sca = 0.1 + ((faData[si] / 2 + faData[si + 1] / 2) / 255.0) * 0.9;
      }

      const tx = Math.trunc(cx + Math.cos(a) * sizePx * sca);
      const ty = Math.trunc(cy + Math.sin(a) * sizePx * sca);

      // Skip segment only when both endpoints are off-screen (matches original check)
      if ((tx >= 0 && tx < w && ty >= 0 && ty < h) ||
          (lx >= 0 && lx < w && ly >= 0 && ly < h)) {
        drawLine(buf, tx, ty, lx, ly, w, h, cr, cg, cb, 0);
      }
      lx = tx;
      ly = ty;
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
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    fboManager.swap();
  }

  getConfig() {
    return {
      colors:       this.colors.map(c => [...c]),
      size:         this.size,
      audioSource:  this.audioSource,
      audioChannel: this.audioChannel,
      position:     this.position,
    };
  }

  setConfig(cfg) {
    if (cfg.colors       !== undefined) this.colors       = cfg.colors.map(c => [...c]);
    if (cfg.size         !== undefined) this.size         = cfg.size;
    if (cfg.audioSource  !== undefined) this.audioSource  = cfg.audioSource;
    if (cfg.audioChannel !== undefined) this.audioChannel = cfg.audioChannel;
    if (cfg.position     !== undefined) this.position     = cfg.position;
    if (this.colors.length === 0) this.colors = [[255, 255, 255]];
  }

  getDescriptor() {
    return {
      name: 'Ring',
      params: [
        { name: 'colors',       label: 'Color',         type: 'color',
          default: [[255, 255, 255]] },
        { name: 'size',         label: 'Size',          type: 'range',
          min: 1, max: 64, step: 1, default: 8 },
        { name: 'audioSource',  label: 'Audio Source',  type: 'select',
          options: [{ value: 0, label: 'Waveform' }, { value: 1, label: 'Spectrum' }],
          default: 0 },
        { name: 'audioChannel', label: 'Audio Channel', type: 'select',
          options: [
            { value: 0, label: 'Left'   },
            { value: 1, label: 'Right'  },
            { value: 2, label: 'Center' },
          ], default: 2 },
        { name: 'position',     label: 'Position',      type: 'select',
          options: [
            { value: 0, label: 'Left'   },
            { value: 1, label: 'Right'  },
            { value: 2, label: 'Center' },
          ], default: 2 },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._tex) this.gl.deleteTexture(this._tex);
  }
}
