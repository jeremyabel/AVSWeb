import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform float uBrightness;
uniform float uContrast;
out vec4 fragColor;
void main() {
  vec3 c = texture(uInput, vUv).rgb;
  c = (c - 0.5) * uContrast + 0.5 + uBrightness;
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export class BrightnessEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.brightness = 0.0;   // -1..1
    this.contrast   = 1.0;   // 0..3
    this._prog = createProgram(gl, vertSrc, FRAG);
    this._uInput      = gl.getUniformLocation(this._prog, 'uInput');
    this._uBrightness = gl.getUniformLocation(this._prog, 'uBrightness');
    this._uContrast   = gl.getUniformLocation(this._prog, 'uContrast');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1f(this._uBrightness, this.brightness);
    gl.uniform1f(this._uContrast, this.contrast);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return { brightness: this.brightness, contrast: this.contrast }; }
  setConfig(cfg) {
    if (cfg.brightness !== undefined) this.brightness = cfg.brightness;
    if (cfg.contrast   !== undefined) this.contrast   = cfg.contrast;
  }

  getDescriptor() {
    return {
      name: 'Brightness',
      params: [
        { name: 'brightness', label: 'Brightness', type: 'range', min: -1, max: 1, step: 0.01, default: 0 },
        { name: 'contrast',   label: 'Contrast',   type: 'range', min: 0,  max: 3, step: 0.01, default: 1 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
