import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const BLIT_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 fragColor;
void main() { fragColor = texture(uTex, vUv); }`;

// ── Color formula ─────────────────────────────────────────────────────────────
// Matches blend_adjustable_rough() from e_starfield.cpp.
// "A very rough variant of the adjustable blend mode" kept for pixel-compatibility.
// Per channel: (greyNibble * (16 - v)) + (colorNibble * v), where v = brightness >> 4.
function starColorize(bright, cr, cg, cb) {
  const v = (bright >> 4) & 0xF;
  const gn = v; // (bright >> 4) & 0xF — same value
  return [
    (gn * (16 - v)) + ((cr >> 4) * v),
    (gn * (16 - v)) + ((cg >> 4) * v),
    (gn * (16 - v)) + ((cb >> 4) * v),
  ];
}

const BLEND_OPTIONS = [
  { value: 0, label: 'Replace'  },
  { value: 1, label: 'Additive' },
  { value: 2, label: '50/50'    },
];

// ── Effect ────────────────────────────────────────────────────────────────────

export class StarfieldEffect extends Effect {
  constructor(gl) {
    super(gl);

    this.color           = [255, 255, 255];
    this.blendMode       = 0;
    this.speed           = 6;
    this.starCount       = 350;
    this.onBeat          = false;
    this.onBeatSpeed     = 4;
    this.onBeatDuration  = 15;

    this._currentSpeed = 6;
    this._onBeatDiff   = 0;
    this._cooldown     = 0;

    // Star pool — pre-allocated, active count in _absStars.
    this._stars    = new Array(4096);
    this._absStars = 0;
    this._w = 0; this._h = 0;
    this._xOff = 0; this._yOff = 0;

    // GL resources for readPixels → CPU render → upload → blit.
    this._readFBO = gl.createFramebuffer();
    this._readBuf = null;
    this._outBuf  = null;
    this._bufW = 0; this._bufH = 0;

    this._outTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._outTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this._prog = createProgram(gl, vertSrc, BLIT_FRAG);
    this._uTex = gl.getUniformLocation(this._prog, 'uTex');
  }

  // Matches initialize_stars(): abs_stars = (stars * w * h) / (512 * 384), capped at 4095.
  // Each star gets a random per-star speed factor in [0.1, 1.0].
  _initStars(w, h) {
    this._absStars = Math.min(4095, Math.round(this.starCount * w * h / (512 * 384)));
    const xOff = this._xOff, yOff = this._yOff;
    for (let i = 0; i < this._absStars; i++) {
      this._stars[i] = {
        x:     (Math.random() * w | 0) - xOff,
        y:     (Math.random() * h | 0) - yOff,
        z:     Math.random() * 255,
        speed: ((Math.random() * 9 | 0) + 1) / 10,
      };
    }
  }

  // Matches create_star(): only resets position and z; per-star speed is preserved.
  _resetStar(i) {
    const s = this._stars[i];
    s.x = (Math.random() * this._w | 0) - this._xOff;
    s.y = (Math.random() * this._h | 0) - this._yOff;
    s.z = 255;
  }

  _ensureBuffers(gl, w, h) {
    if (this._bufW === w && this._bufH === h) return;
    this._bufW = w; this._bufH = h;
    this._readBuf = new Uint8Array(w * h * 4);
    this._outBuf  = new Uint8Array(w * h * 4);
    gl.bindTexture(gl.TEXTURE_2D, this._outTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    // On-beat: snap to on-beat speed and begin linear ramp back to normal speed.
    if (this.onBeat && isBeat) {
      this._currentSpeed = this.onBeatSpeed;
      this._onBeatDiff   = (this.speed - this.onBeatSpeed) / this.onBeatDuration;
      this._cooldown     = this.onBeatDuration;
    }

    // Re-initialize star pool when canvas size changes (matches the w/h guard in render()).
    if (this._w !== w || this._h !== h) {
      this._w = w; this._h = h;
      this._xOff = w >> 1;
      this._yOff = h >> 1;
      this._currentSpeed = this.speed;
      this._initStars(w, h);
    }

    this._ensureBuffers(gl, w, h);

    // Read inputTex into a CPU buffer so all three blend modes can operate on it.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._readFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, inputTex, 0);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this._readBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const outBuf   = this._outBuf;
    const readBuf  = this._readBuf;
    outBuf.set(readBuf);

    const [cr, cg, cb] = this.color;
    const isWhite  = cr === 255 && cg === 255 && cb === 255;
    const blendMode = this.blendMode;
    const curSpeed  = this._currentSpeed;

    for (let i = 0; i < this._absStars; i++) {
      const s = this._stars[i];

      // (int)z > 0 — matches the original's cast-to-int guard.
      if ((s.z | 0) <= 0) { this._resetStar(i); continue; }

      // Perspective projection: (x * 128) / z + xOff — matches the original's << 7 shift.
      const nx = ((s.x * 128) / s.z + this._xOff) | 0;
      const ny = ((s.y * 128) / s.z + this._yOff) | 0;

      // Strictly inside bounds, matching the original's (nx > 0 && nx < w) check.
      if (nx <= 0 || nx >= w || ny <= 0 || ny >= h) { this._resetStar(i); continue; }

      // brightness = (int)((255 - (int)z) * speed) — matches original's integer cast.
      const bright = Math.min(255, ((255 - (s.z | 0)) * s.speed) | 0);

      let pr, pg, pb;
      if (isWhite) {
        pr = pg = pb = bright;
      } else {
        [pr, pg, pb] = starColorize(bright, cr, cg, cb);
      }

      // Y-flip: screen ny=0 is top; buffer row 0 is bottom (GL texSubImage2D convention).
      const di = ((h - 1 - ny) * w + nx) * 4;

      switch (blendMode) {
        case 1:  // Additive — blend_add_1px (saturating add)
          outBuf[di]   = Math.min(255, outBuf[di]   + pr);
          outBuf[di+1] = Math.min(255, outBuf[di+1] + pg);
          outBuf[di+2] = Math.min(255, outBuf[di+2] + pb);
          break;
        case 2:  // 50/50 — blend_5050_1px ((a + b) >> 1)
          outBuf[di]   = (outBuf[di]   + pr) >> 1;
          outBuf[di+1] = (outBuf[di+1] + pg) >> 1;
          outBuf[di+2] = (outBuf[di+2] + pb) >> 1;
          break;
        default:  // Replace — direct write
          outBuf[di]   = pr;
          outBuf[di+1] = pg;
          outBuf[di+2] = pb;
      }
      outBuf[di+3] = 255;

      s.z -= s.speed * curSpeed;
    }

    // Speed ramp-back after on-beat (runs after the star loop, matching the original).
    if (!this._cooldown) {
      this._currentSpeed = this.speed;
    } else {
      this._currentSpeed = Math.max(0, this._currentSpeed + this._onBeatDiff);
      this._cooldown--;
    }

    // Ensure alpha=255 everywhere for downstream effects.
    for (let i = 3; i < outBuf.length; i += 4) outBuf[i] = 255;

    gl.bindTexture(gl.TEXTURE_2D, this._outTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, outBuf);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._outTex);
    gl.uniform1i(this._uTex, 0);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return {
      color:          [...this.color],
      blendMode:      this.blendMode,
      speed:          this.speed,
      starCount:      this.starCount,
      onBeat:         this.onBeat,
      onBeatSpeed:    this.onBeatSpeed,
      onBeatDuration: this.onBeatDuration,
    };
  }

  setConfig(cfg) {
    if (cfg.color          !== undefined) this.color     = cfg.color;
    if (cfg.blendMode      !== undefined) this.blendMode = cfg.blendMode | 0;
    if (cfg.speed          !== undefined) {
      this.speed = cfg.speed;
      if (!this._cooldown) this._currentSpeed = this.speed;
    }
    if (cfg.starCount !== undefined) {
      this.starCount = cfg.starCount | 0;
      if (this._w > 0) this._initStars(this._w, this._h);
    }
    if (cfg.onBeat         !== undefined) this.onBeat         = !!cfg.onBeat;
    if (cfg.onBeatSpeed    !== undefined) this.onBeatSpeed    = cfg.onBeatSpeed;
    if (cfg.onBeatDuration !== undefined) this.onBeatDuration = Math.max(1, cfg.onBeatDuration | 0);
  }

  getDescriptor() {
    return {
      name: 'Starfield',
      params: [
        { name: 'color',          label: 'Color',            type: 'color',  default: [255, 255, 255] },
        { name: 'blendMode',      label: 'Blend Mode',       type: 'select', options: BLEND_OPTIONS, default: 0 },
        { name: 'speed',          label: 'Warp Speed',       type: 'range',  min: 1, max: 500, step: 1,   default: 6   },
        { name: 'starCount',      label: 'Stars',            type: 'range',  min: 100, max: 4095, step: 1, default: 350 },
        { name: 'onBeat',         label: 'On Beat',          type: 'bool',   default: false },
        { name: 'onBeatSpeed',    label: 'On-Beat Speed',    type: 'range',  min: 1, max: 500, step: 1,   default: 4   },
        { name: 'onBeatDuration', label: 'On-Beat Duration', type: 'range',  min: 1, max: 100, step: 1,   default: 15  },
      ],
    };
  }

  destroy() {
    const gl = this.gl;
    gl.deleteProgram(this._prog);
    gl.deleteTexture(this._outTex);
    gl.deleteFramebuffer(this._readFBO);
  }
}
