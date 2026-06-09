import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Convolution filter: applies a 7x7 integer kernel to each pixel.
//
// Per-pass combination (matching the original's MMX per-pass logic):
//   default:  psubusw → max(pos_sum - neg_sum, 0)  i.e. saturate to zero
//   wrap:     psubw   → pos_sum - neg_sum (signed, can go negative)
//   absolute: psubsw + bit trick → abs(pos_sum - neg_sum)
//
// Two-pass: apply the kernel a second time with offsets rotated 90° CCW
//   (kernel[row][col] reads from (3-row, col-3) instead of (col-3, row-3)).
//   Each pass is independently processed (clamped/wrapped/absed), then
//   combined as psubusw(pass1, pass0) = max(pass1 - pass0, 0). Scale
//   is applied after the combination.

const DIM = 7;
const N   = DIM * DIM; // 49

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform int uKernel[49];
uniform float uBias;
uniform float uScale;
uniform int uWrap;
uniform int uAbsolute;
uniform int uTwoPass;
uniform vec2 uTexelSize;
out vec4 fragColor;

vec3 doPass(bool rotated) {
  vec3 acc = vec3(0.0);
  for (int row = 0; row < 7; row++) {
    for (int col = 0; col < 7; col++) {
      float w = float(uKernel[row * 7 + col]);
      vec2 off;
      if (rotated) {
        // 90° CCW rotation: kernel[row][col] reads from (3-row, col-3)
        off = vec2(float(3 - row), float(col - 3));
      } else {
        off = vec2(float(col - 3), float(row - 3));
      }
      acc += w * texture(uInput, vUv + off * uTexelSize).rgb;
    }
  }
  return acc;
}

// Apply the per-pass combination that matches the original's MMX psubusw/psubw/psubsw.
// s = raw signed weighted sum (pos_weights*pixels - neg_weights*pixels) + bias.
vec3 perPass(vec3 s) {
  if (uAbsolute == 1) return abs(s);
  if (uWrap    == 1) return s;       // psubw: signed, no saturation
  return max(s, 0.0);                // psubusw: saturate to zero
}

void main() {
  vec3 s0 = doPass(false) + uBias;

  vec3 raw;
  if (uTwoPass == 1) {
    vec3 s1 = doPass(true) + uBias;
    // Each pass independently saturated/wrapped/absed, then combined with
    // a final saturating subtract (psubusw): max(pass1 - pass0, 0).
    raw = max(perPass(s1) - perPass(s0), 0.0) / uScale;
  } else {
    raw = perPass(s0) / uScale;
  }

  vec3 result;
  if (uAbsolute == 1) {
    result = clamp(raw, 0.0, 1.0);   // perPass already took abs; just clamp
  } else if (uWrap == 1) {
    result = clamp(raw, 0.0, 1.0);
  } else {
    result = clamp(raw, 0.0, 1.0);
  }

  fragColor = vec4(result, 1.0);
}`;

export class ConvolutionEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.kernel   = new Array(N).fill(0);
    this.kernel[24] = 1; // identity: centre cell = 1
    this.wrap      = false;
    this.absolute  = false;
    this.twoPass   = false;
    this.bias      = 0;
    this.scale     = 1;

    this._prog      = createProgram(gl, vertSrc, FRAG);
    this._uInput    = gl.getUniformLocation(this._prog, 'uInput');
    this._uKernel   = gl.getUniformLocation(this._prog, 'uKernel[0]');
    this._uBias     = gl.getUniformLocation(this._prog, 'uBias');
    this._uScale    = gl.getUniformLocation(this._prog, 'uScale');
    this._uWrap     = gl.getUniformLocation(this._prog, 'uWrap');
    this._uAbsolute = gl.getUniformLocation(this._prog, 'uAbsolute');
    this._uTwoPass  = gl.getUniformLocation(this._prog, 'uTwoPass');
    this._uTexSize  = gl.getUniformLocation(this._prog, 'uTexelSize');
  }

  autoscale() {
    let sum = this.kernel.reduce((a, b) => a + b, 0) + this.bias;
    if (this.twoPass) sum *= 2;
    this.scale = sum === 0 ? 1 : sum;
  }

  saveKernel() {
    const buf  = new ArrayBuffer(220);
    const view = new DataView(buf);
    let pos = 0;
    const wi = v => { view.setInt32(pos, v, true); pos += 4; };
    wi(1); // enabled
    wi(this.wrap     ? 1 : 0);
    wi(this.absolute ? 1 : 0);
    wi(this.twoPass  ? 1 : 0);
    for (const k of this.kernel) wi(k);
    wi(this.bias);
    wi(this.scale);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
    a.download = 'kernel.cff';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  loadKernel(onLoaded) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cff';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        const buf = e.target.result;
        if (buf.byteLength < 220) return;
        const view = new DataView(buf);
        let pos = 0;
        const ri = () => { const v = view.getInt32(pos, true); pos += 4; return v; };
        ri(); // skip enabled
        this.wrap     = ri() !== 0;
        this.absolute = ri() !== 0;
        this.twoPass  = ri() !== 0;
        for (let i = 0; i < 49; i++) this.kernel[i] = ri();
        this.bias  = ri();
        this.scale = ri() || 1;
        onLoaded?.();
      };
      reader.readAsArrayBuffer(file);
    };
    input.click();
  }

  clearKernel() {
    this.kernel.fill(0);
    this.kernel[24] = 1;
    this.wrap     = false;
    this.absolute = false;
    this.twoPass  = false;
    this.bias     = 0;
    this.scale    = 1;
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;
    const scale = this.scale === 0 ? 1 : this.scale;

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);

    gl.uniform1iv(this._uKernel, this.kernel);
    gl.uniform1f(this._uBias,    this.bias * 256 / 255);
    gl.uniform1f(this._uScale,   scale);
    gl.uniform1i(this._uWrap,    this.wrap     ? 1 : 0);
    gl.uniform1i(this._uAbsolute,this.absolute ? 1 : 0);
    gl.uniform1i(this._uTwoPass, this.twoPass  ? 1 : 0);
    gl.uniform2f(this._uTexSize, 1 / w, 1 / h);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return {
      kernel:   [...this.kernel],
      wrap:     this.wrap,
      absolute: this.absolute,
      twoPass:  this.twoPass,
      bias:     this.bias,
      scale:    this.scale,
    };
  }

  setConfig(cfg) {
    if (cfg.kernel !== undefined) {
      this.kernel = cfg.kernel.slice(0, N).map(v => Math.trunc(Number(v)) || 0);
      while (this.kernel.length < N) this.kernel.push(0);
    }
    if (cfg.wrap     !== undefined) { this.wrap     = !!cfg.wrap;     if (this.wrap)     this.absolute = false; }
    if (cfg.absolute !== undefined) { this.absolute = !!cfg.absolute; if (this.absolute) this.wrap     = false; }
    if (cfg.twoPass  !== undefined)   this.twoPass  = !!cfg.twoPass;
    if (cfg.bias     !== undefined)   this.bias     = Math.trunc(Number(cfg.bias)) || 0;
    if (cfg.scale    !== undefined)   this.scale    = Math.trunc(Number(cfg.scale)) || 1;
  }

  getDescriptor() {
    return {
      name: 'Convolution Filter',
      params: [
        { name: 'wrap',        label: 'Wrap',       type: 'bool',   default: false },
        { name: 'absolute',    label: 'Absolute',   type: 'bool',   default: false },
        { name: 'twoPass',     label: 'Two Pass',   type: 'bool',   default: false },
        { name: 'bias',        label: 'Bias',       type: 'int',    default: 0 },
        { name: 'scale',       label: 'Scale',      type: 'int',    default: 1 },
        { name: 'kernel',      label: 'Kernel',     type: 'kernel', size: DIM },
        { name: 'autoscale',   label: 'Auto Scale', type: 'action'      },
        { name: 'clearKernel', label: 'Clear',      type: 'action'      },
        { name: 'saveKernel',  label: 'Save .cff',  type: 'action'      },
        { name: 'loadKernel',  label: 'Load .cff',  type: 'file-action' },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
