import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform int uMode;  // bitmask: 1=flipX, 2=flipY
out vec4 fragColor;
void main() {
  vec2 uv = vUv;
  if ((uMode & 1) != 0) uv.x = 1.0 - uv.x;
  if ((uMode & 2) != 0) uv.y = 1.0 - uv.y;
  fragColor = texture(uInput, uv);
}
`;

export class MirrorEffect extends Effect {
  constructor(gl) {
    super(gl);
    // mode bitmask: 1=flipX, 2=flipY, 4=onBeat toggle
    this.flipX  = true;
    this.flipY  = false;
    this.onBeat = false;
    this._beatActive = false;
    this._prog = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uMode  = gl.getUniformLocation(this._prog, 'uMode');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO, isBeat } = ctx;

    if (this.onBeat && isBeat) this._beatActive = !this._beatActive;

    let fx = this.flipX, fy = this.flipY;
    if (this.onBeat && this._beatActive) { fx = !fx; fy = !fy; }

    const mode = (fx ? 1 : 0) | (fy ? 2 : 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1i(this._uMode, mode);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return { flipX: this.flipX, flipY: this.flipY, onBeat: this.onBeat }; }
  setConfig(cfg) {
    if (cfg.flipX  !== undefined) this.flipX  = cfg.flipX;
    if (cfg.flipY  !== undefined) this.flipY  = cfg.flipY;
    if (cfg.onBeat !== undefined) this.onBeat = cfg.onBeat;
  }

  getDescriptor() {
    return {
      name: 'Mirror',
      params: [
        { name: 'flipX',  label: 'Flip Horizontal', type: 'bool', default: true },
        { name: 'flipY',  label: 'Flip Vertical',   type: 'bool', default: false },
        { name: 'onBeat', label: 'Toggle on Beat',  type: 'bool', default: false },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
