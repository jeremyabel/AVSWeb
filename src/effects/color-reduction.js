import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Original: mask = (0xFF << (8-levels)) & 0xFF applied to each channel byte.
// Equivalent in float space: floor(c * 2^levels) / 2^levels
// levels 1 = 2 values per channel (very posterized)
// levels 8 = 256 values per channel (no change)

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform float uLevels;   // 2^config.levels, precomputed on JS side
out vec4 fragColor;
void main() {
  vec3 c = texture(uInput, vUv).rgb;
  fragColor = vec4(floor(c * uLevels) / uLevels, 1.0);
}`;

export class ColorReductionEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.levels = 7;   // 1..8; default 7 = 128 values per channel

    this._prog    = createProgram(gl, vertSrc, FRAG);
    this._uInput  = gl.getUniformLocation(this._prog, 'uInput');
    this._uLevels = gl.getUniformLocation(this._prog, 'uLevels');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1f(this._uLevels, Math.pow(2, this.levels));
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return { levels: this.levels }; }
  setConfig(cfg) { if (cfg.levels !== undefined) this.levels = cfg.levels; }

  getDescriptor() {
    return {
      name: 'Color Reduction',
      params: [
        { name: 'levels', label: 'Levels (bits)', type: 'range', min: 1, max: 8, step: 1, default: 7 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
