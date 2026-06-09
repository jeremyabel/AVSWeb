import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Per-pixel displacement driven by a CPU-simulated 2D wave equation.
//
// Height field: two Int32Array buffers (ping-pong). Each frame:
//   1. On beat: stamp a sinusoidal radial blob into the current buffer.
//   2. Upload current height buffer to a R32F GPU texture.
//   3. GPU displacement pass: dx = h[i]-h[i+1], dy = h[i]-h[i+w];
//      source pixel = (x + dx>>3, y + dy>>3) (matching original >> 3 shift).
//   4. Advance wave: CalcWater() — 8-neighbor sum/4 minus prev-output, then damp.
//   5. Swap pages.
//
// This faithfully replicates the original e_waterbump.cpp algorithm.
const FRAG = /* glsl */`#version 300 es
precision highp float;
uniform sampler2D uInput;
uniform sampler2D uHeight;
out vec4 fragColor;

void main() {
  ivec2 c  = ivec2(gl_FragCoord.xy);
  ivec2 sz = ivec2(textureSize(uInput, 0));

  // 1-pixel border passes through unchanged (original skips border in its loop).
  if (c.x == 0 || c.x == sz.x - 1 || c.y == 0 || c.y == sz.y - 1) {
    fragColor = texelFetch(uInput, c, 0);
    return;
  }

  // CPU buffer is row-major, row 0 = top of screen.
  // gl.texImage2D uploads row 0 of data to GL texture row 0 (y=0 = screen bottom).
  // So texture y = (sz.y - 1 - c.y) maps GL fragment back to the correct screen row.
  ivec2 hc = ivec2(c.x, sz.y - 1 - c.y);
  float h0 = texelFetch(uHeight, hc, 0).r;
  float hR = texelFetch(uHeight, hc + ivec2(1, 0), 0).r;  // right neighbor (same screen row)
  float hD = texelFetch(uHeight, hc + ivec2(0, 1), 0).r;  // one row below in screen

  // Arithmetic right-shift by 3, portable across signed-shift implementations.
  int idx = int(floor((h0 - hR) / 8.0));
  int idy = int(floor((h0 - hD) / 8.0));

  // Positive idx → source to the right; positive idy → source below (lower GL y).
  ivec2 src = c + ivec2(idx, -idy);
  if (src.x >= 0 && src.x < sz.x && src.y >= 0 && src.y < sz.y) {
    fragColor = texelFetch(uInput, src, 0);
  } else {
    fragColor = texelFetch(uInput, c, 0);
  }
}`;

export class WaterBumpEffect extends Effect {
  constructor(gl) {
    super(gl);

    this.fluidity      = 6;
    this.depth         = 600;
    this.random        = false;
    this.dropPositionX = 1;   // 0=left  1=center  2=right
    this.dropPositionY = 1;   // 0=top   1=center  2=bottom
    this.dropRadius    = 40;

    this._buf    = [null, null];  // Int32Array ping-pong height buffers
    this._bufF32 = null;          // Float32Array for GPU upload (reused each frame)
    this._bufW   = 0;
    this._bufH   = 0;
    this._page   = 0;

    this._heightTex = null;
    this._prog      = createProgram(gl, vertSrc, FRAG);
    this._uInput    = gl.getUniformLocation(this._prog, 'uInput');
    this._uHeight   = gl.getUniformLocation(this._prog, 'uHeight');
  }

  _ensureBuffers(w, h) {
    if (this._bufW === w && this._bufH === h) return;
    this._buf[0] = new Int32Array(w * h);
    this._buf[1] = new Int32Array(w * h);
    this._bufF32 = new Float32Array(w * h);
    this._bufW   = w;
    this._bufH   = h;
    this._page   = 0;

    const gl = this.gl;
    if (this._heightTex) gl.deleteTexture(this._heightTex);
    this._heightTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._heightTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // Stamps a sinusoidal radial disturbance into the current height buffer.
  // Matches original SineBlob(): x/y < 0 → randomise position.
  _sineBlob(x, y, radius, height) {
    const w = this._bufW, bh = this._bufH;
    const buf = this._buf[this._page];

    if (x < 0) x = 1 + radius + Math.floor(Math.random() * Math.max(1, w  - 2 * radius - 1));
    if (y < 0) y = 1 + radius + Math.floor(Math.random() * Math.max(1, bh - 2 * radius - 1));

    const radsq  = radius * radius;
    const length = (1024.0 / radius) * (1024.0 / radius);

    let left = -radius, right = radius, top = -radius, bottom = radius;
    if (x - radius < 1)        left   -= (x - radius - 1);
    if (y - radius < 1)        top    -= (y - radius - 1);
    if (x + radius > w  - 1)   right  -= (x + radius - w  + 1);
    if (y + radius > bh - 1)   bottom -= (y + radius - bh + 1);

    for (let cy = top; cy < bottom; cy++) {
      for (let cx = left; cx < right; cx++) {
        const sq = cy * cy + cx * cx;
        if (sq < radsq) {
          const dist = Math.sqrt(sq * length);
          buf[w * (cy + y) + cx + x] += ((Math.cos(dist) + 0xffff) * height) >> 19;
        }
      }
    }
  }

  // 2D wave equation on the height buffers, matching CalcWater() exactly.
  // Reads from _buf[_page] (old), reads+writes _buf[_page^1] (new output).
  // The read of newbuf[count] before overwriting gives h[t-1] for the wave equation.
  _calcWater() {
    const npage  = this._page ^ 1;
    const newbuf = this._buf[npage];
    const oldbuf = this._buf[this._page];
    const w = this._bufW, h = this._bufH;
    const fl = this.fluidity;

    let count = w + 1;
    for (let y = (h - 1) * w; count < y; count += 2) {
      for (let x = count + w - 2; count < x; count++) {
        let newh = ((oldbuf[count + w] + oldbuf[count - w]
                   + oldbuf[count + 1] + oldbuf[count - 1]
                   + oldbuf[count - w - 1] + oldbuf[count - w + 1]
                   + oldbuf[count + w - 1] + oldbuf[count + w + 1]) >> 2)
                  - newbuf[count];
        newbuf[count] = newh - (newh >> fl);
      }
    }
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;
    this._ensureBuffers(w, h);

    if (isBeat) {
      if (this.random) {
        const maxDim = Math.max(w, h);
        this._sineBlob(-1, -1, Math.floor(this.dropRadius * maxDim / 100), -this.depth);
      } else {
        const xPos = [Math.floor(w / 4), Math.floor(w / 2), Math.floor(w * 3 / 4)];
        const yPos = [Math.floor(h / 4), Math.floor(h / 2), Math.floor(h * 3 / 4)];
        this._sineBlob(xPos[this.dropPositionX], yPos[this.dropPositionY], this.dropRadius, -this.depth);
      }
    }

    // Upload current height field as a float texture (int→float is lossless up to 2^24).
    this._bufF32.set(this._buf[this._page]);
    gl.bindTexture(gl.TEXTURE_2D, this._heightTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, this._bufF32);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // GPU displacement pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._heightTex);
    gl.uniform1i(this._uHeight, 1);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    fboManager.swap();

    // Advance wave simulation (reads current page, writes other page).
    this._calcWater();
    this._page ^= 1;
  }

  getConfig() {
    return {
      fluidity:      this.fluidity,
      depth:         this.depth,
      random:        this.random,
      dropPositionX: this.dropPositionX,
      dropPositionY: this.dropPositionY,
      dropRadius:    this.dropRadius,
    };
  }

  setConfig(cfg) {
    if (cfg.fluidity      !== undefined) this.fluidity      = cfg.fluidity;
    if (cfg.depth         !== undefined) this.depth         = cfg.depth;
    if (cfg.random        !== undefined) this.random        = cfg.random;
    if (cfg.dropPositionX !== undefined) this.dropPositionX = cfg.dropPositionX;
    if (cfg.dropPositionY !== undefined) this.dropPositionY = cfg.dropPositionY;
    if (cfg.dropRadius    !== undefined) this.dropRadius    = cfg.dropRadius;
  }

  getDescriptor() {
    return {
      name: 'Water Bump',
      params: [
        { name: 'fluidity',      label: 'Fluidity',     type: 'range',  min: 2,   max: 10,   step: 1, default: 6 },
        { name: 'depth',         label: 'Depth',        type: 'range',  min: 100, max: 2000, step: 1, default: 600 },
        { name: 'random',        label: 'Random Drop',  type: 'bool',   default: false },
        { name: 'dropPositionX', label: 'Drop X',       type: 'select',
          options: [{ value: 0, label: 'Left' }, { value: 1, label: 'Center' }, { value: 2, label: 'Right' }],
          default: 1 },
        { name: 'dropPositionY', label: 'Drop Y',       type: 'select',
          options: [{ value: 0, label: 'Top' }, { value: 1, label: 'Center' }, { value: 2, label: 'Bottom' }],
          default: 1 },
        { name: 'dropRadius',    label: 'Drop Radius',  type: 'range',  min: 10,  max: 100,  step: 1, default: 40 },
      ],
    };
  }

  destroy() {
    const gl = this.gl;
    gl.deleteProgram(this._prog);
    if (this._heightTex) gl.deleteTexture(this._heightTex);
  }
}
