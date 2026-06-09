import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Maps each pixel to a single colour tone at the pixel's original luminance.
// "depth" = max(R,G,B) of the input pixel (HSV Value), optionally inverted.
// Output = color * depth.

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform vec3 uColor;    // tint colour (0..1)
uniform int  uInvert;   // 0=normal  1=invert depth
uniform int  uBlend;    // 0=replace  1=additive  2=average
out vec4 fragColor;

void main() {
  vec3 orig = texture(uInput, vUv).rgb;

  // Depth = maximum channel (HSV Value), matching original depthof()
  float depth = max(orig.r, max(orig.g, orig.b));
  if (uInvert == 1) depth = 1.0 - depth;

  vec3 tinted = uColor * depth;

  vec3 out_col;
  if      (uBlend == 1) out_col = clamp(orig + tinted, 0.0, 1.0);
  else if (uBlend == 2) out_col = (orig + tinted) * 0.5;
  else                  out_col = tinted;

  fragColor = vec4(out_col, 1.0);
}`;

const BLEND_OPTIONS = [
  { value: 0, label: 'Replace'  },
  { value: 1, label: 'Additive' },
  { value: 2, label: 'Average'  },
];

export class UniqueToneEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.color    = [255, 255, 255]; // default white (0xFFFFFF in original)
    this.invert   = false;
    this.outBlend = 0;

    this._prog    = createProgram(gl, vertSrc, FRAG);
    this._uInput  = gl.getUniformLocation(this._prog, 'uInput');
    this._uColor  = gl.getUniformLocation(this._prog, 'uColor');
    this._uInvert = gl.getUniformLocation(this._prog, 'uInvert');
    this._uBlend  = gl.getUniformLocation(this._prog, 'uBlend');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput,  0);
    gl.uniform3f(this._uColor,  this.color[0] / 255, this.color[1] / 255, this.color[2] / 255);
    gl.uniform1i(this._uInvert, this.invert ? 1 : 0);
    gl.uniform1i(this._uBlend,  this.outBlend);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return {
      color:    [...this.color],
      invert:   this.invert,
      outBlend: this.outBlend,
    };
  }

  setConfig(cfg) {
    if (cfg.color    !== undefined) this.color    = cfg.color;
    if (cfg.invert   !== undefined) this.invert   = cfg.invert;
    if (cfg.outBlend !== undefined) this.outBlend = cfg.outBlend;
  }

  getDescriptor() {
    return {
      name: 'Unique Tone',
      params: [
        { name: 'color',    label: 'Color',  type: 'color',  default: [255, 255, 255] },
        { name: 'invert',   label: 'Invert', type: 'bool',   default: false },
        { name: 'outBlend', label: 'Blend',  type: 'select', options: BLEND_OPTIONS, default: 0 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
