import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform int   uNPoints;
uniform vec2  uOffsets[8];  // per-point UV-space offsets
uniform float uAlpha;       // 0..1 weight per sample
uniform int   uRGB;         // 1 = RGB-separation mode (3 or 6 pts only)
uniform int   uOutBlend;    // 0=replace  1=additive  2=average
out vec4 fragColor;

void main() {
  vec4 orig = texture(uInput, vUv);

  if (uNPoints == 0) { fragColor = orig; return; }

  vec3 col = vec3(0.0);

  if (uRGB == 1) {
    // Each of the first 3 points contributes only one colour channel (B, G, R).
    // With 6 points, the second triplet (3,4,5) adds to the same channels.
    vec3 s0 = texture(uInput, clamp(vUv - uOffsets[0], 0.0, 1.0)).rgb;
    vec3 s1 = texture(uInput, clamp(vUv - uOffsets[1], 0.0, 1.0)).rgb;
    vec3 s2 = texture(uInput, clamp(vUv - uOffsets[2], 0.0, 1.0)).rgb;
    col.b = s0.b * uAlpha;
    col.g = s1.g * uAlpha;
    col.r = s2.r * uAlpha;
    if (uNPoints == 6) {
      vec3 s3 = texture(uInput, clamp(vUv - uOffsets[3], 0.0, 1.0)).rgb;
      vec3 s4 = texture(uInput, clamp(vUv - uOffsets[4], 0.0, 1.0)).rgb;
      vec3 s5 = texture(uInput, clamp(vUv - uOffsets[5], 0.0, 1.0)).rgb;
      col.b = clamp(col.b + s3.b * uAlpha, 0.0, 1.0);
      col.g = clamp(col.g + s4.g * uAlpha, 0.0, 1.0);
      col.r = clamp(col.r + s5.r * uAlpha, 0.0, 1.0);
    }
  } else {
    // Normal mode: accumulate all channels from every point.
    for (int i = 0; i < 8; i++) {
      if (i >= uNPoints) break;
      col += texture(uInput, clamp(vUv - uOffsets[i], 0.0, 1.0)).rgb * uAlpha;
    }
    col = clamp(col, 0.0, 1.0);
  }

  vec3 out_col;
  if      (uOutBlend == 1) out_col = clamp(orig.rgb + col, 0.0, 1.0);
  else if (uOutBlend == 2) out_col = (orig.rgb + col) * 0.5;
  else                     out_col = col;

  fragColor = vec4(out_col, 1.0);
}`;

const OUT_BLEND_OPTIONS = [
  { value: 0, label: 'Replace'  },
  { value: 1, label: 'Additive' },
  { value: 2, label: 'Average'  },
];

export class InterferencesEffect extends Effect {
  constructor(gl) {
    super(gl);
    // Base state
    this.nPoints      = 2;
    this.distance     = 10;
    this.alpha        = 128;
    this.rotation     = 0;      // 0-255, accumulates per-frame
    this.rotationinc  = 0;      // -32..32, base rotation speed
    // Beat target state
    this.distance2    = 32;
    this.alpha2       = 192;
    this.rotationinc2 = 25;     // -32..32
    // Misc
    this.rgb          = true;
    this.outBlend     = 0;      // 0=replace 1=additive 2=average
    this.onbeat       = true;
    this.speed        = 0.2;    // 0.01-1.28

    this._status = Math.PI;     // beat oscillation phase; starts at π (resting)

    this._prog      = createProgram(gl, vertSrc, FRAG);
    this._uInput    = gl.getUniformLocation(this._prog, 'uInput');
    this._uNPoints  = gl.getUniformLocation(this._prog, 'uNPoints');
    this._uOffsets  = gl.getUniformLocation(this._prog, 'uOffsets');
    this._uAlpha    = gl.getUniformLocation(this._prog, 'uAlpha');
    this._uRGB      = gl.getUniformLocation(this._prog, 'uRGB');
    this._uOutBlend = gl.getUniformLocation(this._prog, 'uOutBlend');
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    // On beat: kick the oscillator back to 0 (only if it has finished its previous cycle)
    if (isBeat && this.onbeat && this._status >= Math.PI) {
      this._status = 0;
    }

    // sin(status) rises from 0→1→0 over one π cycle, giving a smooth pulse
    const s       = Math.sin(this._status);
    const _rotinc = this.rotationinc + (this.rotationinc2 - this.rotationinc) * s;
    const _alpha  = this.alpha       + (this.alpha2       - this.alpha)       * s;
    const _dist   = this.distance    + (this.distance2    - this.distance)    * s;

    // Compute radially-distributed point offsets in UV space
    const a0        = (this.rotation / 255) * Math.PI * 2;
    const angleStep = this.nPoints > 0 ? (2 * Math.PI) / this.nPoints : 0;
    const offsets   = new Float32Array(16); // 8 × vec2
    for (let i = 0; i < this.nPoints && i < 8; i++) {
      const a = a0 + i * angleStep;
      offsets[i * 2]     = Math.cos(a) * _dist / w;
      offsets[i * 2 + 1] = Math.sin(a) * _dist / h;
    }

    // Advance rotation (matches original single-step wrap: subtract/add 255, not full modulo)
    this.rotation += _rotinc;
    if (this.rotation >  255) this.rotation -= 255;
    if (this.rotation < -255) this.rotation += 255;

    // Advance oscillation phase
    this._status += this.speed;
    if (this._status > Math.PI)  this._status = Math.PI;
    if (this._status < -Math.PI) this._status = Math.PI;

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput,   0);
    gl.uniform1i(this._uNPoints, this.nPoints);
    gl.uniform2fv(this._uOffsets, offsets);
    gl.uniform1f(this._uAlpha,   _alpha / 255);
    // RGB mode only applies when exactly 3 or 6 points are active
    gl.uniform1i(this._uRGB,     (this.rgb && (this.nPoints === 3 || this.nPoints === 6)) ? 1 : 0);
    gl.uniform1i(this._uOutBlend, this.outBlend);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return {
      nPoints:      this.nPoints,
      distance:     this.distance,
      alpha:        this.alpha,
      rotation:     Math.round(this.rotation),
      rotationinc:  this.rotationinc,
      distance2:    this.distance2,
      alpha2:       this.alpha2,
      rotationinc2: this.rotationinc2,
      rgb:          this.rgb,
      outBlend:     this.outBlend,
      onbeat:       this.onbeat,
      speed:        this.speed,
    };
  }

  setConfig(cfg) {
    if (cfg.nPoints      !== undefined) this.nPoints      = cfg.nPoints;
    if (cfg.distance     !== undefined) this.distance     = cfg.distance;
    if (cfg.alpha        !== undefined) this.alpha        = cfg.alpha;
    if (cfg.rotation     !== undefined) this.rotation     = cfg.rotation;
    if (cfg.rotationinc  !== undefined) this.rotationinc  = cfg.rotationinc;
    if (cfg.distance2    !== undefined) this.distance2    = cfg.distance2;
    if (cfg.alpha2       !== undefined) this.alpha2       = cfg.alpha2;
    if (cfg.rotationinc2 !== undefined) this.rotationinc2 = cfg.rotationinc2;
    if (cfg.rgb          !== undefined) this.rgb          = cfg.rgb;
    if (cfg.outBlend     !== undefined) this.outBlend     = cfg.outBlend;
    if (cfg.onbeat       !== undefined) this.onbeat       = cfg.onbeat;
    if (cfg.speed        !== undefined) this.speed        = cfg.speed;
  }

  getDescriptor() {
    return {
      name: 'Interferences',
      params: [
        { name: 'nPoints',      label: 'Num Points',          type: 'range',  min: 0,    max: 8,    step: 1,    default: 2    },
        { name: 'alpha',        label: 'Alpha',               type: 'range',  min: 1,    max: 255,  step: 1,    default: 128  },
        { name: 'distance',     label: 'Distance',            type: 'range',  min: 1,    max: 64,   step: 1,    default: 10   },
        { name: 'rotationinc',  label: 'Rotation Speed',      type: 'range',  min: -32,  max: 32,   step: 1,    default: 0    },
        { name: 'alpha2',       label: 'Alpha (On Beat)',      type: 'range',  min: 1,    max: 255,  step: 1,    default: 192  },
        { name: 'distance2',    label: 'Distance (On Beat)',   type: 'range',  min: 1,    max: 64,   step: 1,    default: 32   },
        { name: 'rotationinc2', label: 'Rot Speed (On Beat)',  type: 'range',  min: -32,  max: 32,   step: 1,    default: 25   },
        { name: 'rotation',     label: 'Initial Rotation',    type: 'range',  min: 0,    max: 255,  step: 1,    default: 0    },
        { name: 'speed',        label: 'Beat Speed',          type: 'range',  min: 0.01, max: 1.28, step: 0.01, default: 0.2  },
        { name: 'onbeat',       label: 'On Beat',             type: 'bool',   default: true  },
        { name: 'rgb',          label: 'RGB Separation',      type: 'bool',   default: true  },
        { name: 'outBlend',     label: 'Output Blend',        type: 'select', options: OUT_BLEND_OPTIONS, default: 0 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
