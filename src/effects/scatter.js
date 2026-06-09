import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Each pixel reads from a randomly displaced neighbour within ±3 px (both axes).
// The displacement distribution matches the original fudgetable: indices 0..7 map
// to offsets {-3,-2,-1,0,0,1,2,3} (0 has double probability).
// Top/bottom 4 rows are passed through unmodified (matching original border guard).

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform float uW;
uniform float uH;
uniform float uSeed;   // changes every frame
out vec4 fragColor;

// A two-input hash returning a value in [0,1)
float h1(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float h2(vec2 p) {
  return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453123);
}

// Map integer index i in [0,7] to fudgetable offset {-3,-2,-1,0,0,1,2,3}
float fudge(float i) {
  float v = i - 4.0;     // -4..3
  if (v < 0.0) v += 1.0; // -3,-2,-1,0 | 0,1,2,3
  return v;
}

void main() {
  // Integer pixel row (y=0 at bottom in WebGL)
  float py = floor(gl_FragCoord.y);

  // Pass through the 4-row top and bottom borders (matching original border guard)
  if (py < 4.0 || py >= uH - 4.0) {
    fragColor = texture(uInput, vUv);
    return;
  }

  float px = floor(gl_FragCoord.x);

  // Two independent random indices in [0,8)
  vec2 seed_x = vec2(px + uSeed * 17.31, py + uSeed *  5.77);
  vec2 seed_y = vec2(px + uSeed *  3.13, py + uSeed * 11.97);
  float ri_x = floor(h1(seed_x) * 8.0);
  float ri_y = floor(h2(seed_y) * 8.0);

  float dx = fudge(ri_x);
  float dy = fudge(ri_y);

  vec2 src_uv = vec2((px + dx + 0.5) / uW, (py + dy + 0.5) / uH);
  src_uv = clamp(src_uv, 0.0, 1.0);

  fragColor = vec4(texture(uInput, src_uv).rgb, 1.0);
}`;

export class ScatterEffect extends Effect {
  constructor(gl) {
    super(gl);
    this._frame  = 0;
    this._prog   = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uW     = gl.getUniformLocation(this._prog, 'uW');
    this._uH     = gl.getUniformLocation(this._prog, 'uH');
    this._uSeed  = gl.getUniformLocation(this._prog, 'uSeed');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    // Advance seed; keep it bounded to avoid float precision issues
    this._frame = (this._frame + 1) & 0xFFFF;
    const seed  = this._frame * 1.6180339887;

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1f(this._uW,     w);
    gl.uniform1f(this._uH,     h);
    gl.uniform1f(this._uSeed,  seed);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig()    { return {}; }
  setConfig()    {}

  getDescriptor() {
    return { name: 'Scatter', params: [] };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
