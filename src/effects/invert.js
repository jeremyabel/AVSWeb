import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
out vec4 fragColor;
void main() {
  vec3 c = texture(uInput, vUv).rgb;
  fragColor = vec4(1.0 - c, 1.0);
}
`;

export class InvertEffect extends Effect {
  constructor(gl) {
    super(gl);
    this._prog = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return {}; }
  setConfig(_cfg) {}

  getDescriptor() { return { name: 'Invert', params: [] }; }

  destroy() { this.gl.deleteProgram(this._prog); }
}
