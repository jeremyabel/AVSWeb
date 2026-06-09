import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
uniform vec3 uColor;
uniform sampler2D uInput;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = vec4(uColor, 1.0);
}
`;

export class ClearEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.color = [0, 0, 0];
    this._prog = createProgram(gl, vertSrc, FRAG);
    this._uColor = gl.getUniformLocation(this._prog, 'uColor');
  }

  render(ctx) {
    const { gl, fboManager } = ctx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.uniform3f(this._uColor, this.color[0]/255, this.color[1]/255, this.color[2]/255);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return { color: [...this.color] }; }
  setConfig(cfg) { if (cfg.color) this.color = cfg.color; }

  getDescriptor() {
    return {
      name: 'Clear',
      params: [
        { name: 'color', label: 'Color', type: 'color', default: [0,0,0] },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
