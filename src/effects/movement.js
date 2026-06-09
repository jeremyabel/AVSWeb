import { Effect, createProgram, getQuadVAO, getEmptyVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

const POLAR_DEFAULT_STUB = `// Polar coordinates: modify d and/or r
//   d — distance from center (0=center, ~1=corner)
//   r — angle in radians (0=top, π/2=right, π=bottom, 3π/2=left)
//   t — time in seconds
r = r + (0.1 - 0.2 * d);
d = d * 0.96;`;

const CARTESIAN_DEFAULT_STUB = `// Cartesian coordinates: modify x and/or y
//   x — horizontal (-1=left, +1=right)
//   y — vertical   (-1=top,  +1=bottom)
//   d, r — also available (polar equivalents)
//   t — time in seconds
x = x * 0.98;
y = y * 0.98;`;

// Both modes set up x, y, d, r, t identically.
// Only the UV-reconstruction after the stub differs.
function buildFragSrc(stub, isPolar) {
  const outputUV = isPolar
    // sin(r) → x axis, cos(r) → y axis (y-down), factor sqrt(2)/2 unnormalises d back to UV
    ? `  vec2 uv = vec2(0.5 + sin(r) * d * 0.70710678118, 0.5 + cos(r) * d * 0.70710678118);`
    : `  vec2 uv = vec2((x + 1.0) * 0.5, (1.0 - y) * 0.5);`;

  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform float uTime;
uniform bool uWrap;
uniform bool uBlend5050;
out vec4 fragColor;
void main() {
  const float PI = 3.14159265358979;
  // x, y in (-1..1); y = +1 at bottom, matching the original's y-down pixel convention
  float x = vUv.x * 2.0 - 1.0;
  float y = -(vUv.y * 2.0 - 1.0);
  // d normalised so corners ≈ 1.0 (divides pixel distance by sqrt(w²+h²)/2; approximated as /sqrt(2) in UV space)
  float d = length(vec2(x, y)) * 0.70710678118;
  // r: 0 = top, π/2 = right, π = bottom, 3π/2 = left (clockwise)
  float r = atan(y, x) + PI * 0.5;
  float t = uTime;

  ${stub}

${outputUV}
  if (uWrap) uv = fract(uv); else uv = clamp(uv, 0.0, 1.0);
  vec4 sampled = texture(uInput, uv);
  fragColor = uBlend5050 ? mix(texture(uInput, vUv), sampled, 0.5) : sampled;
}`;
}

// Vertex shader for source map (push/scatter) mode.
// Each gl_VertexID is one source pixel. The stub computes where that pixel is
// pushed to in the output; gl_Position is set to the destination clip-space pos.
// The fragment shader then samples the input at vSourceUV (the source position).
function buildScatterVertSrc(stub, isPolar) {
  const outputUV = isPolar
    ? `  vec2 uv = vec2(0.5 + sin(r) * d * 0.70710678118, 0.5 + cos(r) * d * 0.70710678118);`
    : `  vec2 uv = vec2((x + 1.0) * 0.5, (1.0 - y) * 0.5);`;

  return `#version 300 es
precision highp float;
uniform int uWidth;
uniform int uHeight;
uniform float uTime;
uniform bool uWrap;
out vec2 vSourceUV;
void main() {
  const float PI = 3.14159265358979;
  int ix = gl_VertexID % uWidth;
  int iy = gl_VertexID / uWidth;
  // GL texture row 0 = bottom of screen; iy=0 → y=+1 (y-down convention matches pull shader)
  vSourceUV = vec2((float(ix) + 0.5) / float(uWidth), (float(iy) + 0.5) / float(uHeight));
  float x = vSourceUV.x * 2.0 - 1.0;
  float y = -(vSourceUV.y * 2.0 - 1.0);
  float d = length(vec2(x, y)) * 0.70710678118;
  float r = atan(y, x) + PI * 0.5;
  float t = uTime;

  ${stub}

${outputUV}
  if (uWrap) uv = fract(uv); else uv = clamp(uv, 0.0, 1.0);
  gl_Position = vec4(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;
}

const SCATTER_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vSourceUV;
uniform sampler2D uInput;
out vec4 fragColor;
void main() {
  fragColor = texture(uInput, vSourceUV);
}`;

// Fixed 50/50 mix of two textures — used for source map + 5050 blend mode.
const MIX_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uA;
uniform sampler2D uB;
out vec4 fragColor;
void main() {
  fragColor = mix(texture(uA, vUv), texture(uB, vUv), 0.5);
}`;

export class MovementEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.coordinates  = 'polar';
    this.stub         = POLAR_DEFAULT_STUB;
    this.wrap         = false;
    this.bilinear     = true;
    this.blend        = false;
    this.sourceMap    = false;
    this.onBeatToggle = false;
    this._compileError = '';
    this._prog         = null;
    this._locs         = {};
    this._scatterProg  = null;
    this._scatterLocs  = {};
    this._mixProg      = null;
    this._mixLocs      = {};
    this._compile();
    try {
      this._mixProg = createProgram(gl, vertSrc, MIX_FRAG_SRC);
      this._mixLocs = {
        uA: gl.getUniformLocation(this._mixProg, 'uA'),
        uB: gl.getUniformLocation(this._mixProg, 'uB'),
      };
    } catch (_) {}
  }

  _compile() {
    const gl = this.gl;
    const isPolar = this.coordinates === 'polar';

    // Pull-based fullscreen-quad shader (normal mode)
    try {
      const next = createProgram(gl, vertSrc, buildFragSrc(this.stub, isPolar));
      if (this._prog) gl.deleteProgram(this._prog);
      this._prog = next;
      this._locs = {
        uInput:     gl.getUniformLocation(this._prog, 'uInput'),
        uTime:      gl.getUniformLocation(this._prog, 'uTime'),
        uWrap:      gl.getUniformLocation(this._prog, 'uWrap'),
        uBlend5050: gl.getUniformLocation(this._prog, 'uBlend5050'),
      };
      this._compileError = '';
    } catch (e) {
      this._compileError = e.message;
    }

    // Push-based (scatter) shader for source map mode
    try {
      const next = createProgram(gl, buildScatterVertSrc(this.stub, isPolar), SCATTER_FRAG_SRC);
      if (this._scatterProg) gl.deleteProgram(this._scatterProg);
      this._scatterProg = next;
      this._scatterLocs = {
        uInput:  gl.getUniformLocation(this._scatterProg, 'uInput'),
        uWidth:  gl.getUniformLocation(this._scatterProg, 'uWidth'),
        uHeight: gl.getUniformLocation(this._scatterProg, 'uHeight'),
        uTime:   gl.getUniformLocation(this._scatterProg, 'uTime'),
        uWrap:   gl.getUniformLocation(this._scatterProg, 'uWrap'),
      };
    } catch (e) {
      if (!this._compileError) this._compileError = e.message;
    }
  }

  // Called by config-panels.js glsl textarea handler
  setStub(src) {
    this.stub = src;
    this._compile();
  }

  getCompileError() { return this._compileError; }

  render(ctx) {
    if (this.onBeatToggle && ctx.isBeat) {
      this.sourceMap = !this.sourceMap;
    }

    if (this.sourceMap && this._scatterProg) {
      this._renderScatter(ctx);
    } else {
      this._renderPull(ctx);
    }
  }

  _renderPull(ctx) {
    if (!this._prog) return;
    const { gl, fboManager, inputTex, outputFBO, time } = ctx;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    const filter = this.bilinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, fboManager.w, fboManager.h);
    gl.useProgram(this._prog);
    gl.uniform1i(this._locs.uInput, 0);
    gl.uniform1f(this._locs.uTime, time);
    gl.uniform1i(this._locs.uWrap, this.wrap ? 1 : 0);
    gl.uniform1i(this._locs.uBlend5050, this.blend ? 1 : 0);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  _renderScatter(ctx) {
    const { gl, fboManager, inputTex, outputFBO, time } = ctx;
    const { w, h } = fboManager;
    const use5050 = this.blend && this._mixProg;

    // For 5050: scatter into scratch(0), then mix 50/50 with inputTex → outputFBO.
    // For replace: scatter directly into outputFBO (already cleared by the chain).
    let scatterFBO = outputFBO;
    let scatterTex = null;
    if (use5050) {
      const scratch = fboManager.getScratch(0);
      scatterFBO = scratch.fbo;
      scatterTex = scratch.texture;
      // Initialize scratch to a copy of inputTex (not black). Unscattered pixels then
      // remain as inputTex after the MAX scatter pass, so the final 50/50 mix produces
      // (inputTex + inputTex)/2 = inputTex for those pixels — matching the original's
      // memcpy(fbout, framebuffer) before scatter.
      gl.bindFramebuffer(gl.FRAMEBUFFER, scatterFBO);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this._mixProg);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, inputTex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, inputTex);
      gl.uniform1i(this._mixLocs.uA, 0);
      gl.uniform1i(this._mixLocs.uB, 1);
      const initVao = getQuadVAO(gl);
      gl.bindVertexArray(initVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, scatterFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._scatterProg);
    gl.uniform1i(this._scatterLocs.uInput, 0);
    gl.uniform1i(this._scatterLocs.uWidth, w);
    gl.uniform1i(this._scatterLocs.uHeight, h);
    gl.uniform1f(this._scatterLocs.uTime, time);
    gl.uniform1i(this._scatterLocs.uWrap, this.wrap ? 1 : 0);

    // MAX blending: overlapping scattered pixels keep the brightest channel values,
    // matching the original's blend_maximum_1px scatter behaviour.
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);

    const emptyVao = getEmptyVAO(gl);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.POINTS, 0, w * h);
    gl.bindVertexArray(null);

    gl.disable(gl.BLEND);

    if (use5050) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this._mixProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, scatterTex);
      gl.uniform1i(this._mixLocs.uA, 0);
      gl.uniform1i(this._mixLocs.uB, 1);
      const vao = getQuadVAO(gl);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    }

    fboManager.swap();
  }

  getConfig() {
    return {
      coordinates:  this.coordinates,
      stub:         this.stub,
      wrap:         this.wrap,
      bilinear:     this.bilinear,
      blend:        this.blend,
      sourceMap:    this.sourceMap,
      onBeatToggle: this.onBeatToggle,
    };
  }

  setConfig(cfg) {
    let needsRecompile = false;

    if (cfg.coordinates !== undefined && cfg.coordinates !== this.coordinates) {
      this.coordinates = cfg.coordinates;
      // If still on a default stub, swap it to the new mode's default
      if (this.stub === POLAR_DEFAULT_STUB || this.stub === CARTESIAN_DEFAULT_STUB) {
        this.stub = this.coordinates === 'polar' ? POLAR_DEFAULT_STUB : CARTESIAN_DEFAULT_STUB;
      }
      needsRecompile = true;
    }
    if (cfg.stub !== undefined && cfg.stub !== this.stub) {
      this.stub = cfg.stub;
      needsRecompile = true;
    }
    if (cfg.wrap         !== undefined) this.wrap         = cfg.wrap;
    if (cfg.bilinear     !== undefined) this.bilinear     = cfg.bilinear;
    if (cfg.blend        !== undefined) this.blend        = cfg.blend;
    if (cfg.sourceMap    !== undefined) this.sourceMap    = cfg.sourceMap;
    if (cfg.onBeatToggle !== undefined) this.onBeatToggle = cfg.onBeatToggle;

    if (needsRecompile) this._compile();
  }

  getDescriptor() {
    return {
      name: 'Movement',
      params: [
        {
          name: 'coordinates',
          label: 'Coordinates',
          type: 'select',
          options: [
            { value: 'polar',     label: 'Polar' },
            { value: 'cartesian', label: 'Cartesian' },
          ],
          default: 'polar',
        },
        {
          name: 'stub',
          label: 'GLSL Code',
          type: 'glsl',
          default: this.coordinates === 'polar' ? POLAR_DEFAULT_STUB : CARTESIAN_DEFAULT_STUB,
        },
        {
          name: 'bilinear',
          label: 'Bilinear',
          type: 'bool',
          default: true,
        },
        {
          name: 'wrap',
          label: 'Wrap',
          type: 'bool',
          default: false,
        },
        { name: 'blend', label: 'Blend', type: 'bool', default: false },
        {
          name: 'sourceMap',
          label: 'Source Map',
          type: 'bool',
          default: false,
        },
        {
          name: 'onBeatToggle',
          label: 'On-Beat Toggle',
          type: 'bool',
          default: false,
        },
      ],
    };
  }

  destroy() {
    const gl = this.gl;
    if (this._prog)        gl.deleteProgram(this._prog);
    if (this._scatterProg) gl.deleteProgram(this._scatterProg);
    if (this._mixProg)     gl.deleteProgram(this._mixProg);
  }
}
