import { ScriptableEffect, scanVarDecls } from './scriptable-effect.js';
import { createProgram, getQuadVAO } from './effect.js';
import { makeAudioScope } from '../core/audio-data.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const DEFAULT_INIT  = `var d = 0;`;
const DEFAULT_FRAME = `x = Math.sin(d) * 1.4; y = 1.4 * Math.cos(d); d = d + 0.01;`;
const DEFAULT_BEAT  = `d = d + 2.0;`;

// Always-present scope vars — never require 'var' declaration in Init.
// x, y  — pixel shift passed to the shader each frame.
// alpha  — blend weight [0..1] for border areas.
// w, h   — canvas dimensions (set per frame, read-only in practice).
// b      — beat flag (1 on beat, 0 otherwise).
const BUILTIN_VARS = new Set(['x', 'y', 'alpha', 'w', 'h', 'b', 'getspec', 'getosc']);

// Output pixel at (px, py_down) reads input at (px - x, py_down - y).
// In WebGL vUv (y=0 at bottom):  src_uv.x = vUv.x - x/w,  src_uv.y = vUv.y + y/h.
// Empty border areas → black (blend=0) or faded original (blend=1).
const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform float uX;      // pixel shift right (original y-down convention)
uniform float uY;      // pixel shift down  (original y-down convention)
uniform float uW;
uniform float uH;
uniform int   uBlend;  // 0=replace with black border  1=alpha blend
uniform float uAlpha;  // blend weight [0..1]
out vec4 fragColor;

void main() {
  vec2 src_uv = vec2(vUv.x - uX / uW, vUv.y + uY / uH);
  bool inBounds = src_uv.x >= 0.0 && src_uv.x <= 1.0
               && src_uv.y >= 0.0 && src_uv.y <= 1.0;

  vec3 shifted = inBounds ? texture(uInput, src_uv).rgb : vec3(0.0);

  if (uBlend == 0) {
    fragColor = vec4(shifted, 1.0);
  } else {
    vec3 orig = texture(uInput, vUv).rgb;
    fragColor  = vec4(shifted * uAlpha + orig * (1.0 - uAlpha), 1.0);
  }
}`;

export class DynamicShiftEffect extends ScriptableEffect {
  constructor(gl) {
    super(gl, 'DynamicShift');
    this.initCode  = DEFAULT_INIT;
    this.frameCode = DEFAULT_FRAME;
    this.beatCode  = DEFAULT_BEAT;
    this.blend     = false;
    this.subpixel  = true;

    // x, y, alpha drive the shader; w, h, b are set per-frame.
    // User vars declared with 'var' in Init are added on top.
    this._visdata  = null;
    this._jsScope  = { x: 0, y: 0, alpha: 0.5, w: 0, h: 0, b: 0 };
    const { getspec, getosc } = makeAudioScope(() => this._visdata);
    this._jsScope.getspec = getspec;
    this._jsScope.getosc  = getosc;
    this._inited   = false;
    this._lastW    = 0;
    this._lastH    = 0;

    this._prog   = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uX     = gl.getUniformLocation(this._prog, 'uX');
    this._uY     = gl.getUniformLocation(this._prog, 'uY');
    this._uW     = gl.getUniformLocation(this._prog, 'uW');
    this._uH     = gl.getUniformLocation(this._prog, 'uH');
    this._uBlend = gl.getUniformLocation(this._prog, 'uBlend');
    this._uAlpha = gl.getUniformLocation(this._prog, 'uAlpha');

    this._rescanVars();
    this._runJS(this.initCode, 'initCode');
    this._inited = true;
  }

  _rescanVars() {
    const bridged = scanVarDecls(this.initCode, BUILTIN_VARS);
    for (const v of bridged) {
      if (!(v in this._jsScope)) this._jsScope[v] = 0;
    }
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    this._visdata   = ctx.visdata;
    this._jsScope.b = isBeat ? 1 : 0;
    this._jsScope.w = w;
    this._jsScope.h = h;

    if (!this._inited || this._lastW !== w || this._lastH !== h) {
      this._jsScope.x     = 0;
      this._jsScope.y     = 0;
      this._jsScope.alpha = 0.5;
      this._runJS(this.initCode, 'initCode');
      this._inited = true;
      this._lastW  = w;
      this._lastH  = h;
    }

    this._runJS(this.frameCode, 'frameCode');
    if (isBeat) this._runJS(this.beatCode, 'beatCode');

    const alpha = Math.max(0, Math.min(1, this._jsScope.alpha));

    const filter = this.subpixel ? gl.LINEAR : gl.NEAREST;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1f(this._uX,     this._jsScope.x);
    gl.uniform1f(this._uY,     this._jsScope.y);
    gl.uniform1f(this._uW,     w);
    gl.uniform1f(this._uH,     h);
    gl.uniform1i(this._uBlend, this.blend ? 1 : 0);
    gl.uniform1f(this._uAlpha, alpha);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return {
      initCode:  this.initCode,
      frameCode: this.frameCode,
      beatCode:  this.beatCode,
      blend:     this.blend,
      subpixel:  this.subpixel,
    };
  }

  setConfig(cfg) {
    let needsRescan = false;
    let runInit = false, runFrame = false, runBeat = false;

    if (cfg.initCode  !== undefined && cfg.initCode  !== this.initCode)  { this.initCode  = cfg.initCode;  needsRescan = true; runInit  = true; }
    if (cfg.frameCode !== undefined && cfg.frameCode !== this.frameCode) { this.frameCode = cfg.frameCode; runFrame = true; }
    if (cfg.beatCode  !== undefined && cfg.beatCode  !== this.beatCode)  { this.beatCode  = cfg.beatCode;  runBeat  = true; }
    if (cfg.blend     !== undefined) this.blend    = cfg.blend;
    if (cfg.subpixel  !== undefined) this.subpixel = cfg.subpixel;

    if (needsRescan) this._rescanVars();
    if (runInit)  { this._inited = false; this._runJS(this.initCode,  'initCode'); this._inited = true; }
    if (runFrame) this._runJS(this.frameCode, 'frameCode');
    if (runBeat)  this._runJS(this.beatCode,  'beatCode');
  }

  getDescriptor() {
    return {
      name: 'Dynamic Shift',
      params: [
        { name: 'initCode',  label: 'Init',     type: 'js',   default: DEFAULT_INIT  },
        { name: 'frameCode', label: 'Frame',     type: 'js',   default: DEFAULT_FRAME },
        { name: 'beatCode',  label: 'Beat',      type: 'js',   default: DEFAULT_BEAT  },
        { name: 'blend',     label: 'Blend',     type: 'bool', default: false },
        { name: 'subpixel',  label: 'Subpixel',  type: 'bool', default: true  },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
