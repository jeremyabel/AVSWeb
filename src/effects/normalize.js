import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// First reduction pass: color buffer → minmax texture (R=global_min, G=global_max).
// Each output pixel covers a 2×2 block of the source.
const INIT_FRAG = /* glsl */`#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform ivec2 uSrcSize;
out vec4 fragColor;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 2;
  ivec2 sz = uSrcSize - 1;
  vec3 s00 = texelFetch(uTex, clamp(b,                sz * 0, sz), 0).rgb;
  vec3 s10 = texelFetch(uTex, clamp(b + ivec2(1, 0),  ivec2(0), sz), 0).rgb;
  vec3 s01 = texelFetch(uTex, clamp(b + ivec2(0, 1),  ivec2(0), sz), 0).rgb;
  vec3 s11 = texelFetch(uTex, clamp(b + ivec2(1, 1),  ivec2(0), sz), 0).rgb;
  vec3 mn3 = min(min(s00, s10), min(s01, s11));
  vec3 mx3 = max(max(s00, s10), max(s01, s11));
  fragColor = vec4(min(mn3.r, min(mn3.g, mn3.b)),
                   max(mx3.r, max(mx3.g, mx3.b)),
                   0.0, 1.0);
}`;

// Subsequent reduction passes: combine 2×2 minmax blocks.
const REDUCE_FRAG = /* glsl */`#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform ivec2 uSrcSize;
out vec4 fragColor;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 2;
  ivec2 sz = uSrcSize - 1;
  vec4 s00 = texelFetch(uTex, clamp(b,                ivec2(0), sz), 0);
  vec4 s10 = texelFetch(uTex, clamp(b + ivec2(1, 0),  ivec2(0), sz), 0);
  vec4 s01 = texelFetch(uTex, clamp(b + ivec2(0, 1),  ivec2(0), sz), 0);
  vec4 s11 = texelFetch(uTex, clamp(b + ivec2(1, 1),  ivec2(0), sz), 0);
  fragColor = vec4(min(min(s00.r, s10.r), min(s01.r, s11.r)),
                   max(max(s00.g, s10.g), max(s01.g, s11.g)),
                   0.0, 1.0);
}`;

// Apply pass: read min/max from the 1×1 reduction result and remap input pixels.
// Samples uMinMaxTex at (0.5, 0.5) — the single texel that holds global min/max.
const APPLY_FRAG = /* glsl */`#version 300 es
precision highp float;
uniform sampler2D uInputTex;
uniform sampler2D uMinMaxTex;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 mm = texture(uMinMaxTex, vec2(0.5));
  float mn = mm.r;
  float mx = mm.g;
  vec4 px = texture(uInputTex, vUv);
  float range = mx - mn;
  if (range > 0.0) {
    px.rgb = clamp((px.rgb - mn) / range, 0.0, 1.0);
  } else {
    // max == min: entire image is one brightness — map to black (matches original)
    px.rgb = vec3(0.0);
  }
  fragColor = px;
}`;

export class NormalizeEffect extends Effect {
  constructor(gl) {
    super(gl);
    this._initProg   = createProgram(gl, vertSrc, INIT_FRAG);
    this._reduceProg = createProgram(gl, vertSrc, REDUCE_FRAG);
    this._applyProg  = createProgram(gl, vertSrc, APPLY_FRAG);

    this._iUTex     = gl.getUniformLocation(this._initProg,   'uTex');
    this._iUSrcSize = gl.getUniformLocation(this._initProg,   'uSrcSize');
    this._rUTex     = gl.getUniformLocation(this._reduceProg, 'uTex');
    this._rUSrcSize = gl.getUniformLocation(this._reduceProg, 'uSrcSize');
    this._aUInput   = gl.getUniformLocation(this._applyProg,  'uInputTex');
    this._aUMinMax  = gl.getUniformLocation(this._applyProg,  'uMinMaxTex');

    this._chain  = null;
    this._chainW = -1;
    this._chainH = -1;
  }

  _makeFBO(gl, w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { fbo, tex, w, h };
  }

  _ensureChain(gl, w, h) {
    if (this._chainW === w && this._chainH === h) return;
    this._destroyChain(gl);
    this._chain = [];
    let cw = Math.max(1, Math.ceil(w / 2));
    let ch = Math.max(1, Math.ceil(h / 2));
    for (;;) {
      this._chain.push(this._makeFBO(gl, cw, ch));
      if (cw === 1 && ch === 1) break;
      cw = Math.max(1, Math.ceil(cw / 2));
      ch = Math.max(1, Math.ceil(ch / 2));
    }
    this._chainW = w;
    this._chainH = h;
  }

  _destroyChain(gl) {
    if (!this._chain) return;
    for (const { fbo, tex } of this._chain) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
    }
    this._chain = null;
    this._chainW = -1;
    this._chainH = -1;
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;
    this._ensureChain(gl, w, h);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);

    // Init pass: color buffer → chain[0] (minmax at half resolution)
    const c0 = this._chain[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, c0.fbo);
    gl.viewport(0, 0, c0.w, c0.h);
    gl.useProgram(this._initProg);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._iUTex, 0);
    gl.uniform2i(this._iUSrcSize, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Reduce passes: chain[i-1] → chain[i] until 1×1
    gl.useProgram(this._reduceProg);
    gl.uniform1i(this._rUTex, 0);
    for (let i = 1; i < this._chain.length; i++) {
      const src = this._chain[i - 1];
      const dst = this._chain[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2i(this._rUSrcSize, src.w, src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // Apply pass: remap inputTex using the 1×1 minmax texture
    const last = this._chain[this._chain.length - 1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._applyProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._aUInput, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, last.tex);
    gl.uniform1i(this._aUMinMax, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return {}; }
  setConfig() {}

  getDescriptor() { return { name: 'Normalize', params: [] }; }

  destroy() {
    const gl = this.gl;
    gl.deleteProgram(this._initProg);
    gl.deleteProgram(this._reduceProg);
    gl.deleteProgram(this._applyProg);
    this._destroyChain(gl);
  }
}
