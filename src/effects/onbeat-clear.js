import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Clears the framebuffer to a solid colour on every nf-th beat.
// blend=false: full replace (rep stosd in original).
// blend=true:  BLEND_AVG — 50/50 average of existing pixel and colour.
// nf=0 disables the effect entirely (matches original `if (nf && …)` guard).

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform vec3 uColor;
uniform int  uBlend;
out vec4 fragColor;

void main() {
  if (uBlend == 1) {
    vec3 orig = texture(uInput, vUv).rgb;
    fragColor = vec4((orig + uColor) * 0.5, 1.0);
  } else {
    fragColor = vec4(uColor, 1.0);
  }
}`;

export class OnBeatClearEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.color = [255, 255, 255];
    this.blend = false;
    this.nf    = 1;   // clear every N beats; 0 = disabled

    this._cf = 0;   // beats-since-last-clear counter
    this._df = 0;   // non-beat-frames counter (mirrors original state)

    this._prog   = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uColor = gl.getUniformLocation(this._prog, 'uColor');
    this._uBlend = gl.getUniformLocation(this._prog, 'uBlend');
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;

    if (isBeat) {
      // Short-circuit when nf=0 (matches original `if (nf && ++cf >= nf)`)
      if (this.nf && ++this._cf >= this.nf) {
        this._cf = this._df = 0;

        gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
        gl.viewport(0, 0, fboManager.w, fboManager.h);
        gl.useProgram(this._prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, inputTex);
        gl.uniform1i(this._uInput, 0);
        gl.uniform3f(this._uColor,
          this.color[0] / 255,
          this.color[1] / 255,
          this.color[2] / 255);
        gl.uniform1i(this._uBlend, this.blend ? 1 : 0);
        const vao = getQuadVAO(gl);
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindVertexArray(null);
        fboManager.swap();
      }
    } else {
      // Non-beat: just maintain the df counter (original had a commented-out memset here)
      if (++this._df >= this.nf) this._df = 0;
    }
  }

  getConfig() {
    return {
      color: [...this.color],
      blend: this.blend,
      nf:    this.nf,
    };
  }

  setConfig(cfg) {
    if (cfg.color !== undefined) this.color = cfg.color;
    if (cfg.blend !== undefined) this.blend = cfg.blend;
    if (cfg.nf    !== undefined) this.nf    = Math.max(0, Math.min(100, cfg.nf));
  }

  getDescriptor() {
    return {
      name: 'OnBeat Clear',
      params: [
        { name: 'color', label: 'Color',        type: 'color', default: [255, 255, 255] },
        { name: 'blend', label: 'Blend',         type: 'bool',  default: false },
        { name: 'nf',    label: 'Every N Beats', type: 'range', min: 0, max: 100, step: 1, default: 1 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
