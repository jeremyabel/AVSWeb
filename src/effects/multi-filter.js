import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const EFFECT_OPTIONS = [
  { value: 0, label: 'Chrome'                    },
  { value: 1, label: 'Double Chrome'              },
  { value: 2, label: 'Triple Chrome'              },
  { value: 3, label: 'Infroot + Border Convolution' },
];

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform int uEffect;
uniform vec2 uTexelSize;
out vec4 fragColor;

float chrome(float c) {
  return c < 0.5 ? 2.0 * c : 2.0 * (1.0 - c);
}

void main() {
  vec3 c = texture(uInput, vUv).rgb;

  vec3 result;
  if (uEffect == 0) {
    result = vec3(chrome(c.r), chrome(c.g), chrome(c.b));
  } else if (uEffect == 1) {
    vec3 t = vec3(chrome(c.r), chrome(c.g), chrome(c.b));
    result  = vec3(chrome(t.r), chrome(t.g), chrome(t.b));
  } else if (uEffect == 2) {
    vec3 t  = vec3(chrome(c.r), chrome(c.g), chrome(c.b));
    vec3 t2 = vec3(chrome(t.r), chrome(t.g), chrome(t.b));
    result  = vec3(chrome(t2.r), chrome(t2.g), chrome(t2.b));
  } else {
    // Infroot + Border Convolution:
    // pixel is white if self OR right neighbor OR below neighbor is non-zero
    vec3 self  = c;
    vec3 right = texture(uInput, vUv + vec2( uTexelSize.x, 0.0)).rgb;
    vec3 below = texture(uInput, vUv + vec2(0.0, -uTexelSize.y)).rgb;
    bool hit = any(greaterThan(self,  vec3(0.0)))
            || any(greaterThan(right, vec3(0.0)))
            || any(greaterThan(below, vec3(0.0)));
    result = hit ? vec3(1.0) : vec3(0.0);
  }

  fragColor = vec4(result, 1.0);
}`;

export class MultiFilterEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.effect       = 0;
    this.toggleOnBeat = false;
    this._toggleState = true;

    this._prog      = createProgram(gl, vertSrc, FRAG);
    this._uInput    = gl.getUniformLocation(this._prog, 'uInput');
    this._uEffect   = gl.getUniformLocation(this._prog, 'uEffect');
    this._uTexSize  = gl.getUniformLocation(this._prog, 'uTexelSize');
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;

    if (this.toggleOnBeat && isBeat) {
      this._toggleState = !this._toggleState;
    }

    if (!this._toggleState) return;

    const w = fboManager.w, h = fboManager.h;

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);

    gl.uniform1i(this._uEffect, this.effect);
    gl.uniform2f(this._uTexSize, 1 / w, 1 / h);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return {
      effect:       this.effect,
      toggleOnBeat: this.toggleOnBeat,
    };
  }

  setConfig(cfg) {
    if (cfg.effect       !== undefined) this.effect       = cfg.effect | 0;
    if (cfg.toggleOnBeat !== undefined) this.toggleOnBeat = !!cfg.toggleOnBeat;
  }

  getDescriptor() {
    return {
      name: 'Multi Filter',
      params: [
        { name: 'effect',       label: 'Effect',         type: 'select', options: EFFECT_OPTIONS, default: 0 },
        { name: 'toggleOnBeat', label: 'Toggle On Beat', type: 'bool',                            default: false },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
