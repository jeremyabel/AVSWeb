import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Three match modes, each replacing the pixel with clipOut when triggered:
//   Below: all channels <= clipIn
//   Above: all channels >= clipIn
//   Near:  RGB Euclidean distance from clipIn <= color_dist * 2   (in 0-255 space)

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform int   uMode;       // 1=below, 2=above, 3=near
uniform vec3  uClipIn;     // threshold color (0..1)
uniform vec3  uClipOut;    // replacement color (0..1)
uniform float uRadiusSq;   // squared distance threshold (0..1 space) for near mode
out vec4 fragColor;
void main() {
  vec3 c = texture(uInput, vUv).rgb;
  bool match;
  if (uMode == 1) {
    match = c.r <= uClipIn.r && c.g <= uClipIn.g && c.b <= uClipIn.b;
  } else if (uMode == 2) {
    match = c.r >= uClipIn.r && c.g >= uClipIn.g && c.b >= uClipIn.b;
  } else {
    vec3 d = c - uClipIn;
    match = dot(d, d) <= uRadiusSq;
  }
  fragColor = vec4(match ? uClipOut : c, 1.0);
}`;

const MODE_OPTIONS = [
  { value: 1, label: 'Below' },
  { value: 2, label: 'Above' },
  { value: 3, label: 'Near'  },
];

export class ContrastEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.mode     = 1;
    this.clipIn   = [32, 32, 32];
    this.clipOut  = [32, 32, 32];
    this.distance = 10;   // 0-64; near-mode radius = distance * 2 (in 0-255 space)

    this._prog      = createProgram(gl, vertSrc, FRAG);
    this._uInput    = gl.getUniformLocation(this._prog, 'uInput');
    this._uMode     = gl.getUniformLocation(this._prog, 'uMode');
    this._uClipIn   = gl.getUniformLocation(this._prog, 'uClipIn');
    this._uClipOut  = gl.getUniformLocation(this._prog, 'uClipOut');
    this._uRadiusSq = gl.getUniformLocation(this._prog, 'uRadiusSq');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;

    // Near-mode: threshold is (distance * 2) in 0-255 space → convert to 0-1.
    const radius   = (this.distance * 2) / 255;
    const radiusSq = radius * radius;

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1i(this._uMode, this.mode);
    gl.uniform3f(this._uClipIn,  this.clipIn[0]  / 255, this.clipIn[1]  / 255, this.clipIn[2]  / 255);
    gl.uniform3f(this._uClipOut, this.clipOut[0] / 255, this.clipOut[1] / 255, this.clipOut[2] / 255);
    gl.uniform1f(this._uRadiusSq, radiusSq);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return {
      mode:     this.mode,
      clipIn:   [...this.clipIn],
      clipOut:  [...this.clipOut],
      distance: this.distance,
    };
  }

  setConfig(cfg) {
    if (cfg.mode     !== undefined) this.mode     = cfg.mode;
    if (cfg.clipIn)                  this.clipIn   = cfg.clipIn;
    if (cfg.clipOut)                 this.clipOut  = cfg.clipOut;
    if (cfg.distance !== undefined) this.distance = cfg.distance;
  }

  getDescriptor() {
    return {
      name: 'Contrast',
      params: [
        { name: 'mode',     label: 'Mode',           type: 'select', options: MODE_OPTIONS, default: 1 },
        { name: 'clipIn',   label: 'Threshold Color', type: 'color',  default: [32, 32, 32] },
        { name: 'clipOut',  label: 'Output Color',    type: 'color',  default: [32, 32, 32] },
        { name: 'distance', label: 'Near Distance',   type: 'range',  min: 0, max: 64, step: 1, default: 10 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
