import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Mode constants matching the original:
// 0=Inv  1=×8  2=×4  3=×2(default)  4=×½  5=×¼  6=×⅛  7=XS

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform int uMode;
out vec4 fragColor;

void main() {
  vec3 c = texture(uInput, vUv).rgb;

  if (uMode == 0) {
    // Inv: any non-black pixel → white; black stays black
    c = (dot(c, vec3(1.0)) > 0.0) ? vec3(1.0) : vec3(0.0);

  } else if (uMode == 1) {
    // ×8: three saturating doubles (paddusb x3)
    c = min(c * 8.0, 1.0);

  } else if (uMode == 2) {
    // ×4: two saturating doubles
    c = min(c * 4.0, 1.0);

  } else if (uMode == 3) {
    // ×2: one saturating double (default)
    c = min(c * 2.0, 1.0);

  } else if (uMode == 4) {
    // ×½: integer right-shift 1 (psrlq>>1, pand 0x7F) — floor division
    c = floor(c * 255.0 / 2.0) / 255.0;

  } else if (uMode == 5) {
    // ×¼: integer right-shift 2 (psrlq>>2, pand 0x3F)
    c = floor(c * 255.0 / 4.0) / 255.0;

  } else if (uMode == 6) {
    // ×⅛: integer right-shift 3 (psrlq>>3, pand 0x1F)
    c = floor(c * 255.0 / 8.0) / 255.0;

  } else {
    // XS: only exact white survives; everything else → black
    c = (c.r > (254.5 / 255.0) && c.g > (254.5 / 255.0) && c.b > (254.5 / 255.0))
        ? vec3(1.0) : vec3(0.0);
  }

  fragColor = vec4(c, 1.0);
}`;

const MODE_OPTIONS = [
  { value: 0, label: 'Inv (non-black → white)' },
  { value: 1, label: '×8'                       },
  { value: 2, label: '×4'                       },
  { value: 3, label: '×2'                       },
  { value: 4, label: '×½'                       },
  { value: 5, label: '×¼'                       },
  { value: 6, label: '×⅛'                       },
  { value: 7, label: 'XS (white only)'          },
];

export class MultiplierEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.mode = 3; // MD_X2 default

    this._prog   = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uMode  = gl.getUniformLocation(this._prog, 'uMode');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1i(this._uMode,  this.mode);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig()    { return { mode: this.mode }; }
  setConfig(cfg) { if (cfg.mode !== undefined) this.mode = cfg.mode; }

  getDescriptor() {
    return {
      name: 'Multiplier',
      params: [
        { name: 'mode', label: 'Mode', type: 'select', options: MODE_OPTIONS, default: 3 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
