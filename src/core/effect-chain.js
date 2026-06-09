import { createProgram, getQuadVAO } from '../effects/effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';
import blitFrag from '../shaders/blit.frag?raw';

export class EffectEntry {
  constructor(effect) {
    this.effect = effect;
    this.enabled = true;
  }
}

export class EffectChain {
  constructor(gl) {
    this.gl = gl;
    this.entries = [];

    this._blitProg = createProgram(gl, vertSrc, blitFrag);
    this._blitU = { tex: gl.getUniformLocation(this._blitProg, 'uTex') };
  }

  add(entry) { this.entries.push(entry); }
  remove(entry) { this.entries = this.entries.filter(e => e !== entry); }
  move(fromIdx, toIdx) {
    const [item] = this.entries.splice(fromIdx, 1);
    this.entries.splice(toIdx, 0, item);
  }

  // Each enabled effect reads getCurrent().texture (inputTex) and writes to
  // getNext().fbo (outputFBO), then calls fboManager.swap() internally.
  // The chain just clears the destination before each effect and lets effects
  // handle their own compositing with the input.
  render(ctx) {
    const { gl, fboManager } = ctx;
    const w = fboManager.w, h = fboManager.h;

    for (const entry of this.entries) {
      if (!entry.enabled) continue;

      ctx.inputTex = fboManager.getCurrent().texture;
      ctx.outputFBO = fboManager.getNext().fbo;

      // Clear destination so partial-draw effects start on a known background.
      gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.outputFBO);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      entry.effect.render(ctx);
      // Effect calls fboManager.swap() before returning, so getCurrent() is
      // now the effect's output and getNext() is the previous frame slot.
    }
  }

  // Blit getCurrent().texture → the canvas (null framebuffer).
  blitToCanvas(gl, fboManager) {
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.useProgram(this._blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fboManager.getCurrent().texture);
    gl.uniform1i(this._blitU.tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  destroy() {
    this.gl.deleteProgram(this._blitProg);
    for (const e of this.entries) e.effect.destroy();
  }
}
