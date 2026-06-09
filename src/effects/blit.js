import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform float uZoom;
uniform float uRotation;
uniform vec2 uCenter;
out vec4 fragColor;
void main() {
  vec2 uv = vUv - uCenter;
  float c = cos(uRotation), s = sin(uRotation);
  uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) / uZoom + uCenter;
  fragColor = (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)
    ? vec4(0.0, 0.0, 0.0, 1.0)
    : texture(uInput, uv);
}
`;

export class BlitEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.zoom     = 1.05;   // > 1 = zoom in (classic inward tunnel)
    this.rotation = 0.0;    // radians per frame
    this.centerX  = 0.5;
    this.centerY  = 0.5;
    this._prog    = createProgram(gl, vertSrc, FRAG);
    this._uInput    = gl.getUniformLocation(this._prog, 'uInput');
    this._uZoom     = gl.getUniformLocation(this._prog, 'uZoom');
    this._uRotation = gl.getUniformLocation(this._prog, 'uRotation');
    this._uCenter   = gl.getUniformLocation(this._prog, 'uCenter');
    this._angle = 0;
  }

  render(ctx) {
    const { gl, fboManager, inputTex, outputFBO } = ctx;
    this._angle += this.rotation;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1f(this._uZoom, this.zoom);
    gl.uniform1f(this._uRotation, this._angle);
    gl.uniform2f(this._uCenter, this.centerX, this.centerY);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return { zoom: this.zoom, rotation: this.rotation, centerX: this.centerX, centerY: this.centerY };
  }
  setConfig(cfg) {
    if (cfg.zoom     !== undefined) this.zoom     = cfg.zoom;
    if (cfg.rotation !== undefined) this.rotation = cfg.rotation;
    if (cfg.centerX  !== undefined) this.centerX  = cfg.centerX;
    if (cfg.centerY  !== undefined) this.centerY  = cfg.centerY;
  }

  getDescriptor() {
    return {
      name: 'Blit',
      params: [
        { name: 'zoom',     label: 'Zoom',     type: 'range', min: 0.8, max: 1.5, step: 0.005, default: 1.05 },
        { name: 'rotation', label: 'Rotation', type: 'range', min: -0.1, max: 0.1, step: 0.001, default: 0 },
        { name: 'centerX',  label: 'Center X', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
        { name: 'centerY',  label: 'Center Y', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
