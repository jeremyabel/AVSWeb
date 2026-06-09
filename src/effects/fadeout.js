import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform float uFade;
uniform vec3 uColor;
out vec4 fragColor;
void main() {
  vec3 c = texture(uInput, vUv).rgb;
  c = mix(uColor, c, uFade);
  fragColor = vec4(c, 1.0);
}
`;

export class FadeoutEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.fade = 0.92;   // 1.0 = no fade, 0.0 = instant black
    this.color = [0, 0, 0];
    this._prog = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uFade  = gl.getUniformLocation(this._prog, 'uFade');
    this._uColor = gl.getUniformLocation(this._prog, 'uColor');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1f(this._uFade, this.fade);
    gl.uniform3f(this._uColor, this.color[0]/255, this.color[1]/255, this.color[2]/255);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return { fade: this.fade, color: [...this.color] }; }
  setConfig(cfg) {
    if (cfg.fade !== undefined) this.fade = cfg.fade;
    if (cfg.color) this.color = cfg.color;
  }

  getDescriptor() {
    return {
      name: 'Fadeout',
      params: [
        { name: 'fade', label: 'Fade Speed', type: 'range', min: 0.5, max: 1.0, step: 0.005, default: 0.92 },
        { name: 'color', label: 'Fade Color', type: 'color', default: [0,0,0] },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
