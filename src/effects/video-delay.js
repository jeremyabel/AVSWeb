import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Ring buffer of GPU textures. Each frame: output the oldest slot, overwrite it
// with the current frame, advance the write pointer.
// Cap at 64 slots to bound VRAM usage (400-slot original max is impractical on GPU).

const MAX_RING_SLOTS = 64;

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
out vec4 fragColor;
void main() {
  fragColor = vec4(texture(uInput, vUv).rgb, 1.0);
}`;

export class VideoDelayEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.enabled  = true;
    this.usebeats = false;
    this.delay    = 10;

    this._framedelay      = 10;
    this._framessincebeat = 0;
    this._ring            = [];   // { tex, fbo }[]
    this._writeIdx        = 0;
    this._lastW           = 0;
    this._lastH           = 0;

    this._prog   = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
  }

  _createSlot(gl, w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { tex, fbo };
  }

  _freeRing(gl) {
    for (const slot of this._ring) {
      gl.deleteTexture(slot.tex);
      gl.deleteFramebuffer(slot.fbo);
    }
    this._ring     = [];
    this._writeIdx = 0;
  }

  _blit(gl, srcTex, dstFBO, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this._uInput, 0);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    // Beats mode: recompute framedelay from inter-beat frame count
    if (this.usebeats) {
      if (isBeat) {
        this._framedelay = Math.min(this._framessincebeat * this.delay, 400);
        this._framessincebeat = 0;
      }
      this._framessincebeat++;
    } else {
      this._framedelay = this.delay;
    }

    if (!this.enabled || this._framedelay === 0) return;

    const slots = Math.min(this._framedelay, MAX_RING_SLOTS);

    // Reallocate ring on canvas resize
    if (w !== this._lastW || h !== this._lastH) {
      this._freeRing(gl);
      this._lastW = w;
      this._lastH = h;
    }

    // Grow ring to cover needed slots (lazy allocation)
    while (this._ring.length < slots) {
      this._ring.push(this._createSlot(gl, w, h));
    }

    // Keep writeIdx in bounds after slot count change
    this._writeIdx = this._writeIdx % slots;

    // Output the oldest stored frame → chain output FBO
    this._blit(gl, this._ring[this._writeIdx].tex, outputFBO, w, h);

    // Overwrite that slot with the current frame (it becomes the newest)
    this._blit(gl, inputTex, this._ring[this._writeIdx].fbo, w, h);

    this._writeIdx = (this._writeIdx + 1) % slots;
    fboManager.swap();
  }

  getConfig() {
    return {
      enabled:  this.enabled,
      usebeats: this.usebeats,
      delay:    this.delay,
    };
  }

  setConfig(cfg) {
    if (cfg.enabled !== undefined) this.enabled = cfg.enabled;
    if (cfg.usebeats !== undefined) {
      this.usebeats = cfg.usebeats;
      this._framedelay      = 0;
      this._framessincebeat = 0;
      if (!this.usebeats) this._framedelay = this.delay;
    }
    if (cfg.delay !== undefined) {
      this.delay = cfg.delay;
      if (this.usebeats) { if (this.delay > 16)  this.delay = 16;  }
      else               { if (this.delay > 200) this.delay = 200; }
    }
  }

  getDescriptor() {
    return {
      name: 'Video Delay',
      params: [
        { name: 'enabled',  label: 'Enabled',  type: 'bool',  default: true  },
        { name: 'usebeats', label: 'Use Beats', type: 'bool',  default: false },
        { name: 'delay',    label: 'Delay',     type: 'range', min: 0, max: 200, step: 1, default: 10 },
      ],
    };
  }

  destroy() {
    this._freeRing(this.gl);
    this.gl.deleteProgram(this._prog);
  }
}
