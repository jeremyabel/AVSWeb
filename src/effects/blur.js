import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Two-pass separable box blur. Radius grows with intensity setting (1=light, 2=medium, 3=heavy).
const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform vec2 uDir;       // (1/w, 0) or (0, 1/h)
uniform int uRadius;
out vec4 fragColor;
void main() {
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = -uRadius; i <= uRadius; i++) {
    float w = float(uRadius + 1 - abs(i));
    sum += texture(uInput, vUv + uDir * float(i)).rgb * w;
    total += w;
  }
  fragColor = vec4(sum / total, 1.0);
}
`;

export class BlurEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.intensity = 1;  // 1, 2, or 3

    this._prog  = createProgram(gl, vertSrc, FRAG);
    this._uInput  = gl.getUniformLocation(this._prog, 'uInput');
    this._uDir    = gl.getUniformLocation(this._prog, 'uDir');
    this._uRadius = gl.getUniformLocation(this._prog, 'uRadius');

    // Intermediate FBO for the horizontal pass
    this._tmpFBO = null;
    this._tmpTex = null;
  }

  _ensureTmp(gl, w, h) {
    if (this._tmpFBO && this._tmpW === w && this._tmpH === h) return;
    if (this._tmpFBO) { gl.deleteFramebuffer(this._tmpFBO); gl.deleteTexture(this._tmpTex); }
    this._tmpTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._tmpTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._tmpFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._tmpFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._tmpTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._tmpW = w; this._tmpH = h;
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;
    this._ensureTmp(gl, w, h);

    const radius = this.intensity === 3 ? 4 : this.intensity === 2 ? 2 : 1;

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.useProgram(this._prog);
    gl.uniform1i(this._uRadius, radius);

    // Horizontal pass: inputTex → tmpFBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._tmpFBO);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform2f(this._uDir, 1 / w, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Vertical pass: tmpTex → outputFBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.bindTexture(gl.TEXTURE_2D, this._tmpTex);
    gl.uniform2f(this._uDir, 0, 1 / h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return { intensity: this.intensity }; }
  setConfig(cfg) { if (cfg.intensity !== undefined) this.intensity = cfg.intensity; }

  getDescriptor() {
    return {
      name: 'Blur',
      params: [
        { name: 'intensity', label: 'Intensity', type: 'select',
          options: [{ value: 1, label: 'Light' }, { value: 2, label: 'Medium' }, { value: 3, label: 'Heavy' }],
          default: 1 },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._tmpFBO) this.gl.deleteFramebuffer(this._tmpFBO);
    if (this._tmpTex) this.gl.deleteTexture(this._tmpTex);
  }
}
