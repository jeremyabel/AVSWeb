import { ScriptableEffect, scanVarDecls } from './scriptable-effect.js';
import { createProgram, getQuadVAO } from './effect.js';
import { EffectEntry } from '../core/effect-chain.js';
import { EffectRegistry } from '../core/registry.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const BUILTIN_VARS = new Set(['enabled', 'beat', 'clear', 'alphain', 'alphaout', 'w', 'h']);

// Original enum (e_effectlist.h EffectList_Blend_Modes):
// 0=Ignore  1=Replace  2=50/50  3=Maximum  4=Additive
// 5=Sub1(base-src)  6=Sub2(src-base)  7=EveryOtherLine  8=EveryOtherPixel
// 9=XOR  10=Adjustable  11=Multiply  12=Buffer  13=Minimum
const BLEND_OPTIONS = [
  { value: 0,  label: 'Ignore'            },
  { value: 1,  label: 'Replace'           },
  { value: 2,  label: '50/50'             },
  { value: 3,  label: 'Maximum'           },
  { value: 4,  label: 'Additive'          },
  { value: 5,  label: 'Subtractive 1'     },
  { value: 6,  label: 'Subtractive 2'     },
  { value: 7,  label: 'Every Other Line'  },
  { value: 8,  label: 'Every Other Pixel' },
  { value: 9,  label: 'XOR'              },
  { value: 10, label: 'Adjustable'        },
  { value: 11, label: 'Multiply'          },
  { value: 12, label: 'Buffer'            },
  { value: 13, label: 'Minimum'           },
];

// Blend shader — mode values match the original enum exactly.
// uBase: destination (what gets blended into), uSrc: source (what's blending in).
// For input blend:  uBase=internal buffer, uSrc=parent frame
// For output blend: uBase=parent frame,    uSrc=internal result
const BLEND_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBase;
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform int   uMode;
uniform float uAmount;
uniform bool  uMaskInvert;
out vec4 fragColor;
void main() {
  vec3 b = texture(uBase, vUv).rgb;
  vec3 s = texture(uSrc,  vUv).rgb;
  vec3 r;
  if      (uMode == 0)  r = b;                               // Ignore   — keep base
  else if (uMode == 1)  r = s;                               // Replace  — take src
  else if (uMode == 2)  r = (b + s) * 0.5;                  // 50/50
  else if (uMode == 3)  r = max(b, s);                       // Maximum
  else if (uMode == 4)  r = clamp(b + s, 0.0, 1.0);         // Additive
  else if (uMode == 5)  r = clamp(b - s, 0.0, 1.0);         // Sub 1 (base − src)
  else if (uMode == 6)  r = clamp(s - b, 0.0, 1.0);         // Sub 2 (src − base)
  else if (uMode == 7) {                                     // Every Other Line
    r = (int(gl_FragCoord.y) % 2 == 0) ? s : b;
  }
  else if (uMode == 8) {                                     // Every Other Pixel
    r = ((int(gl_FragCoord.x) + int(gl_FragCoord.y)) % 2 == 0) ? s : b;
  }
  else if (uMode == 9) {                                     // XOR (8-bit per channel)
    ivec3 bi = ivec3(b * 255.0 + 0.5);
    ivec3 si = ivec3(s * 255.0 + 0.5);
    r = vec3(bi ^ si) / 255.0;
  }
  else if (uMode == 10) r = mix(b, s, clamp(uAmount, 0.0, 1.0)); // Adjustable
  else if (uMode == 11) r = b * s;                           // Multiply
  else if (uMode == 12) {                                    // Buffer (mask-based lerp)
    vec3 mask = texture(uMask, vUv).rgb;
    float alpha = max(max(mask.r, mask.g), mask.b);
    if (uMaskInvert) alpha = 1.0 - alpha;
    r = mix(b, s, alpha);
  }
  else                  r = min(b, s);                       // Minimum (13)
  fragColor = vec4(r, 1.0);
}`;

function makeRGBAFBO(gl, w, h) {
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
  return { fbo, texture: tex };
}

export class EffectListEffect extends ScriptableEffect {
  constructor(gl) {
    super(gl, 'EffectList');
    this.entries    = [];   // EffectEntry[]

    // Default values match original (e_effectlist.h EffectList_Config):
    //   input_blend_mode  = LIST_BLEND_IGNORE  = 0
    //   output_blend_mode = LIST_BLEND_REPLACE  = 1
    //   clear_every_frame = false
    this.onBeat       = false;
    this.onBeatFrames = 1;
    this._onBeatCooldown = 0;

    this.inBlend    = 0;    // 0=Ignore: don't blend parent into internal buffer
    this.outBlend   = 1;    // 1=Replace: copy internal result onto parent output
    this.clearFrame = false;
    this.blendAmt   = 0.5;  // alpha for Adjustable mode (0..1 = 0..255 in original)
    this.inBlendBuf  = 0;   // scratch buffer index (0-7) for Buffer input blend
    this.outBlendBuf = 0;   // scratch buffer index (0-7) for Buffer output blend
    this.inBlendBufInvert  = false;
    this.outBlendBufInvert = false;

    // JS code blocks
    this.useCode   = false;
    this.initCode  = '';
    this.frameCode = '';
    this._jsScope  = { enabled: 1, beat: 0, clear: 0, alphain: 0.5, alphaout: 0.5, w: 0, h: 0 };
    this._needInit = true;

    // Two persistent internal FBOs that sub-effects ping-pong between.
    // They persist across frames when clearFrame=false, matching original list_framebuffer.
    this._internal = [null, null];
    this._inIdx = 0;
    this._inW = 0; this._inH = 0;

    this._blendProg = createProgram(gl, vertSrc, BLEND_FRAG);
    this._uBase       = gl.getUniformLocation(this._blendProg, 'uBase');
    this._uSrc        = gl.getUniformLocation(this._blendProg, 'uSrc');
    this._uMask       = gl.getUniformLocation(this._blendProg, 'uMask');
    this._uMode       = gl.getUniformLocation(this._blendProg, 'uMode');
    this._uAmount     = gl.getUniformLocation(this._blendProg, 'uAmount');
    this._uMaskInvert = gl.getUniformLocation(this._blendProg, 'uMaskInvert');
  }

  addEntry(effect) {
    const entry = new EffectEntry(effect);
    this.entries.push(entry);
    return entry;
  }

  removeEntry(index) {
    const [removed] = this.entries.splice(index, 1);
    removed.effect.destroy();
  }

  _rescanVars() {
    const found = scanVarDecls(this.initCode, BUILTIN_VARS);
    for (const k of Object.keys(this._jsScope)) {
      if (!BUILTIN_VARS.has(k) && !found.has(k)) delete this._jsScope[k];
    }
    for (const name of found) {
      if (!(name in this._jsScope)) this._jsScope[name] = 0;
    }
  }

  _ensureInternal(gl, w, h) {
    if (this._inW === w && this._inH === h) return;
    for (const b of this._internal) {
      if (b) { gl.deleteTexture(b.texture); gl.deleteFramebuffer(b.fbo); }
    }
    this._internal = [makeRGBAFBO(gl, w, h), makeRGBAFBO(gl, w, h)];
    this._inIdx = 0;
    this._inW = w; this._inH = h;
    // Initialize both to black (matches original calloc of list_framebuffer)
    for (const b of this._internal) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Composite src onto base → targetFBO using blend mode.
  // optMaskTex: only used for Buffer mode (12).
  _blend(gl, baseTex, srcTex, targetFBO, mode, w, h, optMaskTex, maskInvert, amount = this.blendAmt) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._blendProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, baseTex);
    gl.uniform1i(this._uBase, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this._uSrc, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, optMaskTex || srcTex); // dummy bind when unused
    gl.uniform1i(this._uMask, 2);
    gl.uniform1i(this._uMode, mode);
    gl.uniform1f(this._uAmount, amount);
    gl.uniform1i(this._uMaskInvert, maskInvert ? 1 : 0);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  render(ctx) {
    const { gl, isBeat, fboManager } = ctx;
    const w = fboManager.w, h = fboManager.h;

    if (isBeat && this.onBeat) this._onBeatCooldown = this.onBeatFrames;
    const activeThisFrame = !this.onBeat || this._onBeatCooldown > 0;
    if (this._onBeatCooldown > 0) this._onBeatCooldown--;

    this._ensureInternal(gl, w, h);

    if (!activeThisFrame) {
      // Pass input through unchanged when the on-beat window has expired.
      this._blend(gl, ctx.inputTex, ctx.inputTex, ctx.outputFBO, 1, w, h, null, false);
      fboManager.swap();
      return;
    }

    // JS code blocks — run before any rendering to allow overriding per-frame state.
    let enabledThisFrame = true;
    let clearThisFrame   = this.clearFrame;
    let alphaIn          = this.blendAmt;
    let alphaOut         = this.blendAmt;

    if (this.useCode) {
      this._jsScope.w        = w;
      this._jsScope.h        = h;
      this._jsScope.beat     = isBeat ? 1 : 0;
      this._jsScope.enabled  = 1;
      this._jsScope.clear    = clearThisFrame ? 1 : 0;
      this._jsScope.alphain  = alphaIn;
      this._jsScope.alphaout = alphaOut;
      if (this._needInit) {
        this._runJS(this.initCode, 'initCode');
        this._needInit = false;
      }
      this._runJS(this.frameCode, 'frameCode');
      enabledThisFrame = this._jsScope.enabled  > 0.1 || this._jsScope.enabled  < -0.1;
      clearThisFrame   = this._jsScope.clear     > 0.1 || this._jsScope.clear    < -0.1;
      alphaIn          = Math.max(0, Math.min(1, this._jsScope.alphain));
      alphaOut         = Math.max(0, Math.min(1, this._jsScope.alphaout));
    }

    if (!enabledThisFrame) {
      this._blend(gl, ctx.inputTex, ctx.inputTex, ctx.outputFBO, 1, w, h, null, false);
      fboManager.swap();
      return;
    }

    // Step 1 — optionally clear the internal buffer (matches original clear_every_frame).
    // Default is false: internal buffer retains previous frame's content.
    if (clearThisFrame) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._internal[this._inIdx].fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // Step 2 — input blend: composite the parent frame into the internal buffer.
    // IGNORE (0): skip — internal buffer keeps its cleared/accumulated state.
    // Any other mode: blend ctx.inputTex (parent) into current internal buffer.
    if (this.inBlend !== 0) {
      const nextIdx = 1 - this._inIdx;
      const maskTex = this.inBlend === 12
        ? fboManager.getScratch(this.inBlendBuf)?.texture
        : null;
      this._blend(gl,
        this._internal[this._inIdx].texture, ctx.inputTex,
        this._internal[nextIdx].fbo,
        this.inBlend, w, h, maskTex, this.inBlendBufInvert, alphaIn);
      this._inIdx = nextIdx;
    }

    // Step 3 — run sub-effects on the isolated internal ping-pong.
    const self = this;
    const mini = {
      w, h,
      getCurrent() { return self._internal[self._inIdx]; },
      getNext()    { return self._internal[1 - self._inIdx]; },
      swap()       { self._inIdx = 1 - self._inIdx; },
      getScratch(i){ return fboManager.getScratch(i); },
    };

    // Single shared ctx so mutations (e.g. ctx.lineBlendMode set by SetRenderMode)
    // persist across sub-effects, matching the outer chain's behaviour.
    const innerCtx = { ...ctx, fboManager: mini };

    for (const entry of this.entries) {
      if (!entry.enabled) continue;
      innerCtx.inputTex  = mini.getCurrent().texture;
      innerCtx.outputFBO = mini.getNext().fbo;
      entry.effect.render(innerCtx);
      // The sub-effect called mini.swap() — _inIdx now points to the result.
    }

    // Step 4 — output blend: composite internal result onto the parent output.
    // base=ctx.inputTex (parent frame), src=internal result.
    // IGNORE (0): r = b → outputFBO = parent frame (pass-through, parent unchanged).
    // REPLACE (1): r = s → outputFBO = internal result.
    const maskTex = this.outBlend === 12
      ? fboManager.getScratch(this.outBlendBuf)?.texture
      : null;
    this._blend(gl,
      ctx.inputTex, this._internal[this._inIdx].texture,
      ctx.outputFBO,
      this.outBlend, w, h, maskTex, this.outBlendBufInvert, alphaOut);

    fboManager.swap();
  }

  getConfig() {
    return {
      onBeat:            this.onBeat,
      onBeatFrames:      this.onBeatFrames,
      useCode:           this.useCode,
      initCode:          this.initCode,
      frameCode:         this.frameCode,
      inBlend:           this.inBlend,
      outBlend:          this.outBlend,
      clearFrame:        this.clearFrame,
      blendAmt:          this.blendAmt,
      inBlendBuf:        this.inBlendBuf,
      outBlendBuf:       this.outBlendBuf,
      inBlendBufInvert:  this.inBlendBufInvert,
      outBlendBufInvert: this.outBlendBufInvert,
      effects: this.entries.map(e => ({
        type:    e.effect.getDescriptor().name,
        enabled: e.enabled,
        config:  e.effect.getConfig(),
      })),
    };
  }

  setConfig(cfg) {
    if (cfg.onBeat            !== undefined) this.onBeat            = cfg.onBeat;
    if (cfg.onBeatFrames      !== undefined) this.onBeatFrames      = Math.max(0, cfg.onBeatFrames);
    if (cfg.useCode           !== undefined) this.useCode           = cfg.useCode;
    if (cfg.initCode          !== undefined) { this.initCode  = cfg.initCode;  this._rescanVars(); this._needInit = true; }
    if (cfg.frameCode         !== undefined) this.frameCode         = cfg.frameCode;
    if (cfg.inBlend           !== undefined) this.inBlend           = cfg.inBlend;
    if (cfg.outBlend          !== undefined) this.outBlend          = cfg.outBlend;
    if (cfg.clearFrame        !== undefined) this.clearFrame        = cfg.clearFrame;
    if (cfg.blendAmt          !== undefined) this.blendAmt          = cfg.blendAmt;
    if (cfg.inBlendBuf        !== undefined) this.inBlendBuf        = cfg.inBlendBuf;
    if (cfg.outBlendBuf       !== undefined) this.outBlendBuf       = cfg.outBlendBuf;
    if (cfg.inBlendBufInvert  !== undefined) this.inBlendBufInvert  = cfg.inBlendBufInvert;
    if (cfg.outBlendBufInvert !== undefined) this.outBlendBufInvert = cfg.outBlendBufInvert;
    if (!cfg.effects) return;
    for (const e of this.entries) e.effect.destroy();
    this.entries = [];
    for (const item of cfg.effects) {
      const cls = EffectRegistry.get(item.type);
      if (!cls) continue;
      const effect = new cls(this.gl);
      if (item.config) effect.setConfig(item.config);
      const entry = this.addEntry(effect);
      entry.enabled = item.enabled !== false;
    }
  }

  getDescriptor() {
    return {
      name: 'Effect List',
      params: [
        { name: 'onBeat',       label: 'Enable on Beat',  type: 'bool',   default: false },
        { name: 'onBeatFrames', label: 'For N Frames',    type: 'int',    min: 0, default: 1, visibleWhen: { param: 'onBeat', value: true } },
        { name: 'useCode',      label: 'Use Code',        type: 'bool',   default: false },
        { name: 'initCode',     label: 'Init',            type: 'js',     default: '',   visibleWhen: { param: 'useCode', value: true } },
        { name: 'frameCode',    label: 'Frame',           type: 'js',     default: '',   visibleWhen: { param: 'useCode', value: true } },
        { name: 'clearFrame',        label: 'Clear Frame',   type: 'bool',   default: false },
        { name: 'inBlend',           label: 'Input Blend',   type: 'select', options: BLEND_OPTIONS, default: 0 },
        { name: 'inBlendBuf',        label: 'Input Buffer',  type: 'buffer-slot', default: 0, visibleWhen: { param: 'inBlend', value: 12 } },
        { name: 'inBlendBufInvert',  label: 'Invert',        type: 'bool',   default: false, visibleWhen: { param: 'inBlend', value: 12 } },
        { name: 'outBlend',          label: 'Output Blend',  type: 'select', options: BLEND_OPTIONS, default: 1 },
        { name: 'outBlendBuf',       label: 'Output Buffer', type: 'buffer-slot', default: 0, visibleWhen: { param: 'outBlend', value: 12 } },
        { name: 'outBlendBufInvert', label: 'Invert',        type: 'bool',   default: false, visibleWhen: { param: 'outBlend', value: 12 } },
        { name: 'blendAmt',          label: 'Blend Amount',  type: 'range',  min: 0, max: 1, step: 0.01, default: 0.5 },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._blendProg);
    for (const b of this._internal) {
      if (b) { this.gl.deleteTexture(b.texture); this.gl.deleteFramebuffer(b.fbo); }
    }
    for (const e of this.entries) e.effect.destroy();
    this.entries = [];
  }
}
