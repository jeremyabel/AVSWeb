import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Feedback warp: each frame, the previous frame is read, rotated + zoomed about
// the centre, and written to output. Beat-reactive: rotation can reverse and
// zoom can snap to a secondary value.

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform float uCosTheta;
uniform float uSinTheta;  // sign already corrected for WebGL y-up
uniform float uZoom;
uniform float uW;
uniform float uH;
uniform int   uBlend;     // 0=replace  1=50/50 avg with original
out vec4 fragColor;

void main() {
  float cx = uW * 0.5;
  float cy = uH * 0.5;

  // gl_FragCoord: y=0 at bottom. Flip dy so rotation matches original's y-down space.
  float dx =  (gl_FragCoord.x - cx);
  float dy = -(gl_FragCoord.y - cy);   // convert to y-down (original convention)

  // Apply rotation+zoom (forward: each output pixel reads from rotated+zoomed source)
  // M = zoom * [[cos, -sin], [sin, cos]] (y-down)
  float src_px = cx + uZoom * (uCosTheta * dx - uSinTheta * dy);
  float src_py_down = cy + uZoom * (uSinTheta * dx + uCosTheta * dy);

  // Convert back to gl y-up for UV sampling
  float src_py = uH - src_py_down;

  // Wrap (tile) — matches original s %= (w-1)<<16 behaviour
  vec2 src_uv = fract(vec2(src_px / uW, src_py / uH));

  vec4 mapped = texture(uInput, src_uv);

  if (uBlend == 1) {
    vec4 orig = texture(uInput, vUv);
    fragColor = vec4((orig.rgb + mapped.rgb) * 0.5, 1.0);
  } else {
    fragColor = vec4(mapped.rgb, 1.0);
  }
}`;

export class RotoBltEffect extends Effect {
  constructor(gl) {
    super(gl);
    // Serialised config
    this.zoom_scale   = 31;   // 0-256; 31 = no zoom
    this.zoom_scale2  = 31;   // beat zoom target
    this.rot_dir      = 31;   // 0-64; 32 = no rotation, <32 CCW, >32 CW
    this.beatch_speed = 0;    // 0-8; smoothing speed for rotation reversal
    this.subpixel     = true; // bilinear filtering
    this.blend        = false;// 50/50 blend with original
    this.beatch       = false;// reverse rotation on beat
    this.beatch_scale = false;// snap zoom on beat

    // Runtime state (not serialised)
    this._rot_rev     = 1;    // 1 or -1
    this._rot_rev_pos = 1.0;  // smoothed rot_rev
    this._scale_fpos  = this.zoom_scale;

    this._prog      = createProgram(gl, vertSrc, FRAG);
    this._uInput    = gl.getUniformLocation(this._prog, 'uInput');
    this._uCosTheta = gl.getUniformLocation(this._prog, 'uCosTheta');
    this._uSinTheta = gl.getUniformLocation(this._prog, 'uSinTheta');
    this._uZoom     = gl.getUniformLocation(this._prog, 'uZoom');
    this._uW        = gl.getUniformLocation(this._prog, 'uW');
    this._uH        = gl.getUniformLocation(this._prog, 'uH');
    this._uBlend    = gl.getUniformLocation(this._prog, 'uBlend');
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    // ── Rotation reversal ────────────────────────────────────────────────────
    if (isBeat && this.beatch) this._rot_rev = -this._rot_rev;
    if (!this.beatch) this._rot_rev = 1;

    const speedFactor = 1.0 / (1 + this.beatch_speed * 4);
    this._rot_rev_pos += speedFactor * (this._rot_rev - this._rot_rev_pos);
    // Clamp so it doesn't overshoot
    if (this._rot_rev_pos > this._rot_rev && this._rot_rev > 0) this._rot_rev_pos = this._rot_rev;
    if (this._rot_rev_pos < this._rot_rev && this._rot_rev < 0) this._rot_rev_pos = this._rot_rev;

    // ── Scale animation ──────────────────────────────────────────────────────
    if (isBeat && this.beatch_scale) this._scale_fpos = this.zoom_scale2;

    let f_val;
    if (this.zoom_scale < this.zoom_scale2) {
      f_val = Math.max(this._scale_fpos, this.zoom_scale);
      if (this._scale_fpos > this.zoom_scale) this._scale_fpos -= 3;
    } else {
      f_val = Math.min(this._scale_fpos, this.zoom_scale);
      if (this._scale_fpos < this.zoom_scale) this._scale_fpos += 3;
    }

    // ── Transform ────────────────────────────────────────────────────────────
    const zoom     = 1.0 + (f_val - 31) / 31.0;
    const thetaRad = (this.rot_dir - 32) * this._rot_rev_pos * Math.PI / 180.0;
    const cosT     = Math.cos(thetaRad);
    const sinT     = Math.sin(thetaRad);

    // ── Texture filter ───────────────────────────────────────────────────────
    const filter = this.subpixel ? gl.LINEAR : gl.NEAREST;
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // ── Draw ─────────────────────────────────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput,    0);
    gl.uniform1f(this._uCosTheta, cosT);
    gl.uniform1f(this._uSinTheta, sinT);
    gl.uniform1f(this._uZoom,     zoom);
    gl.uniform1f(this._uW,        w);
    gl.uniform1f(this._uH,        h);
    gl.uniform1i(this._uBlend,    this.blend ? 1 : 0);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    // Reset wrap mode (other effects expect CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    fboManager.swap();
  }

  getConfig() {
    return {
      zoom_scale:   this.zoom_scale,
      zoom_scale2:  this.zoom_scale2,
      rot_dir:      this.rot_dir,
      beatch_speed: this.beatch_speed,
      subpixel:     this.subpixel,
      blend:        this.blend,
      beatch:       this.beatch,
      beatch_scale: this.beatch_scale,
    };
  }

  setConfig(cfg) {
    if (cfg.zoom_scale   !== undefined) { this.zoom_scale   = cfg.zoom_scale;  this._scale_fpos = this.zoom_scale; }
    if (cfg.zoom_scale2  !== undefined) this.zoom_scale2  = cfg.zoom_scale2;
    if (cfg.rot_dir      !== undefined) this.rot_dir      = cfg.rot_dir;
    if (cfg.beatch_speed !== undefined) this.beatch_speed = cfg.beatch_speed;
    if (cfg.subpixel     !== undefined) this.subpixel     = cfg.subpixel;
    if (cfg.blend        !== undefined) this.blend        = cfg.blend;
    if (cfg.beatch       !== undefined) this.beatch       = cfg.beatch;
    if (cfg.beatch_scale !== undefined) this.beatch_scale = cfg.beatch_scale;
  }

  getDescriptor() {
    return {
      name: 'Roto Blitter',
      params: [
        { name: 'zoom_scale',   label: 'Zoom',              type: 'range', min: 0,   max: 256, step: 1, default: 31 },
        { name: 'zoom_scale2',  label: 'Zoom (On Beat)',     type: 'range', min: 0,   max: 256, step: 1, default: 31 },
        { name: 'rot_dir',      label: 'Rotation',          type: 'range', min: 0,   max: 64,  step: 1, default: 31 },
        { name: 'beatch_speed', label: 'Reversal Smoothing',type: 'range', min: 0,   max: 8,   step: 1, default: 0  },
        { name: 'subpixel',     label: 'Subpixel',          type: 'bool',  default: true  },
        { name: 'blend',        label: 'Blend',             type: 'bool',  default: false },
        { name: 'beatch',       label: 'Reverse on Beat',   type: 'bool',  default: false },
        { name: 'beatch_scale', label: 'Zoom Snap on Beat', type: 'bool',  default: false },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
