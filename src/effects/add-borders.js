import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
uniform sampler2D uInput;
uniform vec3  uColor;
uniform int   uBorderW;
uniform int   uBorderH;
uniform int   uWidth;
uniform int   uHeight;
out vec4 fragColor;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  bool inBorder = px.x < uBorderW || px.x >= uWidth  - uBorderW
               || px.y < uBorderH || px.y >= uHeight - uBorderH;

  if (inBorder) {
    fragColor = vec4(uColor, 1.0);
  } else {
    vec2 uv = gl_FragCoord.xy / vec2(float(uWidth), float(uHeight));
    fragColor = vec4(texture(uInput, uv).rgb, 1.0);
  }
}`;

export class AddBordersEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.color = [0, 0, 0];
    this.size  = 1; // 1-50, percentage of dimension

    this._prog     = createProgram(gl, vertSrc, FRAG);
    this._uInput   = gl.getUniformLocation(this._prog, 'uInput');
    this._uColor   = gl.getUniformLocation(this._prog, 'uColor');
    this._uBorderW = gl.getUniformLocation(this._prog, 'uBorderW');
    this._uBorderH = gl.getUniformLocation(this._prog, 'uBorderH');
    this._uWidth   = gl.getUniformLocation(this._prog, 'uWidth');
    this._uHeight  = gl.getUniformLocation(this._prog, 'uHeight');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    const borderW = Math.max(1, Math.floor(w * this.size / 100));
    const borderH = Math.max(1, Math.floor(h * this.size / 100));

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);

    gl.uniform3f(this._uColor, this.color[0] / 255, this.color[1] / 255, this.color[2] / 255);
    gl.uniform1i(this._uBorderW, borderW);
    gl.uniform1i(this._uBorderH, borderH);
    gl.uniform1i(this._uWidth,   w);
    gl.uniform1i(this._uHeight,  h);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return {
      color: [...this.color],
      size:  this.size,
    };
  }

  setConfig(cfg) {
    if (cfg.color !== undefined) this.color = (cfg.color || [0,0,0]).map(v => Math.max(0, Math.min(255, v | 0)));
    if (cfg.size  !== undefined) this.size  = Math.max(1, Math.min(50, cfg.size | 0));
  }

  getDescriptor() {
    return {
      name: 'Add Borders',
      params: [
        { name: 'color', label: 'Color', type: 'color', default: [0, 0, 0] },
        { name: 'size',  label: 'Size',  type: 'range', min: 1, max: 50, step: 1, default: 1 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
