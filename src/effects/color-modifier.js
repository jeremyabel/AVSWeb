import { ScriptableEffect, scanVarDecls } from './scriptable-effect.js';
import { createProgram, getQuadVAO } from './effect.js';
import { makeAudioScope, AUDIO_GLSL_SRC } from '../core/audio-data.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const DEFAULT_PIXEL = `// red, green, blue all start at the same channel intensity (0..1).
// Modify them to remap that intensity to new R, G, B output values.
// The stub runs once per channel: red output → new R, green → new G, blue → new B.
// beat = 1 on a beat. User vars declared in Init are also available.
red   = red;
green = green;
blue  = blue;`;

const DEFAULT_FRAME = ``;
const DEFAULT_BEAT  = ``;
const DEFAULT_INIT  = ``;

// 'beat', 'red', 'green', 'blue' are GLSL-side builtins — never user-declared via 'var'.
const BUILTIN_VARS = new Set(['beat', 'red', 'green', 'blue', 'getspec', 'getosc']);

// Mirrors the original's per-channel LUT semantics: the stub runs three times,
// once per output channel. Each run starts with red=green=blue=channel_input
// (matching the original's `*vars.red = *vars.blue = *vars.green = x/255.0` loop).
// The output red/green/blue are read back as the new R, G, B values respectively.
// User vars and beat are re-initialised from uniforms inside each block so that
// each channel evaluation starts from the same frame state.
function buildFragSrc(pixelStub, userVars) {
  const uniformDecls = [...userVars].map(v => `uniform float ${v};`).join('\n');
  const blockInits   = [
    `    float beat = uBeat;`,
    ...[...userVars].map(v => `    float ${v} = ${v};`),
  ].join('\n');

  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform float uBeat;
${uniformDecls}
${AUDIO_GLSL_SRC}
out vec4 fragColor;

void main() {
  vec3 c = texture(uInput, vUv).rgb;
  float out_r, out_g, out_b;

  {
    float red = c.r, green = c.r, blue = c.r;
${blockInits}
    ${pixelStub}
    out_r = clamp(red, 0.0, 1.0);
  }
  {
    float red = c.g, green = c.g, blue = c.g;
${blockInits}
    ${pixelStub}
    out_g = clamp(green, 0.0, 1.0);
  }
  {
    float red = c.b, green = c.b, blue = c.b;
${blockInits}
    ${pixelStub}
    out_b = clamp(blue, 0.0, 1.0);
  }

  fragColor = vec4(out_r, out_g, out_b, 1.0);
}`;
}

export class ColorModifierEffect extends ScriptableEffect {
  constructor(gl) {
    super(gl, 'ColorModifier');
    this.pixelCode = DEFAULT_PIXEL;
    this.frameCode = DEFAULT_FRAME;
    this.beatCode  = DEFAULT_BEAT;
    this.initCode  = DEFAULT_INIT;

    // Persistent JS scope shared across init/frame/beat.
    // 'beat' is always present as a builtin; user vars are added via scanVarDecls(initCode).
    this._visdata    = null;
    this._jsScope    = { beat: 0 };
    const { getspec, getosc } = makeAudioScope(() => this._visdata);
    this._jsScope.getspec = getspec;
    this._jsScope.getosc  = getosc;
    this._bridgedVars = new Set();
    this._userLocs   = {};
    this._inited     = false;

    this._prog         = null;
    this._compileError = '';
    this._uInput = null;
    this._uBeat  = null;

    this._rescanVars();
    this._buildProgram(DEFAULT_PIXEL);
    this._jsScope.beat = 0;
    this._runJS(this.initCode, 'initCode');
    this._inited = true;
  }

  // Scan initCode for `var` declarations and seed missing keys into _jsScope.
  _rescanVars() {
    this._bridgedVars = scanVarDecls(this.initCode, BUILTIN_VARS);
    for (const v of this._bridgedVars) {
      if (!(v in this._jsScope)) this._jsScope[v] = 0;
    }
  }

  _buildProgram(pixelStub) {
    const gl = this.gl;
    const fragSrc = buildFragSrc(pixelStub, this._bridgedVars);
    try {
      const next = createProgram(gl, vertSrc, fragSrc);
      if (this._prog) gl.deleteProgram(this._prog);
      this._prog   = next;
      this._uInput     = gl.getUniformLocation(this._prog, 'uInput');
      this._uBeat      = gl.getUniformLocation(this._prog, 'uBeat');
      this._uAudioData = gl.getUniformLocation(this._prog, 'uAudioData');
      this._userLocs = {};
      for (const v of this._bridgedVars) {
        this._userLocs[v] = gl.getUniformLocation(this._prog, v);
      }
      this._compileError = '';
    } catch (e) {
      this._compileError = e.message;
    }
  }

  // Called by config-panels.js glsl textarea handler
  setPixelCode(src) {
    this.pixelCode = src;
    this._buildProgram(src);
  }

  getCompileError() { return this._compileError; }

  render(ctx) {
    if (!this._prog) return;
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const beatVal = isBeat ? 1 : 0;

    this._visdata = ctx.visdata;
    this._jsScope.beat = beatVal;
    if (!this._inited) {
      this._runJS(this.initCode, 'initCode');
      this._inited = true;
    }
    this._runJS(this.frameCode, 'frameCode');
    if (isBeat) this._runJS(this.beatCode, 'beatCode');

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1f(this._uBeat,  beatVal);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, ctx.audioTex);
    gl.uniform1i(this._uAudioData, 2);
    for (const [v, loc] of Object.entries(this._userLocs)) {
      gl.uniform1f(loc, this._jsScope[v] ?? 0);
    }

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return {
      pixelCode: this.pixelCode,
      frameCode: this.frameCode,
      beatCode:  this.beatCode,
      initCode:  this.initCode,
    };
  }

  setConfig(cfg) {
    let needsRescan  = false;
    let needsRebuild = false;
    let runInit = false, runFrame = false, runBeat = false;

    if (cfg.pixelCode !== undefined && cfg.pixelCode !== this.pixelCode) {
      this.pixelCode = cfg.pixelCode; needsRebuild = true;
    }
    if (cfg.frameCode !== undefined && cfg.frameCode !== this.frameCode) {
      this.frameCode = cfg.frameCode; runFrame = true;
    }
    if (cfg.beatCode !== undefined && cfg.beatCode !== this.beatCode) {
      this.beatCode = cfg.beatCode; runBeat = true;
    }
    if (cfg.initCode !== undefined && cfg.initCode !== this.initCode) {
      this.initCode = cfg.initCode; needsRescan = true; needsRebuild = true; runInit = true;
    }

    if (needsRescan)  this._rescanVars();
    if (needsRebuild) this._buildProgram(this.pixelCode);
    if (runInit)  { this._inited = false; this._jsScope.beat = 0; this._runJS(this.initCode,  'initCode'); this._inited = true; }
    if (runFrame) { this._jsScope.beat = 0; this._runJS(this.frameCode, 'frameCode'); }
    if (runBeat)  { this._jsScope.beat = 1; this._runJS(this.beatCode,  'beatCode'); }
  }

  getDescriptor() {
    return {
      name: 'Color Modifier',
      params: [
        { name: 'pixelCode', label: 'Pixel (GLSL)', type: 'glsl', default: DEFAULT_PIXEL },
        { name: 'frameCode', label: 'Frame',        type: 'js',   default: DEFAULT_FRAME },
        { name: 'beatCode',  label: 'Beat',         type: 'js',   default: DEFAULT_BEAT  },
        { name: 'initCode',  label: 'Init',         type: 'js',   default: DEFAULT_INIT  },
      ],
    };
  }

  destroy() { if (this._prog) this.gl.deleteProgram(this._prog); }
}
