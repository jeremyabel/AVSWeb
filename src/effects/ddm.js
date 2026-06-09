import { ScriptableEffect, scanVarDecls } from './scriptable-effect.js';
import { createProgram, getQuadVAO } from './effect.js';
import { makeAudioScope, AUDIO_GLSL_SRC } from '../core/audio-data.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const DEFAULT_PIXEL = `// d = normalized distance from center (0..1, where 1 = corner)
// r = angle in radians, t = time (from frame code), b = beat (0 or 1)
// Modify d to remap each radial ring. Examples:
//   Zoom in:  d = d * 0.9;
//   Zoom out: d = d * 1.1;
//   Breathe:  d = d * (1.0 + 0.1 * sin(t));
d = d * (1.0 + 0.08 * sin(t));`;

const DEFAULT_FRAME = `t = t + 0.05;`;
const DEFAULT_BEAT  = ``;
const DEFAULT_INIT  = `var t = 0.0;\nvar u = 1.0;`;

// Variables always available in JS scope but never user-declared via 'var'.
const BUILTIN_VARS = new Set(['b', 'getspec', 'getosc']);

// userVars: Set of user-declared var names from Init — become uniform float declarations.
// Each gets a mutable local copy in main() so the pixel stub can read/write them.
function buildFragSrc(pixelStub, userVars) {
  const uniformDecls = [...userVars].map(v => `uniform float ${v};`).join('\n');
  const localCopies  = [...userVars].map(v => `  float ${v} = ${v};`).join('\n');

  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform float uW;
uniform float uH;
uniform float uMaxD;
uniform float uB;
uniform int uBlend;
${uniformDecls}
${AUDIO_GLSL_SRC}
out vec4 fragColor;

void main() {
  vec2 center = vUv - 0.5;
  float d_px = length(vec2(center.x * uW, center.y * uH));
  float d = d_px / uMaxD;
  float r = atan(center.y, center.x);
  float b = uB;
${localCopies}

  // --- User pixel stub ---
  ${pixelStub}
  // --- End stub ---

  vec2 src_uv;
  if (d_px < 0.5) {
    src_uv = vec2(0.5);
  } else {
    float scale = (d * uMaxD) / d_px;
    src_uv = clamp(vec2(0.5) + center * scale, 0.0, 1.0);
  }

  vec4 mapped = texture(uInput, src_uv);
  if (uBlend == 1) {
    vec4 orig = texture(uInput, vUv);
    fragColor = vec4((mapped.rgb + orig.rgb) * 0.5, 1.0);
  } else {
    fragColor = mapped;
  }
}`;
}

export class DDMEffect extends ScriptableEffect {
  constructor(gl) {
    super(gl, 'DDM');
    this.pixelCode = DEFAULT_PIXEL;
    this.frameCode = DEFAULT_FRAME;
    this.beatCode  = DEFAULT_BEAT;
    this.initCode  = DEFAULT_INIT;
    this.blend     = false;
    this.bilinear  = false;

    // Persistent JS scope shared across init/frame/beat.
    // 'b' is always present as a builtin; user vars are added via scanVarDecls(initCode).
    this._visdata    = null;
    this._jsScope    = { b: 0 };
    const { getspec, getosc } = makeAudioScope(() => this._visdata);
    this._jsScope.getspec = getspec;
    this._jsScope.getosc  = getosc;
    this._bridgedVars = new Set();
    this._userLocs   = {};
    this._inited     = false;

    this._prog         = null;
    this._compileError = '';
    this._uInput  = null;
    this._uW      = null; this._uH = null; this._uMaxD = null;
    this._uB      = null; this._uBlend = null;

    this._rescanVars();
    this._buildProgram(DEFAULT_PIXEL);
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
      this._uInput = gl.getUniformLocation(this._prog, 'uInput');
      this._uW     = gl.getUniformLocation(this._prog, 'uW');
      this._uH     = gl.getUniformLocation(this._prog, 'uH');
      this._uMaxD  = gl.getUniformLocation(this._prog, 'uMaxD');
      this._uB         = gl.getUniformLocation(this._prog, 'uB');
      this._uBlend     = gl.getUniformLocation(this._prog, 'uBlend');
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
    const w = fboManager.w, h = fboManager.h;
    const maxD = 0.5 * Math.sqrt(w * w + h * h);
    const bVal = isBeat ? 1 : 0;

    this._visdata = ctx.visdata;
    this._jsScope.b = bVal;
    if (!this._inited) {
      this._runJS(this.initCode, 'initCode');
      this._inited = true;
    }
    this._runJS(this.frameCode, 'frameCode');
    if (isBeat) this._runJS(this.beatCode, 'beatCode');

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    const filter = this.bilinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1f(this._uW,    w);
    gl.uniform1f(this._uH,    h);
    gl.uniform1f(this._uMaxD, maxD);
    gl.uniform1f(this._uB,    bVal);
    gl.uniform1i(this._uBlend, this.blend ? 1 : 0);
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
      blend:     this.blend,
      bilinear:  this.bilinear,
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
    if (cfg.blend    !== undefined) this.blend    = cfg.blend;
    if (cfg.bilinear !== undefined) this.bilinear = cfg.bilinear;

    if (needsRescan)  this._rescanVars();
    if (needsRebuild) this._buildProgram(this.pixelCode);
    if (runInit)  { this._inited = false; this._jsScope.b = 0; this._runJS(this.initCode,  'initCode'); this._inited = true; }
    if (runFrame) { this._jsScope.b = 0; this._runJS(this.frameCode, 'frameCode'); }
    if (runBeat)  { this._jsScope.b = 1; this._runJS(this.beatCode,  'beatCode'); }
  }

  getDescriptor() {
    return {
      name: 'Dynamic Distance Modifier',
      params: [
        { name: 'blend',     label: 'Blend',              type: 'bool', default: false },
        { name: 'bilinear',  label: 'Bilinear Filtering', type: 'bool', default: false },
        { name: 'pixelCode', label: 'Pixel (GLSL)',  type: 'glsl', default: DEFAULT_PIXEL },
        { name: 'frameCode', label: 'Frame',         type: 'js',   default: DEFAULT_FRAME },
        { name: 'beatCode',  label: 'Beat',          type: 'js',   default: DEFAULT_BEAT  },
        { name: 'initCode',  label: 'Init',          type: 'js',   default: DEFAULT_INIT  },
      ],
    };
  }

  destroy() { if (this._prog) this.gl.deleteProgram(this._prog); }
}
