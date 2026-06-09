import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

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

export class BassSpinEffect extends Effect {
  constructor(gl) {
    super(gl);

    // Config
    this.enabledLeft  = true;
    this.enabledRight = true;
    this.colorLeft    = [255, 255, 255];
    this.colorRight   = [255, 255, 255];
    this.mode         = 1; // 0=Outline, 1=Filled

    // Animation state — matches C++ constructor initializers
    // _lx/_ly[point][triangle]: 0=positive arm endpoint, 1=negative arm endpoint
    this._lastA = 0;
    this._lx    = [[0, 0], [0, 0]];
    this._ly    = [[0, 0], [0, 0]];
    this._rv    = [Math.PI, 0.0]; // rotation accumulator per triangle
    this._v     = [0.0, 0.0];    // angular velocity per triangle
    this._dir   = [-1.0, 1.0];   // spin direction: triangle 0 CW, triangle 1 CCW

    this._canvas = document.createElement('canvas');
    this._ctx2d  = this._canvas.getContext('2d');
    this._tex    = null;
    this._texW   = 0;
    this._texH   = 0;

    this._prog     = createProgram(gl, vertSrc, FRAG);
    this._uInput   = gl.getUniformLocation(this._prog, 'uInput');
    this._uOverlay = gl.getUniformLocation(this._prog, 'uOverlay');
  }

  _ensureTex(gl, w, h) {
    if (this._texW === w && this._texH === h) return;
    this._texW = w; this._texH = h;
    this._canvas.width  = w;
    this._canvas.height = h;
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

    this._ensureTex(gl, w, h);

    const c2d = this._ctx2d;
    c2d.clearRect(0, 0, w, h);

    // Screen size: fits inside half-height or 3/8 of width, whichever is smaller
    const screenSize = Math.min(Math.trunc(h / 2), Math.trunc((w * 3) / 8));
    const cy = Math.trunc(h / 2);

    for (let tri = 0; tri < 2; tri++) {
      // Matches C++: triangle=0 → enabled_right check; triangle=1 → enabled_left check.
      // triangle=0: left-of-center, clockwise, left spectrum channel, color_left
      // triangle=1: right-of-center, counter-clockwise, right spectrum channel, color_right
      if (!(tri ? this.enabledLeft : this.enabledRight)) continue;

      const faData = visdata[0][tri]; // spectrum: channel 0=left, 1=right
      const [cr, cg, cb] = tri ? this.colorRight : this.colorLeft;
      const cssColor = `rgb(${cr},${cg},${cb})`;

      // C++: !triangle ? w/2 - screen_size/2 : w/2 + screen_size/2
      const cx = tri === 0
        ? Math.trunc(w / 2) - Math.trunc(screenSize / 2)
        : Math.trunc(w / 2) + Math.trunc(screenSize / 2);

      // Sum first 44 spectrum bins for bass energy
      let d = 0;
      for (let x = 0; x < 44; x++) d += faData[x];

      // Normalize by smoothed previous value (_lastA shared across triangles, matches C++)
      let a = Math.trunc((d * 512) / (this._lastA + 30 * 256));
      this._lastA = d;
      if (a > 255) a = 255;

      // Exponential velocity smoothing; max(a-104,12) ensures a minimum spin speed
      this._v[tri] = 0.7 * (Math.max(a - 104, 12) / 96.0) + 0.3 * this._v[tri];
      this._rv[tri] += Math.PI / 6.0 * this._v[tri] * this._dir[tri];

      // Arm endpoint: amplitude-scaled radius at current angle
      const sizeF = screenSize * a / 256.0;
      const xp = Math.trunc(Math.cos(this._rv[tri]) * sizeF);
      const yp = Math.trunc(Math.sin(this._rv[tri]) * sizeF);

      // Positive and negative arm endpoints (180° apart)
      const px0 = cx + xp, py0 = cy + yp;
      const px1 = cx - xp, py1 = cy - yp;

      if (this.mode === 0) {
        // Outline: two spokes from center + trailing arc line between frames
        c2d.strokeStyle = cssColor;
        c2d.lineWidth   = 1;

        if (this._lx[0][tri] || this._ly[0][tri]) {
          c2d.beginPath();
          c2d.moveTo(this._lx[0][tri], this._ly[0][tri]);
          c2d.lineTo(px0, py0);
          c2d.stroke();
        }
        this._lx[0][tri] = px0; this._ly[0][tri] = py0;
        c2d.beginPath(); c2d.moveTo(cx, cy); c2d.lineTo(px0, py0); c2d.stroke();

        if (this._lx[1][tri] || this._ly[1][tri]) {
          c2d.beginPath();
          c2d.moveTo(this._lx[1][tri], this._ly[1][tri]);
          c2d.lineTo(px1, py1);
          c2d.stroke();
        }
        this._lx[1][tri] = px1; this._ly[1][tri] = py1;
        c2d.beginPath(); c2d.moveTo(cx, cy); c2d.lineTo(px1, py1); c2d.stroke();
      } else {
        // Filled: sweep filled triangle (center, prev_tip, current_tip) each frame
        c2d.fillStyle = cssColor;

        if (this._lx[0][tri] || this._ly[0][tri]) {
          c2d.beginPath();
          c2d.moveTo(cx, cy);
          c2d.lineTo(this._lx[0][tri], this._ly[0][tri]);
          c2d.lineTo(px0, py0);
          c2d.closePath();
          c2d.fill();
        }
        this._lx[0][tri] = px0; this._ly[0][tri] = py0;

        if (this._lx[1][tri] || this._ly[1][tri]) {
          c2d.beginPath();
          c2d.moveTo(cx, cy);
          c2d.lineTo(this._lx[1][tri], this._ly[1][tri]);
          c2d.lineTo(px1, py1);
          c2d.closePath();
          c2d.fill();
        }
        this._lx[1][tri] = px1; this._ly[1][tri] = py1;
      }
    }

    // Upload canvas as overlay texture and composite over input
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._canvas);

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
      enabledLeft:  this.enabledLeft,
      enabledRight: this.enabledRight,
      colorLeft:    [...this.colorLeft],
      colorRight:   [...this.colorRight],
      mode:         this.mode,
    };
  }

  setConfig(cfg) {
    if (cfg.enabledLeft  !== undefined) this.enabledLeft  = cfg.enabledLeft;
    if (cfg.enabledRight !== undefined) this.enabledRight = cfg.enabledRight;
    if (cfg.colorLeft    !== undefined) this.colorLeft    = [...cfg.colorLeft];
    if (cfg.colorRight   !== undefined) this.colorRight   = [...cfg.colorRight];
    if (cfg.mode         !== undefined) this.mode         = cfg.mode;
  }

  getDescriptor() {
    return {
      name: 'Bass Spin',
      params: [
        { name: 'enabledLeft',  label: 'Enabled Left',  type: 'bool',   default: true },
        { name: 'enabledRight', label: 'Enabled Right', type: 'bool',   default: true },
        { name: 'colorLeft',    label: 'Color Left',    type: 'color',  default: [255, 255, 255] },
        { name: 'colorRight',   label: 'Color Right',   type: 'color',  default: [255, 255, 255] },
        { name: 'mode',         label: 'Mode',          type: 'select',
          options: [
            { value: 0, label: 'Outline' },
            { value: 1, label: 'Filled'  },
          ], default: 1 },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._tex) this.gl.deleteTexture(this._tex);
  }
}
