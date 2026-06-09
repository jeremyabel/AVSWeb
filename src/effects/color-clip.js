import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Per-pixel: if ALL channels are <= the clip color, replace the pixel with
// the clip color. Otherwise pass through unchanged.
// This lifts dark/black pixels to a configurable minimum floor color.

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform vec3 uClip;
out vec4 fragColor;
void main() {
  vec3 c = texture(uInput, vUv).rgb;
  // step(edge, x) = 1 when x >= edge, i.e. step(c, clip) = 1 when c <= clip
  float below = step(c.r, uClip.r) * step(c.g, uClip.g) * step(c.b, uClip.b);
  fragColor = vec4(mix(c, uClip, below), 1.0);
}`;

export class ColorClipEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.color = [32, 32, 32];   // default: dark grey floor

    this._prog   = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uClip  = gl.getUniformLocation(this._prog, 'uClip');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform3f(this._uClip, this.color[0] / 255, this.color[1] / 255, this.color[2] / 255);
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
      name: 'Color Clip',
      params: [
        { name: 'color', label: 'Clip Color', type: 'color', default: [32, 32, 32] },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
