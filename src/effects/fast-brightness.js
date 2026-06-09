import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// dir=0: saturating ×2  (paddusb with itself)
// dir=1: ×½             (right-shift + 0x7F mask)
// dir=2: pass-through   (third radio button in original; render() returns 0 with no op)

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform int uDir;
out vec4 fragColor;

void main() {
  vec3 c = texture(uInput, vUv).rgb;
  if      (uDir == 0) c = min(c * 2.0, 1.0);
  else if (uDir == 1) c = c * 0.5;
  // dir == 2: no change
  fragColor = vec4(c, 1.0);
}`;

const DIR_OPTIONS = [
  { value: 0, label: '×2 Brighter' },
  { value: 1, label: '×½ Darker'   },
  { value: 2, label: 'No Change'   },
];

export class FastBrightnessEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.dir = 0;

    this._prog  = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uDir   = gl.getUniformLocation(this._prog, 'uDir');
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1i(this._uDir,   this.dir);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig()      { return { dir: this.dir }; }
  setConfig(cfg)   { if (cfg.dir !== undefined) this.dir = cfg.dir; }

  getDescriptor() {
    return {
      name: 'Fast Brightness',
      params: [
        { name: 'dir', label: 'Mode', type: 'select', options: DIR_OPTIONS, default: 0 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
