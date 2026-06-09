import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// blend: 0=replace, 1=additive, 2=5050
// fit:   0=stretch, 1=fitwidth, 2=fitheight
const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform sampler2D uImage;
uniform int uBlend;
uniform int uFit;
uniform float uImgAspect;
uniform float uScrAspect;
out vec4 fragColor;

void main() {
  vec4 base = texture(uInput, vUv);
  vec2 imgUv = vUv;
  bool inside = true;

  if (uFit == 1) {
    // Fit Width: full width, height scaled proportionally and centered
    float hFrac = uScrAspect / uImgAspect;
    float y0 = 0.5 - hFrac * 0.5;
    float y1 = 0.5 + hFrac * 0.5;
    inside = (vUv.y >= y0 && vUv.y <= y1);
    if (inside) imgUv.y = (vUv.y - y0) / hFrac;
  } else if (uFit == 2) {
    // Fit Height: full height, width scaled proportionally and centered
    float wFrac = uImgAspect / uScrAspect;
    float x0 = 0.5 - wFrac * 0.5;
    float x1 = 0.5 + wFrac * 0.5;
    inside = (vUv.x >= x0 && vUv.x <= x1);
    if (inside) imgUv.x = (vUv.x - x0) / wFrac;
  }

  vec4 img = inside ? texture(uImage, imgUv) : vec4(0.0, 0.0, 0.0, 1.0);

  if (uBlend == 1) {
    fragColor = min(img + base, vec4(1.0));
  } else if (uBlend == 2) {
    fragColor = 0.5 * img + 0.5 * base;
  } else {
    fragColor = img;
  }
}`;

export class PictureEffect extends Effect {
  constructor(gl) {
    super(gl);

    this.imageData        = '';
    this.blendMode        = 2;     // 0=replace, 1=additive, 2=5050
    this.onBeatAdditive   = false;
    this.onBeatDuration   = 6;
    this.fit              = 0;     // 0=stretch, 1=fitwidth, 2=fitheight

    this._tex      = null;
    this._imgW     = 1;
    this._imgH     = 1;
    this._cooldown = 0;

    this._prog       = createProgram(gl, vertSrc, FRAG);
    this._uInput     = gl.getUniformLocation(this._prog, 'uInput');
    this._uImage     = gl.getUniformLocation(this._prog, 'uImage');
    this._uBlend     = gl.getUniformLocation(this._prog, 'uBlend');
    this._uFit       = gl.getUniformLocation(this._prog, 'uFit');
    this._uImgAspect = gl.getUniformLocation(this._prog, 'uImgAspect');
    this._uScrAspect = gl.getUniformLocation(this._prog, 'uScrAspect');
  }

  _loadImage(dataUrl) {
    const gl = this.gl;
    if (this._tex) { gl.deleteTexture(this._tex); this._tex = null; }
    if (!dataUrl) return;

    const img = new Image();
    img.onload = () => {
      this._imgW = img.width;
      this._imgH = img.height;
      this._tex  = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
    };
    img.src = dataUrl;
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    if (!this._tex) return;

    if (isBeat) this._cooldown = this.onBeatDuration;
    else if (this._cooldown > 0) this._cooldown--;

    const beatActive = isBeat || this._cooldown > 0;
    const blend = (this.blendMode === 1 || (this.onBeatAdditive && beatActive)) ? 1 : this.blendMode;

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.uniform1i(this._uImage, 1);

    gl.uniform1i(this._uBlend, blend);
    gl.uniform1i(this._uFit, this.fit);
    gl.uniform1f(this._uImgAspect, this._imgW / this._imgH);
    gl.uniform1f(this._uScrAspect, w / h);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    fboManager.swap();
  }

  getConfig() {
    return {
      imageData:      this.imageData,
      blendMode:      this.blendMode,
      onBeatAdditive: this.onBeatAdditive,
      onBeatDuration: this.onBeatDuration,
      fit:            this.fit,
    };
  }

  setConfig(cfg) {
    if (cfg.imageData !== undefined && cfg.imageData !== this.imageData) {
      this.imageData = cfg.imageData;
      this._loadImage(this.imageData);
    }
    if (cfg.blendMode      !== undefined) this.blendMode      = cfg.blendMode;
    if (cfg.onBeatAdditive !== undefined) this.onBeatAdditive = cfg.onBeatAdditive;
    if (cfg.onBeatDuration !== undefined) this.onBeatDuration = Math.max(0, Math.min(32, cfg.onBeatDuration));
    if (cfg.fit            !== undefined) this.fit            = cfg.fit;
  }

  getDescriptor() {
    return {
      name: 'Picture',
      params: [
        { name: 'imageData',      label: 'Image',             type: 'image-upload', default: '' },
        { name: 'blendMode',      label: 'Blend Mode',        type: 'select',
          options: [
            { value: 0, label: 'Replace'  },
            { value: 1, label: 'Additive' },
            { value: 2, label: '50/50'    },
          ], default: 2 },
        { name: 'onBeatAdditive', label: 'On-Beat Additive',  type: 'bool',  default: false },
        { name: 'onBeatDuration', label: 'On-Beat Duration',  type: 'range', min: 0, max: 32, step: 1, default: 6,
          disabledWhen: { param: 'onBeatAdditive', value: false } },
        { name: 'fit',            label: 'Image Fit',         type: 'select',
          options: [
            { value: 0, label: 'Stretch'    },
            { value: 1, label: 'Fit Width'  },
            { value: 2, label: 'Fit Height' },
          ], default: 0 },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._tex) this.gl.deleteTexture(this._tex);
  }
}
