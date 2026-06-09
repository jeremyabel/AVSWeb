import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';
import blitFrag from '../shaders/blit.frag?raw';

const BLEND_OPTIONS = [
  { value: 0,  label: 'Replace'           },
  { value: 3,  label: '50/50'             },
  { value: 1,  label: 'Additive'          },
  { value: 8,  label: 'Every Other Pixel' },
  { value: 9,  label: 'Every Other Line'  },
  { value: 5,  label: 'Subtractive 1'     },
  { value: 10, label: 'Subtractive 2'     },
  { value: 11, label: 'XOR'               },
  { value: 2,  label: 'Maximum'           },
  { value: 7,  label: 'Minimum'           },
  { value: 4,  label: 'Multiply'          },
  { value: 6,  label: 'Adjustable'        },
];

// mode 0 = Save, 1 = Restore, 2 = Alt Save/Restore, 3 = Alt Restore/Save
const MODE_OPTIONS = [
  { value: 0, label: 'Save'                   },
  { value: 1, label: 'Restore'                },
  { value: 2, label: 'Alternate Save/Restore' },
  { value: 3, label: 'Alternate Restore/Save' },
];

const BLEND_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBase;
uniform sampler2D uSrc;
uniform int uBlendMode;
uniform float uBlendAmt;
out vec4 fragColor;
void main() {
  vec3 b = texture(uBase, vUv).rgb;
  vec3 s = texture(uSrc,  vUv).rgb;
  vec3 r;
  if      (uBlendMode == 0)  r = s;
  else if (uBlendMode == 1)  r = clamp(b + s, 0.0, 1.0);
  else if (uBlendMode == 2)  r = max(b, s);
  else if (uBlendMode == 3)  r = (b + s) * 0.5;
  else if (uBlendMode == 4)  r = b * s;
  else if (uBlendMode == 5)  r = clamp(b - s, 0.0, 1.0);
  else if (uBlendMode == 6)  r = mix(b, s, uBlendAmt);
  else if (uBlendMode == 7)  r = min(b, s);
  else if (uBlendMode == 8)  { ivec2 c = ivec2(gl_FragCoord.xy); r = ((c.x + c.y) % 2 == 0) ? s : b; }
  else if (uBlendMode == 9)  r = (int(gl_FragCoord.y) % 2 == 0) ? s : b;
  else if (uBlendMode == 10) r = clamp(s - b, 0.0, 1.0);
  else if (uBlendMode == 11) { ivec3 bi = ivec3(round(b * 255.0)); ivec3 si = ivec3(round(s * 255.0)); r = vec3(bi ^ si) / 255.0; }
  else                       r = b;
  fragColor = vec4(r, 1.0);
}`;

export class BufferSaveEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.mode      = 0;    // see MODE_OPTIONS
    this.slot      = 0;    // scratch buffer index 0-7
    this.blendMode = 0;    // blend mode for Restore
    this.blendAmt  = 0.5;  // alpha for Adjustable blend
    this._altPhase = false; // alternating frame toggle

    this._blitProg  = createProgram(gl, vertSrc, blitFrag);
    this._blitUTex  = gl.getUniformLocation(this._blitProg, 'uTex');

    this._blendProg    = createProgram(gl, vertSrc, BLEND_FRAG);
    this._uBase        = gl.getUniformLocation(this._blendProg, 'uBase');
    this._uSrc         = gl.getUniformLocation(this._blendProg, 'uSrc');
    this._uBlendMode   = gl.getUniformLocation(this._blendProg, 'uBlendMode');
    this._uBlendAmt    = gl.getUniformLocation(this._blendProg, 'uBlendAmt');
  }

  _blit(gl, fboManager, srcTex, dstFBO) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this._blitUTex, 0);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  _blend(gl, fboManager, baseTex, srcTex, dstFBO) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._blendProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, baseTex);
    gl.uniform1i(this._uBase, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this._uSrc, 1);
    gl.uniform1i(this._uBlendMode, this.blendMode);
    gl.uniform1f(this._uBlendAmt, this.blendAmt);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  _doSave(gl, fboManager, inputTex, outputFBO) {
    const scratch = fboManager.getScratch(this.slot);
    if (this.blendMode === 0) {
      // Replace: frame overwrites scratch directly; no need to read old scratch contents.
      this._blit(gl, fboManager, inputTex, scratch.fbo);
    } else {
      // blend(scratch, frame) → scratch. Use outputFBO as an alias-safe intermediate
      // to avoid reading scratch.texture while simultaneously writing to scratch.fbo.
      this._blend(gl, fboManager, scratch.texture, inputTex, outputFBO);
      this._blit(gl, fboManager, fboManager.getNext().texture, scratch.fbo);
    }
    this._blit(gl, fboManager, inputTex, outputFBO); // pass through
  }

  _doRestore(gl, fboManager, inputTex, outputFBO) {
    const scratch = fboManager.getScratch(this.slot);
    this._blend(gl, fboManager, inputTex, scratch.texture, outputFBO);
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;

    if (this.mode === 0) {
      this._doSave(gl, fboManager, inputTex, outputFBO);
    } else if (this.mode === 1) {
      this._doRestore(gl, fboManager, inputTex, outputFBO);
    } else {
      // Alternate modes: _altPhase toggles each frame.
      const saveFirst = (this.mode === 2); // mode 2 = Save/Restore, mode 3 = Restore/Save
      const doSave = saveFirst ? !this._altPhase : this._altPhase;
      if (doSave) {
        this._doSave(gl, fboManager, inputTex, outputFBO);
      } else {
        this._doRestore(gl, fboManager, inputTex, outputFBO);
      }
      this._altPhase = !this._altPhase;
    }

    fboManager.swap();
  }

  getConfig() {
    return { mode: this.mode, slot: this.slot, blendMode: this.blendMode, blendAmt: this.blendAmt };
  }
  setConfig(cfg) {
    if (cfg.mode      !== undefined) this.mode      = cfg.mode;
    if (cfg.slot      !== undefined) this.slot      = cfg.slot;
    if (cfg.blendMode !== undefined) this.blendMode = cfg.blendMode;
    if (cfg.blendAmt  !== undefined) this.blendAmt  = cfg.blendAmt;
  }

  getDescriptor() {
    return {
      name: 'Buffer Save',
      params: [
        { name: 'mode',      label: 'Mode',         type: 'select', options: MODE_OPTIONS,  default: 0 },
        { name: 'slot',      label: 'Buffer Slot',   type: 'buffer-slot', default: 0 },
        { name: 'blendMode', label: 'Blend',          type: 'select', options: BLEND_OPTIONS, default: 0 },
        { name: 'blendAmt',  label: 'Blend Amount',  type: 'range',  min: 0, max: 1, step: 0.01, default: 0.5 },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._blitProg);
    this.gl.deleteProgram(this._blendProg);
  }
}
