import { ScriptableEffect, scanVarDecls } from './scriptable-effect.js';
import { createProgram, getQuadVAO } from './effect.js';
import { makeAudioScope, AUDIO_GLSL_SRC } from '../core/audio-data.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const BUILTIN_VARS = new Set(['b', 'd', 'r', 'x', 'y', 'w', 'h', 'alpha', 'getspec', 'getosc']);

const DEFAULT_INIT  = '';
const DEFAULT_FRAME = '';
const DEFAULT_BEAT  = '';
const DEFAULT_PIXEL = `// Polar: modify d (distance 0..1) and r (angle in radians).
// Or enable Cartesian Coords and modify x, y (-1..1).
// Built-ins: b (beat 0/1), w, h (screen size), alpha (blend weight, default 0.5).
// Variables set in Init/Frame/Beat are available here as uniforms.
d = d * 0.95;
r = r + 0.02;`;

// 8-bit integer bilinear — matches original AVS C++ blend_bilinear_2x2 exactly.
const BILINEAR_COMPAT_GLSL = `
vec3 bilinearCompat(sampler2D tex, vec2 uv, ivec2 sz) {
  vec2  pos = uv * vec2(sz);
  ivec2 i0  = ivec2(floor(pos));
  ivec2 f8  = ivec2(fract(pos) * 256.0);
  ivec2 i1  = min(i0 + ivec2(1), sz - ivec2(1));
  i0 = clamp(i0, ivec2(0), sz - ivec2(1));
  ivec3 tl = ivec3(round(texelFetch(tex, i0,                  0).rgb * 255.0));
  ivec3 tr = ivec3(round(texelFetch(tex, ivec2(i1.x, i0.y),  0).rgb * 255.0));
  ivec3 bl = ivec3(round(texelFetch(tex, ivec2(i0.x, i1.y),  0).rgb * 255.0));
  ivec3 br = ivec3(round(texelFetch(tex, i1,                  0).rgb * 255.0));
  int   fx = f8.x;
  int   fy = f8.y;
  ivec3 top = (tl * (256 - fx) + tr * fx) >> 8;
  ivec3 bot = (bl * (256 - fx) + br * fx) >> 8;
  return vec3((top * (256 - fy) + bot * fy) >> 8) / 255.0;
}`;

function scanAssignments(code) {
  const names = new Set();
  const re = /\b([a-zA-Z_]\w*)\s*(?:[+\-*\/%&|^]=|=(?!=))/g;
  let m;
  while ((m = re.exec(code)) !== null) names.add(m[1]);
  for (const b of BUILTIN_VARS) names.delete(b);
  return names;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Flat triangle mesh covering NDC [-1,1] x [-1,1] for a gridW x gridH grid.
function buildGridMesh(gridW, gridH) {
  const verts = new Float32Array(gridW * gridH * 6 * 2);
  let i = 0;
  for (let row = 0; row < gridH; row++) {
    for (let col = 0; col < gridW; col++) {
      const x0 = (col       / gridW) * 2.0 - 1.0;
      const x1 = ((col + 1) / gridW) * 2.0 - 1.0;
      const y0 = 1.0 - (row       / gridH) * 2.0;  // NDC top of row
      const y1 = 1.0 - ((row + 1) / gridH) * 2.0;  // NDC bottom of row
      // Triangle 1: TL, TR, BL
      verts[i++] = x0; verts[i++] = y0;
      verts[i++] = x1; verts[i++] = y0;
      verts[i++] = x0; verts[i++] = y1;
      // Triangle 2: TR, BR, BL
      verts[i++] = x1; verts[i++] = y0;
      verts[i++] = x1; verts[i++] = y1;
      verts[i++] = x0; verts[i++] = y1;
    }
  }
  return verts;
}

// evalPixel GLSL function body — shared between grid vert and direct frag shaders.
// gu: 0=left, 1=right; gv: 0=top, 1=bottom (y-down screen convention).
// Returns vec3(src_u, src_v, alpha).
function buildEvalPixelGLSL(pixelStub, bridgedVars, localVars) {
  const bridgedLocals = [...bridgedVars].map(n => `  float ${n} = ${n};`).join('\n');
  const localDecls    = [...localVars].map(n => `  float ${n} = 0.0;`).join('\n');
  const stub = pixelStub.split('\n').map(l => '  ' + l).join('\n');

  return `vec3 evalPixel(float gu, float gv) {
  float x = gu * 2.0 - 1.0;
  float y = gv * 2.0 - 1.0;
  float max_d = 0.5 * sqrt(w * w + h * h);
  float d = sqrt((x * w * 0.5) * (x * w * 0.5) + (y * h * 0.5) * (y * h * 0.5)) / max_d;
  float r = atan(y * h, x * w) + PI * 0.5;
  float w = w;
  float h = h;
  float b = b;
  float alpha = 0.5;
${bridgedLocals ? bridgedLocals + '\n' : ''}${localDecls ? localDecls + '\n' : ''}
${stub}

  vec2 src_uv;
  if (!uRectCoords) {
    src_uv = vec2(0.5 + sin(r) * d * max_d / w,
                  0.5 + cos(r) * d * max_d / h);
  } else {
    src_uv = vec2((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  }
  return vec3(src_uv, clamp(alpha, 0.0, 1.0));
}`;
}

// Grid vertex shader: pixel code runs once per grid vertex; GPU rasterizer
// interpolates v_srcUV across each triangle face.
function buildGridVertSrc(pixelCode, bridgedVars, localVars) {
  const uniformDecls = [...bridgedVars].map(n => `uniform float ${n};`).join('\n');
  const evalPixelFn  = buildEvalPixelGLSL(pixelCode, bridgedVars, localVars);

  return `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_pos;

uniform bool  uRectCoords;
uniform bool  uWrap;
uniform float w;
uniform float h;
uniform float b;
${uniformDecls}
${AUDIO_GLSL_SRC}

const float PI = 3.14159265358979;

${evalPixelFn}

out vec2  v_srcUV;
out float v_alpha;
out vec2  v_screenUV;

void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  float gu = (a_pos.x + 1.0) * 0.5;
  float gv = (1.0 - a_pos.y) * 0.5;
  vec3  res  = evalPixel(gu, gv);
  v_srcUV    = uWrap ? res.xy : clamp(res.xy, 0.0, 1.0);
  v_alpha    = res.z;
  // screen->texture UV: (a_pos+1)/2 maps NDC [-1,1] to tex [0,1] with y=0=bottom
  v_screenUV = vec2((a_pos.x + 1.0) * 0.5, (a_pos.y + 1.0) * 0.5);
}`;
}

// Grid fragment shader: uses interpolated v_srcUV from vertex stage.
function buildGridFragSrc() {
  return `#version 300 es
precision highp float;

in vec2  v_srcUV;
in float v_alpha;
in vec2  v_screenUV;

uniform sampler2D uSource;
uniform sampler2D uInput;
uniform bool uWrap;
uniform bool uBlend;
uniform bool uNoMove;
uniform bool uSameBuffer;
uniform bool uShowUV;
uniform bool uBilinearCompat;

out vec4 fragColor;

${BILINEAR_COMPAT_GLSL}

void main() {
  if (uShowUV) {
    fragColor = vec4(v_srcUV, 0.0, 1.0);
    return;
  }

  vec4 orig = texture(uInput, v_screenUV);
  if (uNoMove) {
    vec3 src = uSameBuffer ? vec3(0.0) : texture(uSource, v_screenUV).rgb;
    fragColor = vec4(mix(orig.rgb, src, v_alpha), 1.0);
    return;
  }

  vec2 final_uv = uWrap ? fract(v_srcUV) : clamp(v_srcUV, 0.0, 1.0);
  vec3 sampled = uBilinearCompat
    ? bilinearCompat(uSource, final_uv, textureSize(uSource, 0))
    : texture(uSource, final_uv).rgb;

  fragColor = uBlend
    ? vec4(mix(orig.rgb, sampled, v_alpha), 1.0)
    : vec4(sampled, 1.0);
}`;
}

// Direct fragment shader: pixel code runs once per screen fragment (no grid).
function buildDirectFragSrc(pixelCode, bridgedVars, localVars) {
  const uniformDecls = [...bridgedVars].map(n => `uniform float ${n};`).join('\n');
  const evalPixelFn  = buildEvalPixelGLSL(pixelCode, bridgedVars, localVars);

  return `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uSource;
uniform sampler2D uInput;
uniform bool  uRectCoords;
uniform bool  uWrap;
uniform bool  uBlend;
uniform bool  uNoMove;
uniform bool  uSameBuffer;
uniform bool  uShowUV;
uniform bool  uBilinearCompat;
uniform float w;
uniform float h;
uniform float b;
${uniformDecls}
${AUDIO_GLSL_SRC}
out vec4 fragColor;

const float PI = 3.14159265358979;

${BILINEAR_COMPAT_GLSL}

${evalPixelFn}

void main() {
  // vUv.y=0 is bottom; flip so gv=0 is top (y-down convention)
  float gu = vUv.x;
  float gv = 1.0 - vUv.y;
  vec3  res    = evalPixel(gu, gv);
  vec2  src_uv = res.xy;
  float alpha  = res.z;

  if (uShowUV) {
    fragColor = vec4(src_uv, 0.0, 1.0);
    return;
  }

  vec4 orig = texture(uInput, vUv);
  if (uNoMove) {
    vec3 src = uSameBuffer ? vec3(0.0) : texture(uSource, vUv).rgb;
    fragColor = vec4(mix(orig.rgb, src, alpha), 1.0);
    return;
  }

  vec2 final_uv = uWrap ? fract(src_uv) : clamp(src_uv, 0.0, 1.0);
  vec3 sampled = uBilinearCompat
    ? bilinearCompat(uSource, final_uv, textureSize(uSource, 0))
    : texture(uSource, final_uv).rgb;

  fragColor = uBlend
    ? vec4(mix(orig.rgb, sampled, alpha), 1.0)
    : vec4(sampled, 1.0);
}`;
}

export class DynamicMovementEffect extends ScriptableEffect {
  constructor(gl) {
    super(gl, 'DynamicMovement');
    this.pixelCode      = DEFAULT_PIXEL;
    this.frameCode      = DEFAULT_FRAME;
    this.beatCode       = DEFAULT_BEAT;
    this.initCode       = DEFAULT_INIT;
    this.rectCoords     = false;
    this.wrap           = false;
    this.blend          = false;
    this.bilinear       = false;
    this.bilinearCompat = false;
    this.noMove         = false;
    this.showUV         = false;
    this.bufferN        = 0;
    this.useGrid        = true;
    this.gridW          = 16;
    this.gridH          = 16;

    this._visdata      = null;
    this._jsScope      = { b: 0, w: 0, h: 0, d: 0, r: 0, x: 0, y: 0, alpha: 0.5 };
    const { getspec, getosc } = makeAudioScope(() => this._visdata);
    this._jsScope.getspec = getspec;
    this._jsScope.getosc  = getosc;
    this._bridgedVars  = new Set();
    this._localVars    = new Set();
    this._inited       = false;
    this._prog         = null;
    this._compileError = '';
    this._uniforms     = {};

    this._gridVAO       = null;
    this._gridVBO       = null;
    this._gridVertCount = 0;

    this._rescanAndCompile();
    this._runInit();
  }

  _rescanAndCompile() {
    const bridged       = scanVarDecls(this.initCode, BUILTIN_VARS);
    const pixelAssigned = scanAssignments(this.pixelCode);
    const local         = new Set([...pixelAssigned].filter(v => !bridged.has(v)));

    for (const v of bridged) {
      if (!(v in this._jsScope)) this._jsScope[v] = 0;
    }

    this._bridgedVars = bridged;
    this._localVars   = local;
    this._compile();
  }

  _compile() {
    const gl = this.gl;
    try {
      let prog;
      if (this.useGrid) {
        const vs = buildGridVertSrc(this.pixelCode, this._bridgedVars, this._localVars);
        const fs = buildGridFragSrc();
        prog = createProgram(gl, vs, fs);
        this._rebuildGridMesh();
      } else {
        const fs = buildDirectFragSrc(this.pixelCode, this._bridgedVars, this._localVars);
        prog = createProgram(gl, vertSrc, fs);
      }

      if (this._prog) gl.deleteProgram(this._prog);
      this._prog = prog;

      const u = this._uniforms = {};
      u.source         = gl.getUniformLocation(prog, 'uSource');
      u.input          = gl.getUniformLocation(prog, 'uInput');
      u.rectCoords     = gl.getUniformLocation(prog, 'uRectCoords');
      u.wrap           = gl.getUniformLocation(prog, 'uWrap');
      u.blend          = gl.getUniformLocation(prog, 'uBlend');
      u.noMove         = gl.getUniformLocation(prog, 'uNoMove');
      u.showUV         = gl.getUniformLocation(prog, 'uShowUV');
      u.sameBuffer     = gl.getUniformLocation(prog, 'uSameBuffer');
      u.bilinearCompat = gl.getUniformLocation(prog, 'uBilinearCompat');
      u.W              = gl.getUniformLocation(prog, 'w');
      u.H              = gl.getUniformLocation(prog, 'h');
      u.B              = gl.getUniformLocation(prog, 'b');
      u.audioData      = gl.getUniformLocation(prog, 'uAudioData');
      u._dyn = {};
      for (const name of this._bridgedVars) {
        u._dyn[name] = gl.getUniformLocation(prog, name);
      }
      this._compileError = '';
    } catch (e) {
      this._compileError = e.message;
    }
  }

  _rebuildGridMesh() {
    const gl = this.gl;
    const gw = Math.max(1, this.gridW);
    const gh = Math.max(1, this.gridH);
    const verts = buildGridMesh(gw, gh);
    this._gridVertCount = verts.length / 2;

    if (!this._gridVAO) {
      this._gridVAO = gl.createVertexArray();
      this._gridVBO = gl.createBuffer();
    }

    gl.bindVertexArray(this._gridVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._gridVBO);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  _runInit() {
    this._jsScope.b = 0;
    this._runJS(this.initCode, 'initCode');
    this._inited = true;
  }

  setPixelCode(src) {
    this.pixelCode = src;
    this._rescanAndCompile();
  }

  getCompileError() { return this._compileError; }

  render(ctx) {
    if (!this._prog) return;
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;
    const bVal = isBeat ? 1 : 0;

    this._visdata = ctx.visdata;
    this._jsScope.w = w;
    this._jsScope.h = h;
    if (!this._inited) this._runInit();
    this._jsScope.b = bVal;
    this._runJS(this.frameCode, 'frameCode');
    if (isBeat) this._runJS(this.beatCode, 'beatCode');

    const srcTex = this.bufferN === 0
      ? inputTex
      : fboManager.getScratch(this.bufferN - 1).texture;

    // bilinearCompat does integer sampling manually — always use NEAREST there.
    const filter = (!this.bilinearCompat && this.bilinear) ? gl.LINEAR : gl.NEAREST;
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);

    const u = this._uniforms;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(u.input, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(u.source, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, ctx.audioTex);
    gl.uniform1i(u.audioData, 2);

    gl.uniform1i(u.rectCoords,     this.rectCoords     ? 1 : 0);
    gl.uniform1i(u.wrap,           this.wrap           ? 1 : 0);
    gl.uniform1i(u.blend,          this.blend          ? 1 : 0);
    gl.uniform1i(u.noMove,         this.noMove         ? 1 : 0);
    gl.uniform1i(u.showUV,         this.showUV         ? 1 : 0);
    gl.uniform1i(u.sameBuffer,     this.bufferN === 0  ? 1 : 0);
    gl.uniform1i(u.bilinearCompat, this.bilinearCompat ? 1 : 0);
    gl.uniform1f(u.W, w);
    gl.uniform1f(u.H, h);
    gl.uniform1f(u.B, bVal);

    const scope = this._jsScope;
    for (const [name, loc] of Object.entries(u._dyn ?? {})) {
      gl.uniform1f(loc, scope[name] ?? 0);
    }

    if (this.useGrid && this._gridVAO) {
      gl.bindVertexArray(this._gridVAO);
      gl.drawArrays(gl.TRIANGLES, 0, this._gridVertCount);
      gl.bindVertexArray(null);
    } else {
      const vao = getQuadVAO(gl);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    }

    fboManager.swap();
  }

  getConfig() {
    return {
      pixelCode:      this.pixelCode,
      frameCode:      this.frameCode,
      beatCode:       this.beatCode,
      initCode:       this.initCode,
      rectCoords:     this.rectCoords,
      wrap:           this.wrap,
      blend:          this.blend,
      bilinear:       this.bilinear,
      bilinearCompat: this.bilinearCompat,
      noMove:         this.noMove,
      showUV:         this.showUV,
      bufferN:        this.bufferN,
      useGrid:        this.useGrid,
      gridW:          this.gridW,
      gridH:          this.gridH,
    };
  }

  setConfig(cfg) {
    let needsRecompile = false;
    let runInit = false, runFrame = false, runBeat = false;
    if (cfg.pixelCode !== undefined && cfg.pixelCode !== this.pixelCode) { this.pixelCode = cfg.pixelCode; needsRecompile = true; }
    if (cfg.frameCode !== undefined && cfg.frameCode !== this.frameCode) { this.frameCode = cfg.frameCode; needsRecompile = true; runFrame = true; }
    if (cfg.beatCode  !== undefined && cfg.beatCode  !== this.beatCode)  { this.beatCode  = cfg.beatCode;  needsRecompile = true; runBeat  = true; }
    if (cfg.initCode  !== undefined && cfg.initCode  !== this.initCode)  { this.initCode  = cfg.initCode;  needsRecompile = true; runInit  = true; }
    if (cfg.rectCoords     !== undefined) this.rectCoords     = cfg.rectCoords;
    if (cfg.wrap           !== undefined) this.wrap           = cfg.wrap;
    if (cfg.blend          !== undefined) this.blend          = cfg.blend;
    if (cfg.bilinear       !== undefined) this.bilinear       = cfg.bilinear;
    if (cfg.bilinearCompat !== undefined) this.bilinearCompat = cfg.bilinearCompat;
    if (cfg.noMove         !== undefined) this.noMove         = cfg.noMove;
    if (cfg.showUV         !== undefined) this.showUV         = cfg.showUV;
    if (cfg.bufferN        !== undefined) this.bufferN        = cfg.bufferN;
    if (cfg.useGrid !== undefined && cfg.useGrid !== this.useGrid) {
      this.useGrid = cfg.useGrid;
      needsRecompile = true;
    }
    if (cfg.gridW !== undefined && cfg.gridW !== this.gridW) {
      this.gridW = cfg.gridW;
      if (this.useGrid && !needsRecompile) this._rebuildGridMesh();
    }
    if (cfg.gridH !== undefined && cfg.gridH !== this.gridH) {
      this.gridH = cfg.gridH;
      if (this.useGrid && !needsRecompile) this._rebuildGridMesh();
    }
    if (needsRecompile) this._rescanAndCompile();
    if (runInit)  { this._inited = false; this._jsScope.b = 0; this._runJS(this.initCode,  'initCode'); this._inited = true; }
    if (runFrame) { this._jsScope.b = 0; this._runJS(this.frameCode, 'frameCode'); }
    if (runBeat)  { this._jsScope.b = 1; this._runJS(this.beatCode,  'beatCode'); }
  }

  getDescriptor() {
    const bufferOptions = [{ value: 0, label: 'Current' }];
    for (let i = 1; i <= 8; i++) bufferOptions.push({ value: i, label: `Buffer ${i}` });
    return {
      name: 'Dynamic Movement',
      params: [
        { name: 'rectCoords',     label: 'Cartesian Coords',   type: 'bool',   default: false },
        { name: 'wrap',           label: 'Wrap',               type: 'bool',   default: false },
        { name: 'blend',          label: 'Blend',              type: 'bool',   default: false },
        { name: 'bilinear',       label: 'Bilinear',           type: 'bool',   default: false },
        { name: 'bilinearCompat', label: 'Bilinear (precise)', type: 'bool',   default: false },
        { name: 'noMove',         label: 'No Movement',        type: 'bool',   default: false },
        { name: 'showUV',         label: 'Show UV (debug)',     type: 'bool',   default: false },
        { name: 'useGrid',        label: 'Use Grid',           type: 'bool',   default: true  },
        { name: 'gridW',          label: 'Grid Width',         type: 'int',    default: 16, min: 1 },
        { name: 'gridH',          label: 'Grid Height',        type: 'int',    default: 16, min: 1 },
        { name: 'bufferN',        label: 'Source Buffer',      type: 'select', options: bufferOptions, default: 0 },
        { name: 'pixelCode',      label: 'Pixel',              type: 'glsl',   default: DEFAULT_PIXEL },
        { name: 'frameCode',      label: 'Frame',              type: 'js',     default: DEFAULT_FRAME },
        { name: 'beatCode',       label: 'Beat',               type: 'js',     default: DEFAULT_BEAT  },
        { name: 'initCode',       label: 'Init',               type: 'js',     default: DEFAULT_INIT  },
      ],
    };
  }

  destroy() {
    const gl = this.gl;
    if (this._prog) gl.deleteProgram(this._prog);
    if (this._gridVBO) gl.deleteBuffer(this._gridVBO);
    if (this._gridVAO) gl.deleteVertexArray(this._gridVAO);
  }
}
