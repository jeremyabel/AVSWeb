import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Draws a repeating grid of `color` over the framebuffer.
// The grid period is 2*ty rows × 2*tx columns:
//   - First ty rows  of each period: entire row filled with color (ystat=0)
//   - Next  ty rows  of each period: every other tx-wide column filled (ystat=1)
// Grid is centered: xos = (w % tx) / 2, yp_start = (h % ty) / 2.
// Beat: cur_x/cur_y snap to x2/y2 and decay back toward x/y each frame.

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform vec3 uColor;
uniform int  uTx;       // current x grid period (0-64)
uniform int  uTy;       // current y grid period (0-64)
uniform int  uW;        // canvas width  in pixels
uniform int  uH;        // canvas height in pixels
uniform int  uBlend;    // 0=replace  1=additive  2=average
out vec4 fragColor;

void main() {
  vec4 orig = texture(uInput, vUv);

  // Shortcut: both zero means nothing to draw
  if (uTx == 0 && uTy == 0) { fragColor = orig; return; }

  // Integer pixel coordinates (top-left origin to match original)
  int px = int(gl_FragCoord.x);
  // gl_FragCoord.y=0 is at the bottom in WebGL; flip to get top=0
  int py = uH - 1 - int(gl_FragCoord.y);

  bool applyColor = false;

  // ── Y-axis: determine if this is a pure-color row or a grid row ────────────
  bool isPureColorRow = false;
  bool inGridRow      = false;

  if (uTy == 0) {
    // ty=0 → ystat stays 1 → all rows are grid rows
    inGridRow = true;
  } else {
    // yp_start centers the grid vertically (matches original yp init)
    int yp_start = (uH % uTy) / 2;
    // Phase within the 2*ty-row period.
    // ystat=0 (pure color) occupies phase [0, ty); ystat=1 (grid) occupies [ty, 2*ty).
    // At py=0: yp starts at yp_start, first ++yp gives yp_start+1.
    int yPhase = (py + yp_start + 1) % (2 * uTy);
    isPureColorRow = yPhase < uTy;
    inGridRow      = !isPureColorRow;
  }

  // ── Apply color based on row type ─────────────────────────────────────────
  if (isPureColorRow) {
    applyColor = true;
  } else if (inGridRow && uTx > 0) {
    // xos centers the grid horizontally (matches original xos = (w%tx)/2)
    int xos    = (uW % uTx) / 2;
    int xPhase = (px + xos) % (2 * uTx);
    applyColor = xPhase < uTx;
  }
  // inGridRow && uTx == 0: no color (original skips the row entirely)

  if (!applyColor) { fragColor = orig; return; }

  vec3 out_col;
  if      (uBlend == 1) out_col = clamp(orig.rgb + uColor, 0.0, 1.0);
  else if (uBlend == 2) out_col = (orig.rgb + uColor) * 0.5;
  else                  out_col = uColor;

  fragColor = vec4(out_col, 1.0);
}`;

const OUT_BLEND_OPTIONS = [
  { value: 0, label: 'Replace'  },
  { value: 1, label: 'Additive' },
  { value: 2, label: 'Average'  },
];

export class InterleaveEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.x        = 1;
    this.y        = 1;
    this.x2       = 1;
    this.y2       = 1;
    this.beatdur  = 4;
    this.color    = [0, 0, 0];
    this.onbeat   = false;
    this.outBlend = 0;

    // Running animated positions (initialized from base x/y)
    this._curX = 1;
    this._curY = 1;

    this._prog    = createProgram(gl, vertSrc, FRAG);
    this._uInput  = gl.getUniformLocation(this._prog, 'uInput');
    this._uColor  = gl.getUniformLocation(this._prog, 'uColor');
    this._uTx     = gl.getUniformLocation(this._prog, 'uTx');
    this._uTy     = gl.getUniformLocation(this._prog, 'uTy');
    this._uW      = gl.getUniformLocation(this._prog, 'uW');
    this._uH      = gl.getUniformLocation(this._prog, 'uH');
    this._uBlend  = gl.getUniformLocation(this._prog, 'uBlend');
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    // Exponential decay toward base x/y each frame
    // sc1 = (beatdur + 448) / 512; beatdur range 1-64 → sc1 range ~0.877-1.0
    const sc1    = (this.beatdur + 512 - 64) / 512;
    this._curX   = this._curX * sc1 + this.x * (1 - sc1);
    this._curY   = this._curY * sc1 + this.y * (1 - sc1);

    // Beat snap (applied after interpolation, matching original order)
    if (isBeat && this.onbeat) {
      this._curX = this.x2;
      this._curY = this.y2;
    }

    const tx = Math.max(0, Math.round(this._curX));
    const ty = Math.max(0, Math.round(this._curY));

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform3f(this._uColor, this.color[0] / 255, this.color[1] / 255, this.color[2] / 255);
    gl.uniform1i(this._uTx,    tx);
    gl.uniform1i(this._uTy,    ty);
    gl.uniform1i(this._uW,     w);
    gl.uniform1i(this._uH,     h);
    gl.uniform1i(this._uBlend, this.outBlend);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return {
      x:        this.x,
      y:        this.y,
      x2:       this.x2,
      y2:       this.y2,
      beatdur:  this.beatdur,
      color:    [...this.color],
      onbeat:   this.onbeat,
      outBlend: this.outBlend,
    };
  }

  setConfig(cfg) {
    if (cfg.x        !== undefined) { this.x       = cfg.x;       this._curX = this.x; }
    if (cfg.y        !== undefined) { this.y       = cfg.y;       this._curY = this.y; }
    if (cfg.x2       !== undefined) this.x2       = cfg.x2;
    if (cfg.y2       !== undefined) this.y2       = cfg.y2;
    if (cfg.beatdur  !== undefined) this.beatdur  = cfg.beatdur;
    if (cfg.color)                  this.color    = cfg.color;
    if (cfg.onbeat   !== undefined) this.onbeat   = cfg.onbeat;
    if (cfg.outBlend !== undefined) this.outBlend = cfg.outBlend;
  }

  getDescriptor() {
    return {
      name: 'Interleave',
      params: [
        { name: 'x',        label: 'X Size',             type: 'range',  min: 0, max: 64, step: 1, default: 1 },
        { name: 'y',        label: 'Y Size',             type: 'range',  min: 0, max: 64, step: 1, default: 1 },
        { name: 'x2',       label: 'X Size (On Beat)',   type: 'range',  min: 0, max: 64, step: 1, default: 1 },
        { name: 'y2',       label: 'Y Size (On Beat)',   type: 'range',  min: 0, max: 64, step: 1, default: 1 },
        { name: 'beatdur',  label: 'Beat Duration',      type: 'range',  min: 1, max: 64, step: 1, default: 4 },
        { name: 'color',    label: 'Color',              type: 'color',  default: [0, 0, 0] },
        { name: 'onbeat',   label: 'On Beat',            type: 'bool',   default: false },
        { name: 'outBlend', label: 'Blend',              type: 'select', options: OUT_BLEND_OPTIONS, default: 0 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
