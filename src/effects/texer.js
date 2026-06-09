import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Simple passthrough — uploads the fully-composited CPU buffer to the output FBO.
const BLIT_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 fragColor;
void main() { fragColor = texture(uTex, vUv); }`;

// ── Default 21×21 soft-dot ────────────────────────────────────────────────────

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

// ── Effect ────────────────────────────────────────────────────────────────────

export class TexerEffect extends Effect {
  constructor(gl) {
    super(gl);

    this.imageDataUrl = '';
    this.addToInput   = false;
    this.colorize     = false;
    this.numParticles = 100;

    this._imgData = DEFAULT_IMG.data;
    this._iw      = DEFAULT_IMG.w;
    this._ih      = DEFAULT_IMG.h;

    // Temporary FBO used only to attach inputTex so gl.readPixels can read it.
    this._readFBO = gl.createFramebuffer();
    this._readBuf = null;
    this._outBuf  = null;
    this._bufW    = 0;
    this._bufH    = 0;

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

  _loadImage(dataUrl) {
    if (!dataUrl) {
      this._imgData = DEFAULT_IMG.data;
      this._iw = DEFAULT_IMG.w;
      this._ih = DEFAULT_IMG.h;
      return;
    }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx2d = c.getContext('2d');
      ctx2d.drawImage(img, 0, 0);
      this._imgData = new Uint8Array(ctx2d.getImageData(0, 0, c.width, c.height).data);
      this._iw = c.width;
      this._ih = c.height;
    };
    img.onerror = () => {
      this._imgData = DEFAULT_IMG.data;
      this._iw = DEFAULT_IMG.w;
      this._ih = DEFAULT_IMG.h;
    };
    img.src = dataUrl;
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

  // Additively stamp the image centered at (cx, cy) in the output buffer.
  // Matches the original render_particle() logic exactly, including integer half-sizes
  // and the (mask * pixel) >> 8 approximation of the SSE2 colorize path.
  _stamp(cx, cy, cr, cg, cb) {
    const outBuf = this._outBuf;
    const w = this._bufW, h = this._bufH;
    const iw = this._iw, ih = this._ih;
    const iwHalf = iw >> 1;
    const ihHalf = ih >> 1;
    const iwOtherHalf = iw - iwHalf;
    const ihOtherHalf = ih - ihHalf;

    const fbStartX = cx - iwHalf;
    const fbStartY = cy - ihHalf;
    const fbEndX   = cx + iwOtherHalf;
    const fbEndY   = cy + ihOtherHalf;

    const imgStartX = -Math.min(0, fbStartX);
    const imgStartY = -Math.min(0, fbStartY);
    const imgEndX   = iw + Math.min(0, w - fbEndX);
    const imgEndY   = ih + Math.min(0, h - fbEndY);
    const fbx0 = Math.max(0, fbStartX);
    const fby0 = Math.max(0, fbStartY);

    const img = this._imgData;
    const colorize = this.colorize;

    for (let iy = imgStartY, fby = fby0; iy < imgEndY; iy++, fby++) {
      const imgRowOff = iy * iw;
      const outRowOff = fby * w;
      for (let ix = imgStartX, fbx = fbx0; ix < imgEndX; ix++, fbx++) {
        const si = (imgRowOff + ix) * 4;
        let sr = img[si], sg = img[si+1], sb = img[si+2];
        if (colorize) {
          // (src * mask) >> 8 — matches the original SSE2 mullo+srli path
          sr = (sr * cr) >> 8;
          sg = (sg * cg) >> 8;
          sb = (sb * cb) >> 8;
        }
        const di = (outRowOff + fbx) * 4;
        outBuf[di]   = Math.min(255, outBuf[di]   + sr);
        outBuf[di+1] = Math.min(255, outBuf[di+1] + sg);
        outBuf[di+2] = Math.min(255, outBuf[di+2] + sb);
        outBuf[di+3] = 255;
      }
    }
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    this._ensureBuffers(gl, w, h);

    // Read the input texture into a CPU buffer.
    // gl.readPixels stores row 0 at the screen bottom (OpenGL convention).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._readFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, inputTex, 0);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this._readBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const readBuf = this._readBuf;
    const outBuf  = this._outBuf;

    if (this.addToInput) {
      outBuf.set(readBuf);
    } else {
      outBuf.fill(0);
    }

    // Scan left-to-right, screen top-to-bottom — matching the original loop order.
    // In the readBuf, buffer row y=h-1 corresponds to screen top (y=0 in C++).
    let p = 0;
    const maxP = this.numParticles;
    outer:
    for (let by = h - 1; by >= 0; by--) {
      for (let bx = 0; bx < w; bx++) {
        const i = (by * w + bx) * 4;
        if ((readBuf[i] | readBuf[i+1] | readBuf[i+2]) !== 0) {
          this._stamp(bx, by, readBuf[i], readBuf[i+1], readBuf[i+2]);
          if (++p >= maxP) break outer;
        }
      }
    }

    // Ensure all output pixels have alpha=255 so downstream sampling is correct.
    for (let i = 3; i < outBuf.length; i += 4) outBuf[i] = 255;

    // Upload and blit to outputFBO.
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
      imageDataUrl: this.imageDataUrl,
      addToInput:   this.addToInput,
      colorize:     this.colorize,
      numParticles: this.numParticles,
    };
  }

  setConfig(cfg) {
    if (cfg.addToInput   !== undefined) this.addToInput   = !!cfg.addToInput;
    if (cfg.colorize     !== undefined) this.colorize     = !!cfg.colorize;
    if (cfg.numParticles !== undefined) this.numParticles = Math.max(1, Math.min(1024, cfg.numParticles | 0));
    if (cfg.imageDataUrl !== undefined && cfg.imageDataUrl !== this.imageDataUrl) {
      this.imageDataUrl = cfg.imageDataUrl;
      this._loadImage(cfg.imageDataUrl);
    }
  }

  getDescriptor() {
    return {
      name: 'Texer',
      params: [
        { name: 'imageDataUrl', label: 'Image',        type: 'image-upload', default: '' },
        { name: 'addToInput',   label: 'Add to Input', type: 'bool',  default: false },
        { name: 'colorize',     label: 'Colorize',     type: 'bool',  default: false },
        { name: 'numParticles', label: 'Particles',    type: 'range', min: 1, max: 1024, step: 1, default: 100 },
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
