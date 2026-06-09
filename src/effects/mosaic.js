import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform vec2 uResolution;
uniform float uBlockSize;
out vec4 fragColor;
void main() {
  vec2 px = floor(vUv * uResolution / uBlockSize) * uBlockSize + uBlockSize * 0.5;
  fragColor = texture(uInput, px / uResolution);
}
`;

export class MosaicEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.blockSize = 8;
    this._prog = createProgram(gl, vertSrc, FRAG);
    this._uInput      = gl.getUniformLocation(this._prog, 'uInput');
    this._uResolution = gl.getUniformLocation(this._prog, 'uResolution');
    this._uBlockSize  = gl.getUniformLocation(this._prog, 'uBlockSize');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform2f(this._uResolution, fboManager.w, fboManager.h);
    gl.uniform1f(this._uBlockSize, this.blockSize);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return { blockSize: this.blockSize }; }
  setConfig(cfg) { if (cfg.blockSize !== undefined) this.blockSize = cfg.blockSize; }

  getDescriptor() {
    return {
      name: 'Mosaic',
      params: [
        { name: 'blockSize', label: 'Block Size', type: 'range', min: 1, max: 64, step: 1, default: 8 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
