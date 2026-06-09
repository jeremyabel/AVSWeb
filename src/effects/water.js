import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// The original water effect is a 2D discrete wave equation applied directly to pixel
// colors. Per pixel:
//   out = clamp(sum_of_present_neighbors(input) / divisor - prev_input, 0, 1)
// Where divisor = 1 for corners (2 neighbors), 2 for edge/interior pixels (3-4 neighbors).
// "prev_input" is the raw input frame from the previous render call, stored in _prevTex.
//
// Border handling (from original convolution diagram):
//   Interior (4 neighbors):  sum / 2
//   Edge     (3 neighbors):  sum / 2
//   Corner   (2 neighbors):  sum / 1  (no divide)
const WATER_FRAG = /* glsl */`#version 300 es
precision highp float;
uniform sampler2D uInput;
uniform sampler2D uPrev;
out vec4 fragColor;
void main() {
  ivec2 c  = ivec2(gl_FragCoord.xy);
  ivec2 sz = ivec2(textureSize(uInput, 0));

  bool atL = c.x == 0;
  bool atR = c.x == sz.x - 1;
  bool atB = c.y == 0;
  bool atT = c.y == sz.y - 1;

  vec3 sum = vec3(0.0);
  if (!atL) sum += texelFetch(uInput, c - ivec2(1, 0), 0).rgb;
  if (!atR) sum += texelFetch(uInput, c + ivec2(1, 0), 0).rgb;
  if (!atB) sum += texelFetch(uInput, c - ivec2(0, 1), 0).rgb;
  if (!atT) sum += texelFetch(uInput, c + ivec2(0, 1), 0).rgb;

  // Corners (2 neighbors) are not halved; everything else is divided by 2
  bool isCorner = (atL || atR) && (atT || atB);
  if (!isCorner) sum *= 0.5;

  vec3 prev = texelFetch(uPrev, c, 0).rgb;
  fragColor = vec4(clamp(sum - prev, 0.0, 1.0), 1.0);
}`;

// Trivial copy used to save the current input into _prevFBO after each frame.
const COPY_FRAG = /* glsl */`#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 fragColor;
void main() { fragColor = texture(uTex, vUv); }`;

export class WaterEffect extends Effect {
  constructor(gl) {
    super(gl);

    this._waterProg = createProgram(gl, vertSrc, WATER_FRAG);
    this._copyProg  = createProgram(gl, vertSrc, COPY_FRAG);

    this._uInput = gl.getUniformLocation(this._waterProg, 'uInput');
    this._uPrev  = gl.getUniformLocation(this._waterProg, 'uPrev');
    this._uCopy  = gl.getUniformLocation(this._copyProg,  'uTex');

    this._prevFBO = null;
    this._prevTex = null;
    this._prevW   = -1;
    this._prevH   = -1;
  }

  _ensurePrev(gl, w, h) {
    if (this._prevW === w && this._prevH === h) return;
    if (this._prevFBO) {
      gl.deleteFramebuffer(this._prevFBO);
      gl.deleteTexture(this._prevTex);
    }
    this._prevTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._prevTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._prevFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._prevFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._prevTex, 0);
    // Initialize to black — matches original calloc(lastframe)
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._prevW = w;
    this._prevH = h;
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;
    this._ensurePrev(gl, w, h);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);

    // Water convolution: inputTex (current) + _prevTex (previous input) → outputFBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._waterProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._prevTex);
    gl.uniform1i(this._uPrev, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Store current input → _prevFBO (becomes "prev" for the next frame)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._prevFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._copyProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uCopy, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return {}; }
  setConfig() {}

  getDescriptor() { return { name: 'Water', params: [] }; }

  destroy() {
    const gl = this.gl;
    gl.deleteProgram(this._waterProg);
    gl.deleteProgram(this._copyProg);
    if (this._prevFBO) gl.deleteFramebuffer(this._prevFBO);
    if (this._prevTex) gl.deleteTexture(this._prevTex);
  }
}
