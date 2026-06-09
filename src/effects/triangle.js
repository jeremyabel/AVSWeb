import { ScriptableEffect, scanVarDecls } from './scriptable-effect.js';
import { createProgram, getQuadVAO } from './effect.js';
import { makeAudioScope } from '../core/audio-data.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Composite canvas overlay onto input; transparent pixels show input.
const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform sampler2D uOverlay;
out vec4 fragColor;
void main() {
  vec4 ov = texture(uOverlay, vUv);
  vec4 base = texture(uInput, vUv);
  if (ov.a < 0.5) { fragColor = base; return; }
  fragColor = vec4(ov.rgb, 1.0);
}`;

// These are seeded by the engine each frame; never treated as user 'var' declarations.
const BUILTIN_VARS = new Set([
  'w', 'h', 'n', 'i', 'b', 'skip',
  'x1', 'y1', 'red1', 'green1', 'blue1',
  'x2', 'y2', 'red2', 'green2', 'blue2',
  'x3', 'y3', 'red3', 'green3', 'blue3',
  'z1', 'zbuf', 'zbclear',
  'getspec', 'getosc',
]);

export class TriangleEffect extends ScriptableEffect {
  constructor(gl) {
    super(gl, 'Triangle');

    // Code sections
    this.initCode     = '';
    this.frameCode    = '';
    this.beatCode     = '';
    this.triangleCode = '';

    // Persistent scope. n/i/z1/zbuf/zbclear are NOT reset each frame (see C++ Triangle_Vars::init).
    // x1..y3 and red/green/blue reset to defaults each frame.
    this._jsScope = {
      w: 0, h: 0, n: 0, i: 0, b: 0, skip: 0,
      x1: 0, y1: 0, red1: 1, green1: 1, blue1: 1,
      x2: 0, y2: 0, red2: 1, green2: 1, blue2: 1,
      x3: 0, y3: 0, red3: 1, green3: 1, blue3: 1,
      z1: 0, zbuf: 0, zbclear: 0,
    };

    this._visdata    = null;
    this._inited     = false;
    this._scopeKeys  = null;
    this._triangleFn = null;

    // Canvas for 2D drawing; uploaded each frame as a WebGL texture overlay.
    this._canvas = document.createElement('canvas');
    this._ctx2d  = this._canvas.getContext('2d');
    this._tex    = null;
    this._texW   = 0;
    this._texH   = 0;

    const { getspec, getosc } = makeAudioScope(() => this._visdata);
    this._jsScope.getspec = getspec;
    this._jsScope.getosc  = getosc;

    this._rescanVars();
    this._compileTriangle();
    // n is already 0 in initial scope, so init code sees n=0 (matches C++)
    this._runJS(this.initCode, 'initCode');
    this._inited = true;

    this._prog     = createProgram(gl, vertSrc, FRAG);
    this._uInput   = gl.getUniformLocation(this._prog, 'uInput');
    this._uOverlay = gl.getUniformLocation(this._prog, 'uOverlay');
  }

  // ── Scope management ─────────────────────────────────────────────────────────

  _rescanVars() {
    const userVars = scanVarDecls(this.initCode, BUILTIN_VARS);
    for (const v of userVars) {
      if (!(v in this._jsScope)) this._jsScope[v] = 0;
    }
    this._scopeKeys = null;
  }

  _getScopeKeys() {
    if (!this._scopeKeys) this._scopeKeys = Object.keys(this._jsScope);
    return this._scopeKeys;
  }

  // ── Compilation ──────────────────────────────────────────────────────────────

  // Compiles triangleCode into a cached Function called N times per frame.
  _compileTriangle() {
    const code = this.triangleCode;
    if (!code?.trim()) { this._triangleFn = null; delete this._jsErrors.triangleCode; return; }
    const keys = this._getScopeKeys();
    try {
      this._triangleFn = new Function(...keys, `${code}\nreturn{${keys.join(',')}}`);
      delete this._jsErrors.triangleCode;
    } catch (e) {
      this._triangleFn = null;
      this._jsErrors.triangleCode = e.message;
      console.error('Triangle triangleCode:', e);
    }
  }

  // ── GL texture ───────────────────────────────────────────────────────────────

  _ensureTex(gl, w, h) {
    if (this._texW === w && this._texH === h) return;
    this._texW = w; this._texH = h;
    this._canvas.width  = w;
    this._canvas.height = h;
    if (this._tex) gl.deleteTexture(this._tex);
    this._tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  render(ctx) {
    const { gl, visdata, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    this._ensureTex(gl, w, h);

    this._visdata = visdata;
    const scope = this._jsScope;
    const bVal  = isBeat ? 1 : 0;

    // Per-frame reset — matches C++ Triangle_Vars::init.
    // n, i, z1, zbuf, zbclear are intentionally NOT reset (they persist across frames).
    scope.w  = w;  scope.h  = h;  scope.b  = bVal;
    scope.x1 = 0;  scope.y1 = 0;
    scope.x2 = 0;  scope.y2 = 0;
    scope.x3 = 0;  scope.y3 = 0;
    scope.red1   = 1; scope.green1 = 1; scope.blue1 = 1;
    scope.red2   = 1; scope.green2 = 1; scope.blue2 = 1;
    scope.red3   = 1; scope.green3 = 1; scope.blue3 = 1;

    // Init runs once; n is already 0 in the initial scope (matches C++ `*vars.n = 0` before init).
    if (!this._inited) {
      scope.n = 0;
      this._runJS(this.initCode, 'initCode');
      this._inited = true;
    }

    this._runJS(this.frameCode, 'frameCode');
    if (isBeat) this._runJS(this.beatCode, 'beatCode');

    // ── Draw triangles ──────────────────────────────────────────────────────────

    const c2d = this._ctx2d;
    c2d.clearRect(0, 0, w, h);

    const n = Math.round(scope.n);
    if (n > 0 && this._triangleFn) {
      // step: i goes from 0..1 across the n triangles (or 1.0 for n=1)
      const step = n > 1 ? 1.0 / (n - 1) : 1.0;
      const keys = this._getScopeKeys();
      const useZbuf = scope.zbuf !== 0;

      // Collect triangle data (needed for z-sort)
      const tris = [];
      let triErr = null;

      // Reset i to 0 at loop start (frame code sees i from the previous frame's last triangle)
      let triI = 0.0;
      scope.i = triI;

      for (let k = 0; k < n; k++) {
        scope.skip = 0;

        const vals = keys.map(key => scope[key]);
        try {
          const result = this._triangleFn(...vals);
          for (const key of keys) {
            if (typeof result[key] === 'number') scope[key] = result[key];
          }
        } catch (e) {
          triErr = triErr ?? e;
          triI += step;
          scope.i = triI;
          continue;
        }

        if (scope.skip === 0) {
          // Only red1/green1/blue1 used for fill color — matches C++ which ignores vertex 2/3 colors.
          tris.push({
            x1: scope.x1, y1: scope.y1,
            x2: scope.x2, y2: scope.y2,
            x3: scope.x3, y3: scope.y3,
            r: scope.red1, g: scope.green1, b: scope.blue1,
            z: scope.z1,
          });
        }

        triI += step;
        scope.i = triI;
        // After loop: scope.i = 1.0 + step (for n>1), which persists to next frame's frame code.
      }

      if (triErr) this._jsErrors.triangleCode = triErr.message;
      else        delete this._jsErrors.triangleCode;

      // Z-sort: painter's algorithm (back→front) when zbuf is enabled.
      // Note: the C++ uses a persistent per-pixel depth buffer; we approximate
      // with painter's algorithm, which is correct for non-intersecting triangles.
      if (useZbuf) tris.sort((a, b) => a.z - b.z);

      // World coords [-1,+1] → canvas coords.
      // Y is inverted: canvas uploads to GL texture Y-flipped, so we invert here
      // to match the original (y=-1 = screen top, y=+1 = screen bottom).
      const hw = w / 2, hh = h / 2;

      for (const tri of tris) {
        const cx1 = (tri.x1 + 1.0) * hw;
        const cy1 = (1.0 - (tri.y1 + 1.0) * 0.5) * h;
        const cx2 = (tri.x2 + 1.0) * hw;
        const cy2 = (1.0 - (tri.y2 + 1.0) * 0.5) * h;
        const cx3 = (tri.x3 + 1.0) * hw;
        const cy3 = (1.0 - (tri.y3 + 1.0) * 0.5) * h;

        const ri = Math.max(0, Math.min(255, tri.r * 255)) | 0;
        const gi = Math.max(0, Math.min(255, tri.g * 255)) | 0;
        const bi = Math.max(0, Math.min(255, tri.b * 255)) | 0;

        c2d.fillStyle = `rgb(${ri},${gi},${bi})`;
        c2d.beginPath();
        c2d.moveTo(cx1, cy1);
        c2d.lineTo(cx2, cy2);
        c2d.lineTo(cx3, cy3);
        c2d.closePath();
        c2d.fill();
      }
    }

    // Upload canvas overlay and composite over input texture.
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._canvas);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.uniform1i(this._uOverlay, 1);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    fboManager.swap();
  }

  // ── Config ────────────────────────────────────────────────────────────────────

  getConfig() {
    return {
      initCode:     this.initCode,
      frameCode:    this.frameCode,
      beatCode:     this.beatCode,
      triangleCode: this.triangleCode,
    };
  }

  setConfig(cfg) {
    if (cfg.initCode !== undefined && cfg.initCode !== this.initCode) {
      this.initCode = cfg.initCode;
      this._rescanVars();
      this._compileTriangle();
      this._inited = false;
    }
    if (cfg.frameCode    !== undefined) this.frameCode    = cfg.frameCode;
    if (cfg.beatCode     !== undefined) this.beatCode     = cfg.beatCode;
    if (cfg.triangleCode !== undefined && cfg.triangleCode !== this.triangleCode) {
      this.triangleCode = cfg.triangleCode;
      this._compileTriangle();
    }
  }

  getDescriptor() {
    return {
      name: 'Triangle',
      params: [
        { name: 'initCode',     label: 'Init',     type: 'js', default: '' },
        { name: 'frameCode',    label: 'Frame',    type: 'js', default: '' },
        { name: 'beatCode',     label: 'Beat',     type: 'js', default: '' },
        { name: 'triangleCode', label: 'Triangle', type: 'js', default: '' },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._tex) this.gl.deleteTexture(this._tex);
  }
}
