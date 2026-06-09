import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const GRID       = 64;
const CLR_STEPS  = 16;              // lerp steps per color interval
const CLR_MAP_SZ = 4 * CLR_STEPS;  // 5 colors → 4 intervals → 64 entries

// Original config colors stored as packed BGRx integers.
// Converted to [R,G,B]: bits16-23=R, bits8-15=G, bits0-7=B.
const DEFAULT_COLORS = [
  [0x1c, 0x6b, 0x18],
  [0xff, 0x0a, 0x23],
  [0x2a, 0x1d, 0x74],
  [0x90, 0x36, 0xd9],
  [0x6b, 0x88, 0xff],
];

// Composites dots texture onto input using screen blend (blend_default approximation).
const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform sampler2D uDots;
out vec4 fragColor;
void main() {
  vec4 base = texture(uInput, vUv);
  vec4 dot  = texture(uDots,  vUv);
  if (dot.a < 0.5) { fragColor = base; return; }
  vec3 b = base.rgb;
  vec3 s = dot.rgb;
  fragColor = vec4(b + s - b * s, 1.0);
}`;

// ---- Matrix helpers (ported verbatim from matrix.cpp) ----

function matRotate(m, axis, deg) {
  const rad = deg * Math.PI / 180;
  m.fill(0);
  const a = axis - 1;
  m[a * 4 + a] = 1;
  m[15] = 1;
  const m1 = axis % 3;
  const m2 = (m1 + 1) % 3;
  const c = Math.cos(rad), s = Math.sin(rad);
  m[m1 * 4 + m1] = c;
  m[m1 * 4 + m2] = s;
  m[m2 * 4 + m2] = c;
  m[m2 * 4 + m1] = -s;
}

function matTranslate(m, x, y, z) {
  m.fill(0);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[3] = x; m[7] = y; m[11] = z;
}

// dest = src * dest  (saves dest into temp first, matching the original's behaviour)
function matMul(dest, src) {
  const t = dest.slice();
  for (let i = 0; i < 16; i += 4) {
    dest[i]   = src[i]*t[0] + src[i+1]*t[4] + src[i+2]*t[8]  + src[i+3]*t[12];
    dest[i+1] = src[i]*t[1] + src[i+1]*t[5] + src[i+2]*t[9]  + src[i+3]*t[13];
    dest[i+2] = src[i]*t[2] + src[i+1]*t[6] + src[i+2]*t[10] + src[i+3]*t[14];
    dest[i+3] = src[i]*t[3] + src[i+1]*t[7] + src[i+2]*t[11] + src[i+3]*t[15];
  }
}

function matApply(m, x, y, z, out) {
  out[0] = x*m[0]  + y*m[1]  + z*m[2]  + m[3];
  out[1] = x*m[4]  + y*m[5]  + z*m[6]  + m[7];
  out[2] = x*m[8]  + y*m[9]  + z*m[10] + m[11];
}

// ----------------------------------------------------------

export class DotPlaneEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.rotationSpeed = 16;   // -50..50; added as speed/5 degrees per frame
    this.angle         = -20;  // -90..91; X-tilt of the plane
    this.colors        = DEFAULT_COLORS.map(c => [...c]); // always exactly 5

    this._rotation = 0;  // current Y-rotation angle (0..360), persists across frames

    // 64×64 grid state
    this._height = new Float32Array(GRID * GRID);
    this._delta  = new Float32Array(GRID * GRID);
    this._color  = new Uint8Array(GRID * GRID);   // index into _colorMap (0..63)

    // Precomputed 64-entry RGB color map (flat: [R0,G0,B0, R1,G1,B1, ...])
    this._colorMap = new Uint8Array(CLR_MAP_SZ * 3);
    this._buildColorMap();

    // Scratch buffers
    this._tmp    = new Float32Array(GRID);
    this._mat    = new Float32Array(16);
    this._mat2   = new Float32Array(16);
    this._pt     = new Float32Array(3);

    this._dotsBuf = null;
    this._dotsTex = null;
    this._dotsW   = 0;
    this._dotsH   = 0;

    this._prog   = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uDots  = gl.getUniformLocation(this._prog, 'uDots');
  }

  // Build the 64-entry color map by linearly interpolating between the 5 colors.
  // Matches original: color_map[t*16 + x] = lerp(colors[t], colors[t+1], x/16).
  _buildColorMap() {
    for (let t = 0; t < 4; t++) {
      const c1 = this.colors[t];
      const c2 = this.colors[t + 1];
      for (let x = 0; x < CLR_STEPS; x++) {
        const i = (t * CLR_STEPS + x) * 3;
        this._colorMap[i]   = (c1[0] + x * (c2[0] - c1[0]) / CLR_STEPS) | 0;
        this._colorMap[i+1] = (c1[1] + x * (c2[1] - c1[1]) / CLR_STEPS) | 0;
        this._colorMap[i+2] = (c1[2] + x * (c2[2] - c1[2]) / CLR_STEPS) | 0;
      }
    }
  }

  _ensureDots(gl, w, h) {
    if (this._dotsW === w && this._dotsH === h) return;
    this._dotsW   = w;
    this._dotsH   = h;
    this._dotsBuf = new Uint8Array(w * h * 4);
    if (this._dotsTex) gl.deleteTexture(this._dotsTex);
    this._dotsTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._dotsTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // Scroll the grid: rows 1..63 inherit a decayed version of the row before them;
  // row 0 receives new audio data. Mirrors the original's per-frame loop exactly.
  _updateGrid(visdata) {
    const h = this._height, d = this._delta, c = this._color;
    const tmp = this._tmp;

    // Save row 0 before any modifications (used for the new-row delta computation).
    for (let x = 0; x < GRID; x++) tmp[x] = h[x];

    // Propagate: row[line+1] ← decayed(row[line]), iterating from row 62 down to row 0.
    for (let yp = 0, line = (GRID - 2) * GRID; yp < GRID - 1; yp++, line -= GRID) {
      for (let x = 0; x < GRID; x++) {
        let nh = h[line + x] + d[line + x];
        if (nh < 0) nh = 0;
        h[line + GRID + x] = nh;
        d[line + GRID + x] = d[line + x] - 0.15 * (nh / 255);
        c[line + GRID + x] = c[line + x];
      }
    }

    // Push new audio line into row 0.
    const spectrum = visdata[0][0];
    for (let x = 0; x < GRID; x++) {
      // Sample max of 3 consecutive spectrum bins (matching original's max(a[i],a[i+1],a[i+2])).
      const i0 = x * 3;
      const audio = Math.min(255, Math.max(
        spectrum[i0] | 0,
        spectrum[Math.min(i0 + 1, 575)] | 0,
        spectrum[Math.min(i0 + 2, 575)] | 0
      ));
      h[x] = audio;
      c[x] = Math.min(63, (audio / 4) | 0);
      d[x] = (audio - tmp[x]) / 90;
    }
  }

  render(ctx) {
    const { gl, visdata, fboManager, inputTex, outputFBO } = ctx;
    const sw = fboManager.w, sh = fboManager.h;
    this._ensureDots(gl, sw, sh);

    // ---- Build 3D transform: translate * xRot * yRot ----
    // matrixRotate(transform,  2, rotation) → Y rotation
    // matrixRotate(transform2, 1, angle)    → X tilt
    // matrixMultiply(transform, transform2) → transform = xRot * yRot
    // matrixTranslate(transform2, 0,-20,400)
    // matrixMultiply(transform, transform2) → transform = translate * xRot * yRot
    const m  = this._mat;
    const m2 = this._mat2;
    matRotate(m,  2, this._rotation);
    matRotate(m2, 1, this.angle);
    matMul(m, m2);
    matTranslate(m2, 0, -20, 400);
    matMul(m, m2);

    this._updateGrid(visdata);

    // Perspective zoom normalised to a 640×480 reference canvas.
    const zoom = Math.min(sw * 440 / 640, sh * 440 / 480);

    const buf = this._dotsBuf;
    buf.fill(0);
    const pt = this._pt;
    const rot = this._rotation;

    for (let yp = 0; yp < GRID; yp++) {
      // Painter's order: choose which grid row to draw based on rotation quadrant.
      const gridRow = (rot < 90 || rot > 270) ? GRID - yp - 1 : yp;

      const gridStep0 = 350 / GRID;
      let gridStep = gridStep0;
      let curY     = -(GRID * 0.5) * gridStep0;
      const curX   = (gridRow - GRID * 0.5) * gridStep0;

      let colBase = gridRow * GRID;  // start of this row in the flat arrays
      let dir     = 1;

      // When rotation < 180, reverse column iteration order for correct depth sorting.
      if (rot < 180) {
        dir      = -1;
        gridStep = -gridStep0;
        curY     = -curY + gridStep;   // ≈ +175 (right side first)
        colBase += GRID - 1;           // start at last column
      }

      for (let xp = 0; xp < GRID; xp++) {
        const ph = this._height[colBase];
        matApply(m, curY, 64 - ph, curX, pt);
        if (pt[2] > 0) {
          const iz  = zoom / pt[2];
          const sx  = (pt[0] * iz + sw * 0.5) | 0;
          const sy  = (pt[1] * iz + sh * 0.5) | 0;
          if (sx >= 0 && sx < sw && sy >= 0 && sy < sh) {
            const ci = this._color[colBase] * 3;
            // Flip Y: WebGL texture origin is bottom-left.
            const bi = ((sh - 1 - sy) * sw + sx) * 4;
            buf[bi]     = this._colorMap[ci];
            buf[bi + 1] = this._colorMap[ci + 1];
            buf[bi + 2] = this._colorMap[ci + 2];
            buf[bi + 3] = 255;
          }
        }
        curY    += gridStep;
        colBase += dir;
      }
    }

    // Advance rotation (matches original: rotation += rotationSpeed / 5).
    this._rotation += this.rotationSpeed / 5;
    if (this._rotation >= 360) this._rotation -= 360;
    if (this._rotation < 0)    this._rotation += 360;

    // Upload dots and composite.
    gl.bindTexture(gl.TEXTURE_2D, this._dotsTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, sw, sh);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._dotsTex);
    gl.uniform1i(this._uDots, 1);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return {
      rotationSpeed: this.rotationSpeed,
      angle:         this.angle,
      rotation:      this._rotation,
      colors:        this.colors.map(c => [...c]),
      color0: [...this.colors[0]],
      color1: [...this.colors[1]],
      color2: [...this.colors[2]],
      color3: [...this.colors[3]],
      color4: [...this.colors[4]],
    };
  }

  setConfig(cfg) {
    let colorChanged = false;
    if (cfg.rotationSpeed !== undefined) this.rotationSpeed = cfg.rotationSpeed;
    if (cfg.angle         !== undefined) this.angle         = cfg.angle;
    if (cfg.rotation      !== undefined) this._rotation     = cfg.rotation;
    if (cfg.colors        !== undefined) {
      this.colors = cfg.colors.map(c => [...c]);
      colorChanged = true;
    }
    for (let i = 0; i < 5; i++) {
      if (cfg[`color${i}`] !== undefined) {
        this.colors[i] = [...cfg[`color${i}`]];
        colorChanged = true;
      }
    }
    if (colorChanged) this._buildColorMap();
  }

  getDescriptor() {
    return {
      name: 'Dot Plane',
      params: [
        { name: 'rotationSpeed', label: 'Rotation Speed', type: 'range', min: -50, max: 50,  step: 1, default: 16  },
        { name: 'angle',         label: 'Angle',           type: 'range', min: -90, max: 91,  step: 1, default: -20 },
        { name: 'color0',        label: 'Color 1',         type: 'color', default: DEFAULT_COLORS[0] },
        { name: 'color1',        label: 'Color 2',         type: 'color', default: DEFAULT_COLORS[1] },
        { name: 'color2',        label: 'Color 3',         type: 'color', default: DEFAULT_COLORS[2] },
        { name: 'color3',        label: 'Color 4',         type: 'color', default: DEFAULT_COLORS[3] },
        { name: 'color4',        label: 'Color 5',         type: 'color', default: DEFAULT_COLORS[4] },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._dotsTex) this.gl.deleteTexture(this._dotsTex);
  }
}
