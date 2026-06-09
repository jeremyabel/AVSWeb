import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// All 6 RGB permutations, matching original AVS Channel Shift ordering.
const MODE_OPTIONS = [
  { value: 0, label: 'RGB (none)' },
  { value: 1, label: 'RBG'        },
  { value: 2, label: 'GRB'        },
  { value: 3, label: 'GBR'        },
  { value: 4, label: 'BRG'        },
  { value: 5, label: 'BGR'        },
];

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform int uMode;
out vec4 fragColor;
void main() {
  vec3 c = texture(uInput, vUv).rgb;
  vec3 r;
  if      (uMode == 0) r = c.rgb;
  else if (uMode == 1) r = c.rbg;
  else if (uMode == 2) r = c.grb;
  else if (uMode == 3) r = c.gbr;
  else if (uMode == 4) r = c.brg;
  else                 r = c.bgr;
  fragColor = vec4(r, 1.0);
}`;

export class ChannelShiftEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.mode          = 0;
    this.onBeatRandom  = false;
    this._prog   = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uMode  = gl.getUniformLocation(this._prog, 'uMode');
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    if (isBeat && this.onBeatRandom) this.mode = Math.floor(Math.random() * 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1i(this._uMode, this.mode);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() { return { mode: this.mode, onBeatRandom: this.onBeatRandom }; }
  setConfig(cfg) {
    if (cfg.mode         !== undefined) this.mode         = cfg.mode;
    if (cfg.onBeatRandom !== undefined) this.onBeatRandom = cfg.onBeatRandom;
  }

  getDescriptor() {
    return {
      name: 'Channel Shift',
      params: [
        { name: 'mode',         label: 'Channel Order',  type: 'select', options: MODE_OPTIONS, default: 0 },
        { name: 'onBeatRandom', label: 'On Beat Random', type: 'bool',   default: false },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
