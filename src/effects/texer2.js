import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const BINS = 576;
const MAX_N = 65536;

const EXAMPLES = [
  {
    name: 'Colored Oscilloscope',
    initCode:  'n=300;',
    frameCode: '',
    beatCode:  '',
    pointCode: 'x=(i*2-1)*2;y=v;\nred=1-y*2;green=abs(y)*2;blue=y*2-1;',
    resize: false, wrap: false, colorize: true,
  },
  {
    name: 'Flummy Spectrum',
    initCode:  '// Needs Maximum render mode',
    frameCode: 'n=w/20+1;',
    beatCode:  '',
    pointCode: 'x=i*1.8-.9;\ny=0;\nvol=1.001-getspec(abs(x)*.5,.05,0)*min(1,abs(x)+.5)*2;\nsizex=vol;sizey=(1/vol)*2;\nj=abs(x);red=1-j;green=1-abs(.5-j);blue=j',
    resize: true, wrap: false, colorize: true,
  },
  {
    name: 'Beat-responsive Circle',
    initCode:  '// Needs Maximum render mode\nn=30;newradius=.5;',
    frameCode: 'rotation=rotation+step;step=step*.9;\nradius=radius*.9+newradius*.1;\npoint=0;\naspect=h/w;',
    beatCode:  'step=.05;\nnewradius=rand(100)*.005+.5;',
    pointCode: 'angle=rotation+point/n*$pi*2;\nx=cos(angle)*radius*aspect;y=sin(angle)*radius;\nred=sin(i*$pi*2)*.5+.5;green=1-red;blue=.5;\npoint=point+1;',
    resize: false, wrap: false, colorize: true,
  },
  {
    name: '3D Beat Rings',
    initCode:  'xr=(rand(50)/500)-0.05;\nyr=(rand(50)/500)-0.05;\nzr=(rand(50)/500)-0.05;',
    frameCode: 'xt=xt+xr;yt=yt+yr;zt=zt+zr;\nbt=max(0,bt*.95+.01);\nasp=w/h;\nn=((bt*40)|0)*3;',
    beatCode:  'xr=(rand(50)/500)-0.05;\nyr=(rand(50)/500)-0.05;\nzr=(rand(50)/500)-0.05;\nbt=1.2;\nn=((bt*40)|0)*3;',
    pointCode: 'x1=sin(i*$pi*6)/2*bt;\ny1=above(i,.66)-below(i,.33);\nz1=cos(i*$pi*6)/2*bt;\nx2=x1*sin(zt)-y1*cos(zt);y2=x1*cos(zt)+y1*sin(zt);\nz2=x2*cos(yt)+z1*sin(yt);x3=x2*sin(yt)-z1*cos(yt);\ny3=y2*sin(xt)-z2*cos(xt);z3=y2*cos(xt)+z2*sin(xt);\niz=1/(z3+2);\nx=x3*iz;y=y3*iz*asp;\nsizex=iz*2;sizey=iz*2;',
    resize: true, wrap: false, colorize: false,
  },
];

const COMP_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform sampler2D uOverlay;
uniform int   uBlend;
uniform float uAlpha;
out vec4 fragColor;

void main() {
  vec3 bg = texture(uInput,   vUv).rgb;
  vec4 ov = texture(uOverlay, vUv);

  if (ov.a < 0.5) { fragColor = vec4(bg, 1.0); return; }

  vec3 src = ov.rgb;
  vec3 result;
  if      (uBlend == 1)  result = min(bg + src, vec3(1.0));
  else if (uBlend == 2)  result = max(bg, src);
  else if (uBlend == 3)  result = (bg + src) * 0.5;
  else if (uBlend == 4)  result = max(bg - src, vec3(0.0));
  else if (uBlend == 5)  result = max(src - bg, vec3(0.0));
  else if (uBlend == 6)  result = bg * src;
  else if (uBlend == 7)  result = mix(bg, src, uAlpha);
  else if (uBlend == 8) {
    ivec3 a = ivec3(bg  * 255.0 + 0.5);
    ivec3 b = ivec3(src * 255.0 + 0.5);
    result = vec3(a ^ b) / 255.0;
  }
  else if (uBlend == 9)  result = min(bg, src);
  else                   result = src;

  fragColor = vec4(result, 1.0);
}`;

// ── Default 21×21 soft-dot image ─────────────────────────────────────────────

function makeDefaultImage() {
  const size = 21;
  const data = new Uint8Array(size * size * 4);
  const r = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - r) ** 2 + (y - r) ** 2) / r;
      const v = Math.round(Math.max(0, 1 - d) ** 2 * 255);
      const i = (y * size + x) * 4;
      data[i] = v; data[i+1] = v; data[i+2] = v; data[i+3] = 255;
    }
  }
  return { data, w: size, h: size };
}

const DEFAULT_IMG = makeDefaultImage();

// ── Bilinear sample from RGBA Uint8Array ─────────────────────────────────────

function bilinearSample(data, iw, ih, tx, ty) {
  const x0 = Math.floor(tx), y0 = Math.floor(ty);
  const x1 = Math.min(x0 + 1, iw - 1), y1 = Math.min(y0 + 1, ih - 1);
  const fx = tx - x0, fy = ty - y0;
  const s = (py, px) => {
    const i = (py * iw + px) * 4;
    return [data[i] / 255, data[i+1] / 255, data[i+2] / 255];
  };
  const [a, b, c, d] = [s(y0,x0), s(y0,x1), s(y1,x0), s(y1,x1)];
  const w00 = (1-fx)*(1-fy), w10 = fx*(1-fy), w01 = (1-fx)*fy, w11 = fx*fy;
  return [
    a[0]*w00 + b[0]*w10 + c[0]*w01 + d[0]*w11,
    a[1]*w00 + b[1]*w10 + c[1]*w01 + d[1]*w11,
    a[2]*w00 + b[2]*w10 + c[2]*w01 + d[2]*w11,
  ];
}

// ── Particle-on-overlay accumulation blend ────────────────────────────────────

function blendPixel(dr, dg, db, painted, sr, sg, sb, mode, alpha = 1) {
  if (!painted) return [sr, sg, sb];
  switch (mode) {
    case 1:  return [Math.min(dr+sr,1), Math.min(dg+sg,1), Math.min(db+sb,1)];
    case 2:  return [Math.max(dr,sr), Math.max(dg,sg), Math.max(db,sb)];
    case 3:  return [(dr+sr)*.5, (dg+sg)*.5, (db+sb)*.5];
    case 4:  return [Math.max(dr-sr,0), Math.max(dg-sg,0), Math.max(db-sb,0)];
    case 5:  return [Math.max(sr-dr,0), Math.max(sg-dg,0), Math.max(sb-db,0)];
    case 6:  return [dr*sr, dg*sg, db*sb];
    case 7:  return [dr*(1-alpha)+sr*alpha, dg*(1-alpha)+sg*alpha, db*(1-alpha)+sb*alpha];
    case 8: {
      const xr = (Math.round(dr*255) ^ Math.round(sr*255)) / 255;
      const xg = (Math.round(dg*255) ^ Math.round(sg*255)) / 255;
      const xb = (Math.round(db*255) ^ Math.round(sb*255)) / 255;
      return [xr, xg, xb];
    }
    case 9:  return [Math.min(dr,sr), Math.min(dg,sg), Math.min(db,sb)];
    default: return [sr, sg, sb];
  }
}

// ── EEL-compatible variable proxy (uninitialized vars default to 0) ───────────

const _SKIP = new Set(['__proto__', 'prototype', 'constructor', Symbol.unscopables]);

function makeEELProxy(vars) {
  return new Proxy(vars, {
    get(t, k) {
      if (_SKIP.has(k) || typeof k !== 'string') return t[k];
      return k in t ? t[k] : 0;
    },
    has(t, k) {
      if (_SKIP.has(k) || typeof k !== 'string') return k in t;
      return true;
    },
    set(t, k, v) {
      if (typeof k === 'string' && !_SKIP.has(k)) t[k] = v;
      return true;
    },
  });
}

// ── Effect class ──────────────────────────────────────────────────────────────

export class Texer2Effect extends Effect {
  constructor(gl) {
    super(gl);

    this.initCode  = EXAMPLES[0].initCode;
    this.frameCode = EXAMPLES[0].frameCode;
    this.beatCode  = EXAMPLES[0].beatCode;
    this.pointCode = EXAMPLES[0].pointCode;
    this.resize    = EXAMPLES[0].resize;
    this.wrap      = EXAMPLES[0].wrap;
    this.colorize  = EXAMPLES[0].colorize;
    this.imageDataUrl = '';
    this.example      = 0;

    this._needInit = true;
    this._vars     = this._makeVars();
    this._proxy    = makeEELProxy(this._vars);

    this._imgData  = DEFAULT_IMG.data;
    this._iw       = DEFAULT_IMG.w;
    this._ih       = DEFAULT_IMG.h;

    this._overlayTex = gl.createTexture();
    this._overlayW   = 0;
    this._overlayH   = 0;
    this._overlayBuf = null;

    gl.bindTexture(gl.TEXTURE_2D, this._overlayTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this._prog     = createProgram(gl, vertSrc, COMP_FRAG);
    this._uInput   = gl.getUniformLocation(this._prog, 'uInput');
    this._uOverlay = gl.getUniformLocation(this._prog, 'uOverlay');
    this._uBlend   = gl.getUniformLocation(this._prog, 'uBlend');
    this._uAlpha   = gl.getUniformLocation(this._prog, 'uAlpha');
  }

  _makeVars() {
    return {
      n: 0, i: 0, x: 0, y: 0, v: 0, b: 0,
      w: 0, h: 0, iw: DEFAULT_IMG.w, ih: DEFAULT_IMG.h,
      sizex: 1, sizey: 1,
      red: 1, green: 1, blue: 1, skip: 0,
      // Math & EEL built-ins
      sin: Math.sin, cos: Math.cos, tan: Math.tan,
      sqrt: Math.sqrt, abs: Math.abs, pow: Math.pow,
      floor: Math.floor, ceil: Math.ceil, sign: Math.sign,
      min: Math.min, max: Math.max,
      log: Math.log, exp: Math.exp,
      atan:  (a, b) => (b !== undefined ? Math.atan2(a, b) : Math.atan(a)),
      atan2: Math.atan2,
      int:   Math.trunc,
      rand:  (n) => Math.floor(Math.random() * n),
      above: (a, b) => (a > b ? 1 : 0),
      below: (a, b) => (a < b ? 1 : 0),
      equal: (a, b) => (a === b ? 1 : 0),
      if:    (c, t, f) => (c ? t : f),
      getspec: () => 0,
      getosc:  () => 0,
    };
  }

  _runBlock(code) {
    if (!code || !code.trim()) return;
    const src = code.replace(/\$pi\b/gi, '3.141592653589793');
    try {
      new Function('__s', `with(__s){${src}}`)(this._proxy);
    } catch { /* ignore */ }
  }

  _ensureOverlay(gl, w, h) {
    if (this._overlayW === w && this._overlayH === h) return;
    this._overlayW = w; this._overlayH = h;
    this._overlayBuf = new Uint8Array(w * h * 4);
    gl.bindTexture(gl.TEXTURE_2D, this._overlayTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  _loadImage(url) {
    if (!url) {
      this._imgData = DEFAULT_IMG.data;
      this._iw = DEFAULT_IMG.w; this._ih = DEFAULT_IMG.h;
      this._vars.iw = this._iw; this._vars.ih = this._ih;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      this._imgData = new Uint8Array(ctx.getImageData(0, 0, c.width, c.height).data);
      this._iw = c.width; this._ih = c.height;
      this._vars.iw = this._iw; this._vars.ih = this._ih;
    };
    img.onerror = () => {
      this._imgData = DEFAULT_IMG.data;
      this._iw = DEFAULT_IMG.w; this._ih = DEFAULT_IMG.h;
      this._vars.iw = this._iw; this._vars.ih = this._ih;
    };
    img.src = url;
  }

  _stamp(buf, bufW, bufH, cx, cy, sizex, sizey, color, mode, alpha) {
    const iw = this._iw, ih = this._ih, img = this._imgData;
    const flipX = sizex < 0, flipY = sizey < 0;
    const szx = Math.abs(sizex), szy = Math.abs(sizey);

    let left, top, destW, destH;
    if (this.resize) {
      destW = Math.max(1, Math.round(iw * szx));
      destH = Math.max(1, Math.round(ih * szy));
      left = Math.round(cx - destW * 0.5);
      top  = Math.round(cy - destH * 0.5);
    } else {
      destW = iw; destH = ih;
      left = cx - (iw >> 1);
      top  = cy - (ih >> 1);
    }

    for (let dy = 0; dy < destH; dy++) {
      const sy = top + dy;
      if (sy < 0 || sy >= bufH) continue;
      let fv = destH > 1 ? dy / (destH - 1) : 0;
      if (flipY) fv = 1 - fv;

      for (let dx = 0; dx < destW; dx++) {
        const sx = left + dx;
        if (sx < 0 || sx >= bufW) continue;
        let fu = destW > 1 ? dx / (destW - 1) : 0;
        if (flipX) fu = 1 - fu;

        let ir, ig, ib;
        if (this.resize) {
          [ir, ig, ib] = bilinearSample(img, iw, ih, fu * (iw - 1), fv * (ih - 1));
        } else {
          const si = (Math.round(fv * (ih - 1)) * iw + Math.round(fu * (iw - 1))) * 4;
          ir = img[si] / 255; ig = img[si+1] / 255; ib = img[si+2] / 255;
        }

        const sr = ir * (this.colorize ? color[0] : 1);
        const sg = ig * (this.colorize ? color[1] : 1);
        const sb = ib * (this.colorize ? color[2] : 1);

        const di = (sy * bufW + sx) * 4;
        const painted = buf[di+3] > 0;
        const dr = buf[di]/255, dg = buf[di+1]/255, db = buf[di+2]/255;
        const [or_, og, ob] = blendPixel(dr, dg, db, painted, sr, sg, sb, mode, alpha);
        buf[di]   = Math.min(255, Math.round(or_ * 255));
        buf[di+1] = Math.min(255, Math.round(og  * 255));
        buf[di+2] = Math.min(255, Math.round(ob  * 255));
        buf[di+3] = 255;
      }
    }
  }

  _drawParticle(buf, w, h, nx, ny, sizex, sizey, color, mode, alpha) {
    const szx = Math.abs(sizex), szy = Math.abs(sizey);
    const cx = Math.round((nx * 0.5 + 0.5) * (w - 1));
    const cy = Math.round((1 - (ny * 0.5 + 0.5)) * (h - 1));
    this._stamp(buf, w, h, cx, cy, sizex, sizey, color, mode, alpha);

    if (this.wrap) {
      const spriteW = this.resize ? Math.round(this._iw * szx) : this._iw;
      const spriteH = this.resize ? Math.round(this._ih * szy) : this._ih;
      const ovX = cx - spriteW / 2 < 0 || cx + spriteW / 2 >= w;
      const ovY = cy - spriteH / 2 < 0 || cy + spriteH / 2 >= h;
      const dX  = cx < w / 2 ? w : -w;
      const dY  = cy < h / 2 ? h : -h;
      if (ovX)       this._stamp(buf, w, h, cx + dX, cy,      sizex, sizey, color, mode, alpha);
      if (ovY)       this._stamp(buf, w, h, cx,      cy + dY, sizex, sizey, color, mode, alpha);
      if (ovX && ovY)this._stamp(buf, w, h, cx + dX, cy + dY, sizex, sizey, color, mode, alpha);
    }
  }

  render(ctx) {
    const { gl, visdata, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    // Update audio accessors
    this._vars.w  = w; this._vars.h  = h;
    this._vars.iw = this._iw; this._vars.ih = this._ih;
    this._vars.b  = isBeat ? 1 : 0;

    const makeSpectrum = (ch) => (pos, width) => {
      const data = visdata[0][ch];
      const s = Math.floor(Math.abs(pos) * BINS);
      const e = Math.min(BINS - 1, s + Math.max(1, Math.floor(Math.abs(width || 0.05) * BINS)));
      let sum = 0;
      for (let k = s; k <= e; k++) sum += (data[k] || 0) / 255;
      return sum / (e - s + 1);
    };
    const makeOsc = (ch) => (pos, width) => {
      const data = visdata[1][ch];
      const s = Math.floor(Math.abs(pos) * BINS);
      const e = Math.min(BINS - 1, s + Math.max(1, Math.floor(Math.abs(width || 0.05) * BINS)));
      let sum = 0;
      for (let k = s; k <= e; k++) sum += ((data[k] || 128) / 128 - 1);
      return sum / (e - s + 1);
    };
    this._vars.getspec = (pos, width, ch = 0) => makeSpectrum(ch >= 2 ? 1 : 0)(pos, width);
    this._vars.getosc  = (pos, width, ch = 0) => makeOsc(ch >= 2 ? 1 : 0)(pos, width);

    // Lifecycle
    if (this._needInit) {
      this._vars.n = 0;
      this._runBlock(this.initCode);
      this._needInit = false;
    }
    this._runBlock(this.frameCode);
    if (isBeat) this._runBlock(this.beatCode);

    const n = Math.max(0, Math.min(MAX_N, Math.round(this._vars.n)));

    const blendMode = ctx.lineBlendMode & 0xFF;
    const alpha     = ((ctx.lineBlendMode >> 8) & 0xFF) / 255;

    this._ensureOverlay(gl, w, h);
    const buf = this._overlayBuf;
    buf.fill(0);

    if (n > 0) {
      const audio = visdata[1][0];
      const step      = n > 1 ? 1 / (n - 1) : 0;

      for (let j = 0; j < n; j++) {
        this._vars.i = j * step;
        this._vars.skip = 0;
        this._vars.x = 0; this._vars.y = 0;
        this._vars.sizex = 1; this._vars.sizey = 1;
        this._vars.red = 1; this._vars.green = 1; this._vars.blue = 1;
        const aIdx = Math.min(Math.floor(j * 575 / Math.max(1, n)), 575);
        this._vars.v = ((audio[aIdx] || 128) / 128) - 1;

        this._runBlock(this.pointCode);

        if (this._vars.skip) continue;
        if (Math.abs(this._vars.sizex) < 0.01 || Math.abs(this._vars.sizey) < 0.01) continue;

        const color = [
          Math.max(0, Math.min(1, this._vars.red)),
          Math.max(0, Math.min(1, this._vars.green)),
          Math.max(0, Math.min(1, this._vars.blue)),
        ];

        let nx = this._vars.x, ny = this._vars.y;
        if (this.wrap) {
          nx -= Math.round(nx / 2) * 2;
          ny -= Math.round(ny / 2) * 2;
        }
        this._drawParticle(buf, w, h, nx, ny, this._vars.sizex, this._vars.sizey, color, blendMode, alpha);
      }
    }

    // Upload overlay & composite
    gl.bindTexture(gl.TEXTURE_2D, this._overlayTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, inputTex);  gl.uniform1i(this._uInput, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this._overlayTex); gl.uniform1i(this._uOverlay, 1);
    gl.uniform1i(this._uBlend, blendMode);
    gl.uniform1f(this._uAlpha, alpha);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  loadExample() {
    const ex = EXAMPLES[Math.max(0, Math.min(EXAMPLES.length - 1, this.example | 0))];
    this.initCode  = ex.initCode;
    this.frameCode = ex.frameCode;
    this.beatCode  = ex.beatCode;
    this.pointCode = ex.pointCode;
    this.resize    = ex.resize;
    this.wrap      = ex.wrap;
    this.colorize  = ex.colorize;
    this._vars     = this._makeVars();
    this._proxy    = makeEELProxy(this._vars);
    this._needInit = true;
  }

  getConfig() {
    return {
      initCode:     this.initCode,     frameCode:    this.frameCode,
      beatCode:     this.beatCode,     pointCode:    this.pointCode,
      resize:       this.resize,       wrap:         this.wrap,
      colorize:     this.colorize,     imageDataUrl: this.imageDataUrl,
      example:      this.example,
    };
  }

  setConfig(cfg) {
    if (cfg.initCode     !== undefined) { this.initCode  = cfg.initCode;  this._needInit = true; }
    if (cfg.frameCode    !== undefined)   this.frameCode = cfg.frameCode;
    if (cfg.beatCode     !== undefined)   this.beatCode  = cfg.beatCode;
    if (cfg.pointCode    !== undefined)   this.pointCode = cfg.pointCode;
    if (cfg.resize       !== undefined)   this.resize    = !!cfg.resize;
    if (cfg.wrap         !== undefined)   this.wrap      = !!cfg.wrap;
    if (cfg.colorize     !== undefined)   this.colorize  = !!cfg.colorize;
    if (cfg.example      !== undefined)   this.example   = cfg.example | 0;
    if (cfg.imageDataUrl !== undefined && cfg.imageDataUrl !== this.imageDataUrl) {
      this.imageDataUrl = cfg.imageDataUrl;
      this._loadImage(cfg.imageDataUrl);
    }
  }

  getDescriptor() {
    return {
      name: 'Texer II',
      params: [
        { name: 'resize',    label: 'Resizing',         type: 'bool', default: false },
        { name: 'wrap',      label: 'Wrap Around',      type: 'bool', default: false },
        { name: 'colorize',  label: 'Color Filtering',  type: 'bool', default: true  },
        { name: 'imageDataUrl', label: 'Image',           type: 'image-upload', default: '' },
        { name: 'initCode',  label: 'Init',             type: 'text', default: EXAMPLES[0].initCode  },
        { name: 'frameCode', label: 'Frame',            type: 'text', default: EXAMPLES[0].frameCode },
        { name: 'beatCode',  label: 'Beat',             type: 'text', default: EXAMPLES[0].beatCode  },
        { name: 'pointCode', label: 'Point',            type: 'glsl', default: EXAMPLES[0].pointCode },
        { name: 'example',   label: 'Example',          type: 'select',
          options: EXAMPLES.map((e, i) => ({ value: i, label: e.name })), default: 0 },
        { name: 'loadExample', label: 'Load Example',   type: 'action' },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    this.gl.deleteTexture(this._overlayTex);
  }
}
