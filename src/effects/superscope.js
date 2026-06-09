import { ScriptableEffect, scanVarDecls } from './scriptable-effect.js';
import { createProgram, getQuadVAO } from './effect.js';
import { makeAudioScope } from '../core/audio-data.js';
import { drawLine, setPixel } from '../core/line-draw.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const DEFAULT_INIT  = `n = 800;`;
const DEFAULT_FRAME = `t = t - 0.05;`;
const DEFAULT_BEAT  = ``;
const DEFAULT_POINT = `d = i + v * 0.2;\nr = t + i * Math.PI * 4;\nx = Math.cos(r) * d;\ny = Math.sin(r) * d;`;

// Built-in vars that are set by the engine — never treated as user 'var' declarations.
const BUILTIN_VARS = new Set([
  'n', 'b', 'x', 'y', 'i', 'v', 'w', 'h',
  'red', 'green', 'blue', 'linesize', 'skip', 'drawmode',
  'getspec', 'getosc',
]);

const BINS = 576;

// Hex 0xRRGGBB → {r,g,b} in [0,1]
function hexToRgb(hex) {
  return {
    r: ((hex >> 16) & 0xff) / 255,
    g: ((hex >>  8) & 0xff) / 255,
    b: ( hex        & 0xff) / 255,
  };
}

const BLIT_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBase;
uniform sampler2D uOverlay;
uniform int uBlend;
out vec4 fragColor;
void main() {
  vec4 base = texture(uBase, vUv);
  vec4 over = texture(uOverlay, vUv);
  if (over.a > 0.0) {
    if (uBlend == 1) fragColor = vec4(min(base.rgb + over.rgb, vec3(1.0)), 1.0);
    else             fragColor = vec4(over.rgb, 1.0);
  } else {
    fragColor = base;
  }
}`;

export class SuperScopeEffect extends ScriptableEffect {
  constructor(gl) {
    super(gl, 'SuperScope');
    this.initCode    = DEFAULT_INIT;
    this.frameCode   = DEFAULT_FRAME;
    this.beatCode    = DEFAULT_BEAT;
    this.pointCode   = DEFAULT_POINT;
    this.colors      = [0xffffff];
    this.audioSource  = 0;   // 0 = Waveform, 1 = Spectrum
    this.audioChannel = 0;   // 0 = Center, 1 = Left, 2 = Right
    this.drawMode    = 1;    // 0 = Dots, 1 = Lines (global default, overridable per-point)
    this.blend       = 0;    // 0 = Replace, 1 = Additive

    this._colorPos = 0;
    this._visdata  = null;

    // Persistent scope shared across init / frame / beat / point code.
    // red/green/blue/linesize/drawmode are reset each frame from color cycling + config.
    // i, v, skip are overwritten per point before point code runs.
    // n and all user-declared vars persist across frames.
    this._jsScope = {
      n: 800, b: 0,
      x: 0, y: 0, i: 0, v: 0,
      w: 0, h: 0,
      red: 1, green: 1, blue: 1,
      linesize: 1, skip: 0, drawmode: 1,
    };
    const { getspec, getosc } = makeAudioScope(() => this._visdata);
    this._jsScope.getspec = getspec;
    this._jsScope.getosc  = getosc;

    this._inited    = false;
    this._scopeKeys = null;   // cached Object.keys(_jsScope), invalidated on rescan
    this._pointFn   = null;   // compiled point-code Function, rebuilt on pointCode / scope change

    this._rescanVars();
    this._compilePoint();
    this._runJS(this.initCode, 'initCode');
    this._inited = true;

    this._blitProg = createProgram(gl, vertSrc, BLIT_FRAG);
    this._uBase    = gl.getUniformLocation(this._blitProg, 'uBase');
    this._uOverlay = gl.getUniformLocation(this._blitProg, 'uOverlay');
    this._uBlendU  = gl.getUniformLocation(this._blitProg, 'uBlend');

    this._overlayTex = gl.createTexture();
    this._overlayW = 0;
    this._overlayH = 0;
    this._overlayBuf = null;
  }

  // ── Scope management ─────────────────────────────────────────────────────────

  _rescanVars() {
    const bridged = scanVarDecls(this.initCode, BUILTIN_VARS);
    for (const v of bridged) {
      if (!(v in this._jsScope)) this._jsScope[v] = 0;
    }
    this._scopeKeys = null;
  }

  _getScopeKeys() {
    if (!this._scopeKeys) this._scopeKeys = Object.keys(this._jsScope);
    return this._scopeKeys;
  }

  // ── Compilation ──────────────────────────────────────────────────────────────

  // Compile the per-point function and cache it. Called whenever pointCode or
  // the scope shape changes. The returned Function is called N times per frame.
  _compilePoint() {
    const code = this.pointCode;
    if (!code?.trim()) { this._pointFn = null; delete this._jsErrors.pointCode; return; }
    const keys = this._getScopeKeys();
    try {
      this._pointFn = new Function(...keys, `${code}\nreturn{${keys.join(',')}}`);
      delete this._jsErrors.pointCode;
      // Dry-run with current scope to catch ReferenceErrors from undeclared identifiers
      // (e.g. 'Mafth', 'rf') eagerly, before the UI error div is refreshed.
      // TypeErrors are ignored — they can come from null visdata at construction time.
      const vals = keys.map(k => this._jsScope[k]);
      try { this._pointFn(...vals); } catch (e) {
        if (e instanceof ReferenceError) this._jsErrors.pointCode = e.message;
      }
    } catch (e) {
      this._pointFn = null;
      this._jsErrors.pointCode = e.message;
      console.error('SuperScope pointCode:', e);
    }
  }

  // ── Color cycling ─────────────────────────────────────────────────────────────

  // Mirrors the original's color_pos counter: cycles over colors.length × 64 steps,
  // linearly interpolating between adjacent colors.
  _advanceColor() {
    const colors = this.colors;
    if (!colors.length) return { r: 1, g: 1, b: 1 };
    const total = colors.length * 64;
    this._colorPos = (this._colorPos + 1) % total;
    const p    = Math.floor(this._colorPos / 64);
    const frac = this._colorPos % 64;
    const c1   = hexToRgb(colors[p]);
    const c2   = hexToRgb(colors[(p + 1) % colors.length]);
    return {
      r: (c1.r * (63 - frac) + c2.r * frac) / 63,
      g: (c1.g * (63 - frac) + c2.g * frac) / 63,
      b: (c1.b * (63 - frac) + c2.b * frac) / 63,
    };
  }

  // ── Audio sampling ────────────────────────────────────────────────────────────

  // Linearly interpolated audio sample for point pi of n, matching the original's
  // fractional bin indexing. Returns -1..+1 for waveform, 0..+1 for spectrum.
  _sampleAudio(pi, n, visdata) {
    const isWave = this.audioSource === 0;
    const src    = isWave ? 1 : 0;         // visdata[0]=spectrum, visdata[1]=waveform
    const ch     = this.audioChannel;

    const fracIdx = (pi * BINS) / n;
    const idx0    = Math.min(Math.floor(fracIdx), BINS - 1);
    const idx1    = Math.min(idx0 + 1, BINS - 1);
    const lerp    = fracIdx - idx0;

    let s0, s1;
    if (ch === 0) {
      s0 = (visdata[src][0][idx0] + visdata[src][1][idx0]) * 0.5;
      s1 = (visdata[src][0][idx1] + visdata[src][1][idx1]) * 0.5;
    } else {
      s0 = visdata[src][ch - 1][idx0];
      s1 = visdata[src][ch - 1][idx1];
    }

    const raw = s0 * (1 - lerp) + s1 * lerp;
    return isWave ? (raw - 128) / 128 : raw / 255;
  }

  // ── Overlay texture ───────────────────────────────────────────────────────────

  _ensureOverlay(gl, w, h) {
    if (this._overlayW === w && this._overlayH === h) return;
    this._overlayW = w; this._overlayH = h;
    this._overlayBuf = new Uint8Array(w * h * 4);
    gl.bindTexture(gl.TEXTURE_2D, this._overlayTex);
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
    this._ensureOverlay(gl, w, h);

    this._visdata = visdata;
    const bVal  = isBeat ? 1 : 0;
    const color = this._advanceColor();
    const scope = this._jsScope;

    // Reset per-frame vars; user code may override any of these.
    scope.b        = bVal;
    scope.w        = w;
    scope.h        = h;
    scope.red      = color.r;
    scope.green    = color.g;
    scope.blue     = color.b;
    scope.linesize = 1;
    scope.drawmode = this.drawMode;

    if (!this._inited) {
      this._runJS(this.initCode, 'initCode');
      this._inited = true;
    }
    this._runJS(this.frameCode, 'frameCode');
    if (isBeat) this._runJS(this.beatCode, 'beatCode');

    // Draw points into the CPU overlay buffer.
    const buf = this._overlayBuf;
    buf.fill(0);

    if (this._pointFn) {
      const n    = Math.max(1, Math.min(Math.round(scope.n), 128 * 1024));
      const keys = this._getScopeKeys();
      let lx = 0, ly = 0, hadPrev = false;
      let pointErr = null;

      for (let pi = 0; pi < n; pi++) {
        scope.i    = n > 1 ? pi / (n - 1) : 0;
        scope.v    = this._sampleAudio(pi, n, visdata);
        scope.skip = 0;

        const vals = keys.map(k => scope[k]);
        let result;
        try { result = this._pointFn(...vals); } catch (e) { pointErr = pointErr ?? e; hadPrev = false; continue; }
        for (const k of keys) {
          if (typeof result[k] === 'number') scope[k] = result[k];
        }

        if (scope.skip > 0) { hadPrev = false; continue; }

        const ri = Math.max(0, Math.min(255, scope.red   * 255 + 0.5)) | 0;
        const gi = Math.max(0, Math.min(255, scope.green * 255 + 0.5)) | 0;
        const bi = Math.max(0, Math.min(255, scope.blue  * 255 + 0.5)) | 0;

        // x,y in [-1,+1]; original convention: x=-1 left, x=+1 right, y=-1 top, y=+1 bottom.
        // Our CPU buffer row 0 is uploaded to GL texture y=0 (screen bottom due to GL's
        // bottom-up convention), so we invert Y here to match the original screen mapping.
        const px = (scope.x  + 1.0) * 0.5 * w;
        const py = (1.0 - (scope.y + 1.0) * 0.5) * h;

        if (scope.drawmode > 0 && hadPrev) {
          drawLine(buf, lx, ly, px, py, w, h, ri, gi, bi);
        } else {
          setPixel(buf, px, py, w, h, ri, gi, bi);
        }
        lx = px; ly = py; hadPrev = true;
      }

      if (pointErr) this._jsErrors.pointCode = pointErr.message;
      else delete this._jsErrors.pointCode;
    }

    // Upload and composite onto the current frame.
    gl.bindTexture(gl.TEXTURE_2D, this._overlayTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uBase, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._overlayTex);
    gl.uniform1i(this._uOverlay, 1);
    gl.uniform1i(this._uBlendU, this.blend);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  // ── Config ────────────────────────────────────────────────────────────────────

  getConfig() {
    return {
      initCode:     this.initCode,
      frameCode:    this.frameCode,
      beatCode:     this.beatCode,
      pointCode:    this.pointCode,
      colors:       this.colors,
      audioSource:  this.audioSource,
      audioChannel: this.audioChannel,
      drawMode:     this.drawMode,
      blend:        this.blend,
    };
  }

  setConfig(cfg) {
    let needsRescan    = false;
    let needsRecompile = false;

    if (cfg.initCode  !== undefined && cfg.initCode  !== this.initCode)  { this.initCode  = cfg.initCode;  needsRescan = true; }
    if (cfg.frameCode !== undefined && cfg.frameCode !== this.frameCode) { this.frameCode = cfg.frameCode; needsRescan = true; }
    if (cfg.beatCode  !== undefined && cfg.beatCode  !== this.beatCode)  { this.beatCode  = cfg.beatCode;  needsRescan = true; }
    if (cfg.pointCode !== undefined && cfg.pointCode !== this.pointCode) { this.pointCode = cfg.pointCode; needsRescan = true; }
    if (cfg.colors       !== undefined) this.colors       = cfg.colors;
    if (cfg.audioSource  !== undefined) this.audioSource  = cfg.audioSource;
    if (cfg.audioChannel !== undefined) this.audioChannel = cfg.audioChannel;
    if (cfg.drawMode     !== undefined) this.drawMode     = cfg.drawMode;
    if (cfg.blend        !== undefined) this.blend        = cfg.blend;

    if (needsRescan)    { this._rescanVars(); needsRecompile = true; }
    if (needsRecompile)   this._compilePoint();
    if (needsRescan)    { this._inited = false; this._runJS(this.initCode, 'initCode'); this._inited = true; }
  }

  getDescriptor() {
    return {
      name: 'SuperScope',
      params: [
        { name: 'initCode',  label: 'Init',  type: 'js', default: DEFAULT_INIT  },
        { name: 'frameCode', label: 'Frame', type: 'js', default: DEFAULT_FRAME },
        { name: 'beatCode',  label: 'Beat',  type: 'js', default: DEFAULT_BEAT  },
        { name: 'pointCode', label: 'Point', type: 'js', default: DEFAULT_POINT },
        { name: 'colors',    label: 'Colors', type: 'colors', default: [0xffffff] },
        { name: 'audioSource',  label: 'Source',  type: 'select', options: [
          { value: 0, label: 'Waveform' }, { value: 1, label: 'Spectrum' },
        ], default: 0 },
        { name: 'audioChannel', label: 'Channel', type: 'select', options: [
          { value: 0, label: 'Center' }, { value: 1, label: 'Left' }, { value: 2, label: 'Right' },
        ], default: 0 },
        { name: 'drawMode', label: 'Draw Mode', type: 'select', options: [
          { value: 0, label: 'Dots' }, { value: 1, label: 'Lines' },
        ], default: 1 },
        { name: 'blend', label: 'Blend', type: 'select', options: [
          { value: 0, label: 'Replace' }, { value: 1, label: 'Additive' },
        ], default: 0 },
      ],
    };
  }

  destroy() {
    const gl = this.gl;
    gl.deleteProgram(this._blitProg);
    gl.deleteTexture(this._overlayTex);
  }
}
