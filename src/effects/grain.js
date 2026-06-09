import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Grain: per-pixel multiplicative darkening, matching the original's fastrandbyte() logic.
//
// Each non-black pixel independently rolls two dice:
//   prob  < amount/100  → apply grain; scale the pixel by a random factor 0..1
//   prob >= amount/100  → c = 0 (black)
// Then blend c with the original pixel via the selected blend mode.
//
// "Static" freezes the per-pixel noise pattern (frame-independent hash), matching
// the original's pre-computed depth_buffer[2] (scale + threshold per pixel).

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform int   uAmount;    // 0–100
uniform int   uBlendMode; // 0=Replace, 1=Additive, 2=50/50
uniform int   uStatic;    // 1=freeze pattern, 0=animate
uniform float uFrame;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec3 src = texture(uInput, vUv).rgb;

  // Black pixels are skipped entirely, matching the original's if(*p) guard.
  if (dot(src, src) == 0.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Static: noise fixed per-pixel. Dynamic: seed shifts every frame.
  vec2 seed = (uStatic != 0)
    ? vUv
    : vUv + vec2(fract(uFrame * 0.1376), fract(uFrame * 0.2141));
  float prob  = hash(seed);
  float scale = hash(seed + vec2(5.3, 9.1));

  // c = pixel * scale if selected, else 0 — matching original's p*s/256 path.
  float threshold = float(uAmount) / 100.0;
  vec3 c = (prob < threshold) ? src * scale : vec3(0.0);

  if (uBlendMode == 1) {        // Additive: grain brightens; unselected pixels unchanged
    fragColor = vec4(min(src + c, vec3(1.0)), 1.0);
  } else if (uBlendMode == 2) { // 50/50: average of original and grain-scaled
    fragColor = vec4((src + c) * 0.5, 1.0);
  } else {                      // Replace: grain-scaled pixel (black if unselected)
    fragColor = vec4(c, 1.0);
  }
}`;

export class GrainEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.amount    = 100;
    this.blendMode = 0;
    this.isStatic  = false;

    this._prog    = createProgram(gl, vertSrc, FRAG);
    this._uInput  = gl.getUniformLocation(this._prog, 'uInput');
    this._uAmount = gl.getUniformLocation(this._prog, 'uAmount');
    this._uBlend  = gl.getUniformLocation(this._prog, 'uBlendMode');
    this._uStatic = gl.getUniformLocation(this._prog, 'uStatic');
    this._uFrame  = gl.getUniformLocation(this._prog, 'uFrame');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO, frame } = ctx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput,  0);
    gl.uniform1i(this._uAmount, this.amount);
    gl.uniform1i(this._uBlend,  this.blendMode);
    gl.uniform1i(this._uStatic, this.isStatic ? 1 : 0);
    gl.uniform1f(this._uFrame,  frame);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return { amount: this.amount, blendMode: this.blendMode, isStatic: this.isStatic };
  }

  setConfig(cfg) {
    if (cfg.amount    !== undefined) this.amount    = Math.round(Math.max(0, Math.min(100, cfg.amount)));
    if (cfg.blendMode !== undefined) this.blendMode = cfg.blendMode;
    if (cfg.isStatic  !== undefined) this.isStatic  = !!cfg.isStatic;
  }

  getDescriptor() {
    return {
      name: 'Grain',
      params: [
        { name: 'amount',    label: 'Amount',     type: 'range',  min: 0, max: 100, step: 1, default: 100 },
        { name: 'blendMode', label: 'Blend Mode', type: 'select', options: [
          { value: 0, label: 'Replace' },
          { value: 1, label: 'Additive' },
          { value: 2, label: '50/50' },
        ], default: 0 },
        { name: 'isStatic', label: 'Static', type: 'bool', default: false },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
