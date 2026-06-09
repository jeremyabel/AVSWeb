import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// Quadrant classification: which RGB channel dominates determines which
// mix of fs1/fs2/fs3 is added to each channel.
//
//   quad 0 (green): R+=fs3  G+=fs2  B+=fs1
//   quad 1 (red):   R+=fs2  G+=fs1  B+=fs3
//   quad 2 (blue):  R+=fs1  G+=fs3  B+=fs2
//   quad 3 (neut):  R+=fs3  G+=fs3  B+=fs3
//
// fs1=faderpos[0], fs2=faderpos[1], fs3=faderpos[2] (units: integer -32..32)

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform float uFs1;
uniform float uFs2;
uniform float uFs3;
out vec4 fragColor;
void main() {
  vec3 c = texture(uInput, vUv).rgb;
  float R = c.r * 255.0;
  float G = c.g * 255.0;
  float B = c.b * 255.0;
  float gMinusB = G - B;
  float bMinusR = B - R;

  float dR, dG, dB;
  if (gMinusB > 0.0 && gMinusB > -bMinusR) {
    dR = uFs3; dG = uFs2; dB = uFs1;        // green dominant
  } else if (bMinusR < 0.0 && gMinusB < -bMinusR) {
    dR = uFs2; dG = uFs1; dB = uFs3;        // red dominant
  } else if (gMinusB < 0.0 && bMinusR > 0.0) {
    dR = uFs1; dG = uFs3; dB = uFs2;        // blue dominant
  } else {
    dR = uFs3; dG = uFs3; dB = uFs3;        // neutral
  }

  fragColor = vec4(clamp(c + vec3(dR, dG, dB) / 255.0, 0.0, 1.0), 1.0);
}`;

export class ColorfadeEffect extends Effect {
  constructor(gl) {
    super(gl);
    // Per-frame target fader values (-32..32).
    this.faders     = [8, -8, -8];
    this.beatFaders = [8, -8, -8];
    this.gradual    = false;
    this.randomBeat = false;
    // Runtime interpolated positions (not serialised).
    this._fp = [8, -8, -8];

    this._prog = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
    this._uFs1   = gl.getUniformLocation(this._prog, 'uFs1');
    this._uFs2   = gl.getUniformLocation(this._prog, 'uFs2');
    this._uFs3   = gl.getUniformLocation(this._prog, 'uFs3');
  }

  _updateFaderPos(isBeat) {
    const fp = this._fp;
    const f  = this.faders;
    const bf = this.beatFaders;

    // Step 1: always advance interpolation by ±1 toward targets.
    // Note: in the original, faderpos[1] tracks faders[2] and vice-versa
    // (faithful reproduction of the original quirk).
    if (fp[0] < f[0]) fp[0]++; else if (fp[0] > f[0]) fp[0]--;
    if (fp[1] < f[2]) fp[1]++; else if (fp[1] > f[2]) fp[1]--;
    if (fp[2] < f[1]) fp[2]++; else if (fp[2] > f[1]) fp[2]--;

    // Step 2: override based on mode.
    if (!this.gradual) {
      // Snap directly — note: no swap here (direct assignment).
      fp[0] = f[0]; fp[1] = f[1]; fp[2] = f[2];
    } else if (isBeat && this.randomBeat) {
      fp[0] = Math.floor(Math.random() * 32) - 6;
      fp[1] = Math.floor(Math.random() * 64) - 32;
      if (fp[1] < 0  && fp[1] > -16) fp[1] = -32;
      if (fp[1] >= 0 && fp[1] <  16) fp[1] =  32;
      fp[2] = Math.floor(Math.random() * 32) - 6;
    } else if (isBeat) {
      fp[0] = bf[0]; fp[1] = bf[1]; fp[2] = bf[2];
    }
    // else gradual + no beat: keep interpolated values.
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;

    this._updateFaderPos(isBeat);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);
    gl.uniform1f(this._uFs1, this._fp[0]);
    gl.uniform1f(this._uFs2, this._fp[1]);
    gl.uniform1f(this._uFs3, this._fp[2]);
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  getConfig() {
    return {
      fader0: this.faders[0], fader1: this.faders[1], fader2: this.faders[2],
      beatFader0: this.beatFaders[0], beatFader1: this.beatFaders[1], beatFader2: this.beatFaders[2],
      gradual:    this.gradual,
      randomBeat: this.randomBeat,
    };
  }

  setConfig(cfg) {
    if (cfg.fader0     !== undefined) this.faders[0]     = cfg.fader0;
    if (cfg.fader1     !== undefined) this.faders[1]     = cfg.fader1;
    if (cfg.fader2     !== undefined) this.faders[2]     = cfg.fader2;
    if (cfg.beatFader0 !== undefined) this.beatFaders[0] = cfg.beatFader0;
    if (cfg.beatFader1 !== undefined) this.beatFaders[1] = cfg.beatFader1;
    if (cfg.beatFader2 !== undefined) this.beatFaders[2] = cfg.beatFader2;
    if (cfg.gradual    !== undefined) this.gradual    = cfg.gradual;
    if (cfg.randomBeat !== undefined) this.randomBeat = cfg.randomBeat;
  }

  getDescriptor() {
    return {
      name: 'Colorfade',
      params: [
        { name: 'gradual',    label: 'OnBeat Change',  type: 'bool',  default: false },
        { name: 'randomBeat', label: 'Random on Beat', type: 'bool',  default: false },
        { name: 'fader0',     label: 'Fader 1',        type: 'range', min: -32, max: 32, step: 1, default:  8 },
        { name: 'fader1',     label: 'Fader 2',        type: 'range', min: -32, max: 32, step: 1, default: -8 },
        { name: 'fader2',     label: 'Fader 3',        type: 'range', min: -32, max: 32, step: 1, default: -8 },
        { name: 'beatFader0', label: 'Beat Fader 1',   type: 'range', min: -32, max: 32, step: 1, default:  8 },
        { name: 'beatFader1', label: 'Beat Fader 2',   type: 'range', min: -32, max: 32, step: 1, default: -8 },
        { name: 'beatFader2', label: 'Beat Fader 3',   type: 'range', min: -32, max: 32, step: 1, default: -8 },
      ],
    };
  }

  destroy() { this.gl.deleteProgram(this._prog); }
}
