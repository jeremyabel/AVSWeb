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

const TWO_PI_OVER_5 = Math.PI * 2.0 / 5.0;

export class OscilloscopeStarEffect extends Effect {
  constructor(gl) {
    super(gl);

    // Config — defaults match original
    this.colors       = [[255, 255, 255]]; // list of [r,g,b], 1..16 entries
    this.audioChannel = 2;   // 0=left, 1=right, 2=center
    this.position     = 2;   // 0=left, 1=right, 2=center
    this.size         = 8;   // 0..32 → fraction of screen
    this.rotation     = 0;   // -16..16 (speed), applied as 0.01*rotation per frame

    // Color cycling state
    this._colorPos = 0;

    // Rotation accumulator in radians
    this._currentRotation = 0;

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

    // Advance color cycling
    this._colorPos++;
    const cycleLen = this.colors.length * 64;
    if (this._colorPos >= cycleLen) this._colorPos = 0;

    // Interpolate current color
    const p  = Math.floor(this._colorPos / 64);
    const r  = this._colorPos & 63;
    const c1 = this.colors[p];
    const c2 = this.colors[(p + 1) % this.colors.length];
    const cr = Math.trunc((c1[0] * (63 - r) + c2[0] * r) / 64);
    const cg = Math.trunc((c1[1] * (63 - r) + c2[1] * r) / 64);
    const cb = Math.trunc((c1[2] * (63 - r) + c2[2] * r) / 64);

    // Build audio data — waveform only (oscilloscope star always uses waveform)
    let faData;
    if (this.audioChannel === 2) {
      const center = new Uint8Array(576);
      for (let i = 0; i < 576; i++) {
        center[i] = (Math.trunc((visdata[1][0][i] - 128) / 2)
                   + Math.trunc((visdata[1][1][i] - 128) / 2) + 128) & 0xff;
      }
      faData = center;
    } else {
      faData = visdata[1][this.audioChannel];
    }

    // Size: size/32 fraction of smaller screen dimension
    const fsize  = this.size / 32.0;
    const sizePx = Math.min(h * fsize, w * fsize);

    // Center position
    const cy = Math.trunc(h / 2);
    let cx;
    if (this.position === 2) {        // center
      cx = Math.trunc(w / 2);
    } else if (this.position === 0) { // left
      cx = Math.trunc(w / 4);
    } else {                          // right
      cx = Math.trunc(w / 2) + Math.trunc(w / 4);
    }

    // Draw into overlay buffer
    const buf = this._buf;
    buf.fill(0);

    // dfactor constants from C++: starts at 1/1024, ends at 1/128 over 64 steps
    const DFACTOR_START = 1.0 / 1024.0;
    const DFACTOR_STEP  = (DFACTOR_START - 1.0 / 128.0) / 64.0; // negative
    const dp = sizePx / 64.0;

    let ii = 0; // linear index into faData, 5 arms × 64 = 320 total

    for (let q = 0; q < 5; q++) {
      const angle = this._currentRotation + q * TWO_PI_OVER_5;
      const cosA  = Math.cos(angle);
      const sinA  = Math.sin(angle);

      let dfactor = DFACTOR_START;
      let p_dist  = 0.0;

      // Each arm starts from the screen center, matching C++ `lx=c_x; ly=h/2`
      let lx = cx;
      let ly = cy;

      for (let seg = 0; seg < 64; seg++, ii++) {
        // JS visdata: 128 = zero amplitude; ale formula is (v - 128), not (v^128 - 128)
        const ale = (faData[ii] - 128) * dfactor * sizePx;
        const tx  = Math.trunc(cx + cosA * p_dist - sinA * ale);
        const ty  = Math.trunc(cy + sinA * p_dist + cosA * ale);

        if ((tx >= 0 && tx < w && ty >= 0 && ty < h) ||
            (lx >= 0 && lx < w && ly >= 0 && ly < h)) {
          drawLine(buf, tx, ty, lx, ly, w, h, cr, cg, cb, 0);
        }

        lx = tx;
        ly = ty;
        p_dist  += dp;
        dfactor += DFACTOR_STEP;
      }
    }

    // Advance rotation: 0.01 * rotation radians per frame, wraps at 2π
    this._currentRotation += 0.01 * this.rotation;
    if (this._currentRotation >= Math.PI * 2) this._currentRotation -= Math.PI * 2;
    if (this._currentRotation <  0)            this._currentRotation += Math.PI * 2;

    // Upload overlay and composite
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
      audioChannel: this.audioChannel,
      position:     this.position,
      size:         this.size,
      rotation:     this.rotation,
    };
  }

  setConfig(cfg) {
    if (cfg.colors       !== undefined) this.colors       = cfg.colors.map(c => [...c]);
    if (cfg.audioChannel !== undefined) this.audioChannel = cfg.audioChannel;
    if (cfg.position     !== undefined) this.position     = cfg.position;
    if (cfg.size         !== undefined) this.size         = Math.max(0, Math.min(32, cfg.size));
    if (cfg.rotation     !== undefined) this.rotation     = Math.max(-16, Math.min(16, cfg.rotation));
    if (this.colors.length === 0) this.colors = [[255, 255, 255]];
  }

  getDescriptor() {
    return {
      name: 'Oscilloscope Star',
      params: [
        { name: 'colors',       label: 'Color',         type: 'color',
          default: [[255, 255, 255]] },
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
        { name: 'size',         label: 'Size',          type: 'range',
          min: 0, max: 32, step: 1, default: 8 },
        { name: 'rotation',     label: 'Rotation Speed', type: 'range',
          min: -16, max: 16, step: 1, default: 0 },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._tex) this.gl.deleteTexture(this._tex);
  }
}
