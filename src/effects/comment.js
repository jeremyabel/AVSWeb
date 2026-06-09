import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';
import blitFrag from '../shaders/blit.frag?raw';

// No-op effect — just passes the frame through. Useful for annotations in presets.
export class CommentEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.text = '';
    this._prog = createProgram(gl, vertSrc, blitFrag);
    this._uTex = gl.getUniformLocation(this._prog, 'uTex');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uTex, 0);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return { text: this.text }; }
  setConfig(cfg) { if (cfg.text !== undefined) this.text = cfg.text; }

  getDescriptor() {
    return {
      name: 'Comment',
      params: [{ name: 'text', label: 'Note', type: 'text', default: '' }],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
