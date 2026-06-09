import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Blend mode indices (match descriptor options order):
// 0=Replace, 1=Additive, 2=Maximum, 3=50/50, 4=Sub1, 5=Sub2,
// 6=Multiply, 7=Adjustable, 8=XOR, 9=Minimum, 10=Ignore

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform sampler2D uImage;
uniform int uBlend;
uniform float uAdjust;
out vec4 fragColor;

void main() {
  vec4 base = texture(uInput, vUv);
  vec4 img  = texture(uImage, vUv);

  if (uBlend == 0) {
    fragColor = img;
  } else if (uBlend == 1) {
    fragColor = min(img + base, vec4(1.0));
  } else if (uBlend == 2) {
    fragColor = max(img, base);
  } else if (uBlend == 3) {
    fragColor = 0.5 * img + 0.5 * base;
  } else if (uBlend == 4) {
    fragColor = vec4(max(base.rgb - img.rgb, vec3(0.0)), 1.0);
  } else if (uBlend == 5) {
    fragColor = vec4(max(img.rgb - base.rgb, vec3(0.0)), 1.0);
  } else if (uBlend == 6) {
    fragColor = vec4(img.rgb * base.rgb, 1.0);
  } else if (uBlend == 7) {
    fragColor = vec4(mix(base.rgb, img.rgb, uAdjust), 1.0);
  } else if (uBlend == 8) {
    uvec3 ia = uvec3(img.rgb  * 255.0 + 0.5);
    uvec3 ba = uvec3(base.rgb * 255.0 + 0.5);
    fragColor = vec4(vec3(ia ^ ba) / 255.0, 1.0);
  } else if (uBlend == 9) {
    fragColor = min(img, base);
  } else {
    fragColor = base;
  }
}`;

const BLEND_OPTIONS = [
  { value: 0,  label: 'Replace'       },
  { value: 1,  label: 'Additive'      },
  { value: 2,  label: 'Maximum'       },
  { value: 3,  label: '50/50'         },
  { value: 4,  label: 'Subtractive 1' },
  { value: 5,  label: 'Subtractive 2' },
  { value: 6,  label: 'Multiply'      },
  { value: 7,  label: 'Adjustable'    },
  { value: 8,  label: 'XOR'           },
  { value: 9,  label: 'Minimum'       },
  { value: 10, label: 'Ignore'        },
];

export class Picture2Effect extends Effect {
  constructor(gl) {
    super(gl);

    this.imageData          = '';
    this.blendMode          = 0;    // normal blend mode (0-10)
    this.onBeatBlendMode    = 0;    // blend mode on beat frames
    this.bilinear           = true;
    this.onBeatBilinear     = true;
    this.adjustBlend        = 128;  // 0-255 for Adjustable mode
    this.onBeatAdjustBlend  = 128;

    this._tex    = null;
    this._imgW   = 1;
    this._imgH   = 1;

    this._prog    = createProgram(gl, vertSrc, FRAG);
    this._uInput  = gl.getUniformLocation(this._prog, 'uInput');
    this._uImage  = gl.getUniformLocation(this._prog, 'uImage');
    this._uBlend  = gl.getUniformLocation(this._prog, 'uBlend');
    this._uAdjust = gl.getUniformLocation(this._prog, 'uAdjust');
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

    const blend  = isBeat ? this.onBeatBlendMode   : this.blendMode;
    const linear = isBeat ? this.onBeatBilinear     : this.bilinear;
    const adjust = isBeat ? this.onBeatAdjustBlend  : this.adjustBlend;

    if (blend === 10) {
      // Ignore: pass input through unchanged (no swap needed)
      gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
      gl.viewport(0, 0, w, h);
      // Blit input to output by treating it as a replace with the input itself.
      // Simplest: just skip drawing; the chain will use the existing buffer.
      // But we still need to output something — re-render input as output.
      // We'll fall through with blend=0 using the input as the image won't execute
      // due to early return above. Actually: Ignore means draw nothing, pass through.
      // Since we don't swap, the next effect reads inputTex unchanged.
      return;
    }

    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);

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
    gl.uniform1f(this._uAdjust, adjust / 255.0);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    fboManager.swap();
  }

  getConfig() {
    return {
      imageData:         this.imageData,
      blendMode:         this.blendMode,
      onBeatBlendMode:   this.onBeatBlendMode,
      bilinear:          this.bilinear,
      onBeatBilinear:    this.onBeatBilinear,
      adjustBlend:       this.adjustBlend,
      onBeatAdjustBlend: this.onBeatAdjustBlend,
    };
  }

  setConfig(cfg) {
    if (cfg.imageData !== undefined && cfg.imageData !== this.imageData) {
      this.imageData = cfg.imageData;
      this._loadImage(this.imageData);
    }
    if (cfg.blendMode         !== undefined) this.blendMode         = cfg.blendMode;
    if (cfg.onBeatBlendMode   !== undefined) this.onBeatBlendMode   = cfg.onBeatBlendMode;
    if (cfg.bilinear          !== undefined) this.bilinear          = cfg.bilinear;
    if (cfg.onBeatBilinear    !== undefined) this.onBeatBilinear    = cfg.onBeatBilinear;
    if (cfg.adjustBlend       !== undefined) this.adjustBlend       = Math.max(0, Math.min(255, cfg.adjustBlend));
    if (cfg.onBeatAdjustBlend !== undefined) this.onBeatAdjustBlend = Math.max(0, Math.min(255, cfg.onBeatAdjustBlend));
  }

  getDescriptor() {
    return {
      name: 'Picture II',
      params: [
        { name: 'imageData',         label: 'Image',                  type: 'image-upload', default: '' },
        { name: 'blendMode',         label: 'Blend Mode',             type: 'select',  options: BLEND_OPTIONS, default: 0 },
        { name: 'adjustBlend',       label: 'Blend Amount',           type: 'range',   min: 0, max: 255, step: 1, default: 128,
          visibleWhen: { param: 'blendMode', value: 7 } },
        { name: 'bilinear',          label: 'Bilinear',               type: 'bool',    default: true },
        { name: 'onBeatBlendMode',   label: 'On-Beat Blend Mode',     type: 'select',  options: BLEND_OPTIONS, default: 0 },
        { name: 'onBeatAdjustBlend', label: 'On-Beat Blend Amount',   type: 'range',   min: 0, max: 255, step: 1, default: 128,
          visibleWhen: { param: 'onBeatBlendMode', value: 7 } },
        { name: 'onBeatBilinear',    label: 'On-Beat Bilinear',       type: 'bool',    default: true },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    if (this._tex) this.gl.deleteTexture(this._tex);
  }
}
