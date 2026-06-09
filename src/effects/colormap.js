import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// For each pixel: compute a key (0-255) from the pixel's color, look it up
// in the active colormap (256-entry LUT), then blend the result with the
// original pixel using one of 10 blend modes.
//
// 8 independent maps. If map cycling is enabled, the active map animates
// between current and next over 256 steps (speed = step increment per frame).

const NUM_MAPS = 8;
const LUT_SIZE = 256;

const KEY_OPTIONS = [
  { value: 0, label: 'Red Channel'   },
  { value: 1, label: 'Green Channel' },
  { value: 2, label: 'Blue Channel'  },
  { value: 3, label: '(R+G+B)/2'    },
  { value: 4, label: 'Maximal Channel' },
  { value: 5, label: '(R+G+B)/3'   },
];
const BLEND_OPTIONS = [
  { value: 0, label: 'Replace'       },
  { value: 1, label: 'Additive'      },
  { value: 2, label: 'Maximum'       },
  { value: 3, label: 'Minimum'       },
  { value: 4, label: '50/50'         },
  { value: 5, label: 'Subtractive 1' },
  { value: 6, label: 'Subtractive 2' },
  { value: 7, label: 'Multiply'      },
  { value: 8, label: 'XOR'           },
  { value: 9, label: 'Adjustable'    },
];
const CYCLE_OPTIONS = [
  { value: 0, label: 'None (single map)'  },
  { value: 1, label: 'On-beat random'     },
  { value: 2, label: 'On-beat sequential' },
];

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform sampler2D uLUT;
uniform int uColorKey;
uniform int uBlendmode;
uniform float uAlpha;
out vec4 fragColor;

void main() {
  vec3 orig = texture(uInput, vUv).rgb;
  ivec3 oi  = ivec3(orig * 255.0 + 0.5);

  int key;
  if      (uColorKey == 0) { key = oi.r; }
  else if (uColorKey == 1) { key = oi.g; }
  else if (uColorKey == 2) { key = oi.b; }
  else if (uColorKey == 3) { key = min((oi.r + oi.g + oi.b) / 2, 255); }
  else if (uColorKey == 4) { key = max(max(oi.r, oi.g), oi.b); }
  else                     { key = (oi.r + oi.g + oi.b) / 3; }

  vec3 mapped = texelFetch(uLUT, ivec2(key, 0), 0).rgb;

  vec3 result;
  if      (uBlendmode == 0) { result = mapped; }
  else if (uBlendmode == 1) { result = min(orig + mapped, vec3(1.0)); }
  else if (uBlendmode == 2) { result = max(orig, mapped); }
  else if (uBlendmode == 3) { result = min(orig, mapped); }
  else if (uBlendmode == 4) { result = (orig + mapped) * 0.5; }
  else if (uBlendmode == 5) { result = max(orig - mapped, vec3(0.0)); }
  else if (uBlendmode == 6) { result = max(mapped - orig, vec3(0.0)); }
  else if (uBlendmode == 7) { result = orig * mapped; }
  else if (uBlendmode == 8) {
    ivec3 a = ivec3(orig   * 255.0 + 0.5);
    ivec3 b = ivec3(mapped * 255.0 + 0.5);
    result = vec3(a ^ b) / 255.0;
  } else {
    result = mix(orig, mapped, uAlpha);
  }

  fragColor = vec4(result, 1.0);
}`;

function makeMap() {
  return {
    enabled: false,
    colors:  [{ position: 0, color: [0,0,0] }, { position: 255, color: [255,255,255] }],
    baked:   new Uint8Array(LUT_SIZE * 4),
  };
}

export class ColormapEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.colorKey          = 0;
    this.blendmode         = 0;
    this.adjustableAlpha   = 0;
    this.mapCycleMode      = 0;
    this.mapCycleSpeed     = 11;
    this.dontSkipFastBeats = false;
    this.currentMap        = 0;
    this.nextMap           = 0;

    this.maps = Array.from({ length: NUM_MAPS }, makeMap);
    this.maps[0].enabled = true;

    this._changeStep = LUT_SIZE; // fully transitioned
    this._tweenBuf   = new Uint8Array(LUT_SIZE * 4);

    this.bakeAll();

    // GL resources
    this._prog      = createProgram(gl, vertSrc, FRAG);
    this._uInput    = gl.getUniformLocation(this._prog, 'uInput');
    this._uLUT      = gl.getUniformLocation(this._prog, 'uLUT');
    this._uColorKey = gl.getUniformLocation(this._prog, 'uColorKey');
    this._uBlend    = gl.getUniformLocation(this._prog, 'uBlendmode');
    this._uAlpha    = gl.getUniformLocation(this._prog, 'uAlpha');

    this._lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, LUT_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // ── Map baking ─────────────────────────────────────────────────────────────

  bakeMap(idx) {
    const map = this.maps[idx];
    const lut = map.baked;
    const sorted = [...map.colors].sort((a, b) => a.position - b.position || (a.color[0]+a.color[1]+a.color[2]) - (b.color[0]+b.color[1]+b.color[2]));

    if (sorted.length === 0) return;

    const first = sorted[0];
    for (let i = 0; i < first.position; i++) {
      lut[i*4]   = first.color[0];
      lut[i*4+1] = first.color[1];
      lut[i*4+2] = first.color[2];
      lut[i*4+3] = 255;
    }

    for (let ci = 0; ci < sorted.length - 1; ci++) {
      const from = sorted[ci], to = sorted[ci + 1];
      const span = to.position - from.position;
      for (let i = from.position; i < to.position; i++) {
        const t = span > 0 ? (i - from.position) / span : 0;
        lut[i*4]   = (from.color[0] + (to.color[0] - from.color[0]) * t) | 0;
        lut[i*4+1] = (from.color[1] + (to.color[1] - from.color[1]) * t) | 0;
        lut[i*4+2] = (from.color[2] + (to.color[2] - from.color[2]) * t) | 0;
        lut[i*4+3] = 255;
      }
    }

    const last = sorted[sorted.length - 1];
    for (let i = last.position; i < LUT_SIZE; i++) {
      lut[i*4]   = last.color[0];
      lut[i*4+1] = last.color[1];
      lut[i*4+2] = last.color[2];
      lut[i*4+3] = 255;
    }
  }

  bakeAll() {
    for (let i = 0; i < NUM_MAPS; i++) this.bakeMap(i);
  }

  flipMap(idx) {
    const map = this.maps[idx];
    map.colors = map.colors.map(c => ({ ...c, position: 255 - c.position })).reverse();
    this.bakeMap(idx);
  }

  clearMap(idx) {
    this.maps[idx].colors = [
      { position: 0,   color: [0,   0,   0  ] },
      { position: 255, color: [255, 255, 255] },
    ];
    this.bakeMap(idx);
  }

  // ── CLM file save / load ────────────────────────────────────────────────────

  saveMap(idx) {
    const colors = this.maps[idx].colors.slice(0, 256);
    const buf  = new ArrayBuffer(4 + 4 + colors.length * 12);
    const view = new DataView(buf);
    view.setUint8(0, 0x43); view.setUint8(1, 0x4C); // "CL"
    view.setUint8(2, 0x4D); view.setUint8(3, 0x31); // "M1"
    view.setUint32(4, colors.length, true);
    let off = 8;
    for (const { position, color: [r, g, b] } of colors) {
      const packed = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
      view.setUint32(off, position, true); off += 4;
      view.setUint32(off, packed,   true); off += 4;
      view.setUint32(off, 0,        true); off += 4; // color_id — ignored on load
    }
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `map${idx + 1}.clm` });
    a.click();
    URL.revokeObjectURL(url);
  }

  loadMap(idx, onLoad) {
    const input = Object.assign(document.createElement('input'),
      { type: 'file', accept: '.clm', style: 'display:none' });
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files[0];
      document.body.removeChild(input);
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const buf  = e.target.result;
        const view = new DataView(buf);
        if (buf.byteLength < 8) return;
        const magic = String.fromCharCode(
          view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        if (magic !== 'CLM1') return;
        const COLOR_SIZE = 12; // 3 × uint32
        const MAX_COLORS = 256;
        let length = view.getUint32(4, true);
        const available = Math.floor((buf.byteLength - 8) / COLOR_SIZE);
        if (length > MAX_COLORS || length !== available) length = Math.min(available, MAX_COLORS);
        const colors = [];
        let off = 8;
        for (let i = 0; i < length; i++) {
          if (off + COLOR_SIZE > buf.byteLength) break;
          const position = view.getUint32(off, true); off += 4;
          const packed   = view.getUint32(off, true); off += 4;
          off += 4; // skip color_id
          colors.push({
            position: Math.max(0, Math.min(255, position)),
            color: [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff],
          });
        }
        if (colors.length === 0) return;
        this.maps[idx].colors = colors;
        this.bakeMap(idx);
        onLoad();
      };
      reader.readAsArrayBuffer(file);
    });
    input.click();
  }

  // ── Animation / LUT selection ───────────────────────────────────────────────

  _anyEnabled() {
    return this.maps.some(m => m.enabled);
  }

  _advanceNextMap() {
    if (!this._anyEnabled()) return;
    const start = this.nextMap;
    do {
      if (this.mapCycleMode === 1) {
        this.nextMap = Math.floor(Math.random() * NUM_MAPS);
      } else {
        this.nextMap = (this.nextMap + 1) % NUM_MAPS;
      }
    } while (!this.maps[this.nextMap].enabled && this.nextMap !== start);
  }

  _getLUT(isBeat) {
    if (this.mapCycleMode === 0) {
      this._changeStep = 0;
      return this.maps[this.currentMap].baked;
    }

    this._changeStep = Math.min(this._changeStep + this.mapCycleSpeed, LUT_SIZE);

    if (isBeat && (!this.dontSkipFastBeats || this._changeStep === LUT_SIZE)) {
      this._advanceNextMap();
      this._changeStep = 0;
    }

    if (this._changeStep === 0) {
      return this.maps[this.currentMap].baked;
    }
    if (this._changeStep >= LUT_SIZE) {
      this.currentMap = this.nextMap;
      return this.maps[this.currentMap].baked;
    }

    if (this.currentMap === this.nextMap) {
      return this.maps[this.currentMap].baked;
    }

    // Tween between current and next
    const t   = this._changeStep / LUT_SIZE;
    const cur = this.maps[this.currentMap].baked;
    const nxt = this.maps[this.nextMap].baked;
    const buf = this._tweenBuf;
    for (let i = 0; i < LUT_SIZE; i++) {
      const k = i * 4;
      buf[k]   = (cur[k]   + (nxt[k]   - cur[k])   * t) | 0;
      buf[k+1] = (cur[k+1] + (nxt[k+1] - cur[k+1]) * t) | 0;
      buf[k+2] = (cur[k+2] + (nxt[k+2] - cur[k+2]) * t) | 0;
      buf[k+3] = 255;
    }
    return buf;
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    const lut = this._getLUT(isBeat);

    gl.bindTexture(gl.TEXTURE_2D, this._lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(this._uInput, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._lutTex);
    gl.uniform1i(this._uLUT, 1);

    gl.uniform1i(this._uColorKey, this.colorKey);
    gl.uniform1i(this._uBlend,    this.blendmode);
    gl.uniform1f(this._uAlpha,    this.adjustableAlpha / 255);

    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    fboManager.swap();
  }

  // ── Config ──────────────────────────────────────────────────────────────────

  getConfig() {
    return {
      colorKey:          this.colorKey,
      blendmode:         this.blendmode,
      adjustableAlpha:   this.adjustableAlpha,
      mapCycleMode:      this.mapCycleMode,
      mapCycleSpeed:     this.mapCycleSpeed,
      dontSkipFastBeats: this.dontSkipFastBeats,
      currentMap:        this.currentMap,
      maps: this.maps.map(m => ({
        enabled: m.enabled,
        colors:  m.colors.map(c => ({ position: c.position, color: [...c.color] })),
      })),
    };
  }

  setConfig(cfg) {
    if (cfg.colorKey          !== undefined) this.colorKey          = cfg.colorKey;
    if (cfg.blendmode         !== undefined) this.blendmode         = cfg.blendmode;
    if (cfg.adjustableAlpha   !== undefined) this.adjustableAlpha   = cfg.adjustableAlpha;
    if (cfg.mapCycleMode      !== undefined) this.mapCycleMode      = cfg.mapCycleMode;
    if (cfg.mapCycleSpeed     !== undefined) this.mapCycleSpeed     = cfg.mapCycleSpeed;
    if (cfg.dontSkipFastBeats !== undefined) this.dontSkipFastBeats = cfg.dontSkipFastBeats;
    if (cfg.currentMap        !== undefined) this.currentMap        = cfg.currentMap;
    if (cfg.maps) {
      cfg.maps.forEach((m, i) => {
        if (!this.maps[i]) return;
        this.maps[i].enabled = !!m.enabled;
        if (m.colors) {
          this.maps[i].colors = m.colors.map(c => ({
            position: Math.max(0, Math.min(255, c.position | 0)),
            color:    (c.color || [0,0,0]).map(v => Math.max(0, Math.min(255, v | 0))),
          }));
        }
        this.bakeMap(i);
      });
    }
    if (this.nextMap === undefined) this.nextMap = this.currentMap;
  }

  getDescriptor() {
    return {
      name: 'Color Map',
      params: [
        { name: 'maps',            label: '',             type: 'colormap-editor' },
        { name: 'colorKey',        label: 'Key',          type: 'select', options: KEY_OPTIONS,   default: 0 },
        { name: 'blendmode',       label: 'Blend Mode',   type: 'select', options: BLEND_OPTIONS, default: 0 },
        { name: 'adjustableAlpha', label: 'Alpha',        type: 'range',  min: 0, max: 255, step: 1, default: 0 },
        { name: 'mapCycleMode',    label: 'Cycling',      type: 'select', options: CYCLE_OPTIONS, default: 0 },
        { name: 'mapCycleSpeed',   label: 'Cycle Speed',  type: 'range',  min: 1, max: 64, step: 1, default: 11 },
        { name: 'dontSkipFastBeats', label: "Don't Skip Fast Beats", type: 'bool', default: false },
      ],
    };
  }

  destroy() {
    this.gl.deleteProgram(this._prog);
    this.gl.deleteTexture(this._lutTex);
  }
}
