const BINS = 576;

// JS implementations of getspec / getosc matching C++ avs_eelif.cpp getvis().
// Parameters:
//   band   — normalized bin position 0..1
//   bandw  — normalized width 0..1 (number of bins to average)
//   chan   — 0=center(L+R avg), 1=left, 2=right
// Returns:
//   getspec → [0, 1]    getosc → [-1, 1]

function _getvis_spec(visdata, band, bandw, chan) {
  const ch = Math.round(chan);
  if (ch < 0 || ch > 2) return 0;
  let bc = (band * BINS) | 0;
  let bw = Math.max(1, (bandw * BINS) | 0);
  bc -= (bw / 2) | 0;
  if (bc < 0)          { bw += bc; bc = 0; }
  if (bc > BINS - 1)     bc = BINS - 1;
  if (bc + bw > BINS)    bw = BINS - bc;
  const spec = visdata[0];
  let accum = 0;
  if (ch === 0) {
    for (let i = 0; i < bw; i++) accum += spec[0][bc + i] + spec[1][bc + i];
    return accum / (bw * 255.0) * 0.5;
  }
  const chData = spec[ch - 1];
  for (let i = 0; i < bw; i++) accum += chData[bc + i];
  return accum / (bw * 127.5) * 0.5;
}

function _getvis_osc(visdata, band, bandw, chan) {
  const ch = Math.round(chan);
  if (ch < 0 || ch > 2) return 0;
  let bc = (band * BINS) | 0;
  let bw = Math.max(1, (bandw * BINS) | 0);
  bc -= (bw / 2) | 0;
  if (bc < 0)          { bw += bc; bc = 0; }
  if (bc > BINS - 1)     bc = BINS - 1;
  if (bc + bw > BINS)    bw = BINS - bc;
  const osc = visdata[1];
  let accum = 0;
  if (ch === 0) {
    for (let i = 0; i < bw; i++) accum += (osc[0][bc + i] - 128) + (osc[1][bc + i] - 128);
    return accum / (bw * 255.0);
  }
  const chData = osc[ch - 1];
  for (let i = 0; i < bw; i++) accum += chData[bc + i] - 128;
  return accum / (bw * 127.5);
}

// Returns { getspec, getosc } closures for use in _jsScope.
// getVisdata() is called at invocation time so the effect can update
// this._visdata = ctx.visdata each frame before calling _runJS.
export function makeAudioScope(getVisdata) {
  return {
    getspec(band, bandw, chan) {
      const vd = getVisdata();
      return vd ? _getvis_spec(vd, band, bandw, chan) : 0;
    },
    getosc(band, bandw, chan) {
      const vd = getVisdata();
      return vd ? _getvis_osc(vd, band, bandw, chan) : 0;
    },
  };
}

// GLSL snippet injected into every dynamically-built shader that needs audio access.
// Requires a 576×1 RGBA8 texture with mipmaps bound as uAudioData:
//   r = spec_L, g = spec_R, b = osc_L, a = osc_R  (all raw 0–255 → normalized 0.0–1.0)
// Uses texelFetch at a mip LOD derived from bandw — O(1) regardless of bandwidth.
export const AUDIO_GLSL_SRC = /* glsl */`
uniform sampler2D uAudioData;

float getspec(float band, float bandw, float chan_f) {
  int ch   = int(chan_f + 0.5);
  if (ch < 0 || ch > 2) return 0.0;
  int lod  = clamp(int(floor(log2(max(1.0, bandw * 576.0)))), 0, 9);
  int lodW = max(1, 576 >> lod);
  int idx  = clamp(int(band * float(lodW)), 0, lodW - 1);
  vec4 s   = texelFetch(uAudioData, ivec2(idx, 0), lod);
  if (ch == 0) return (s.r + s.g) * 0.5;
  return ch == 1 ? s.r : s.g;
}

float getosc(float band, float bandw, float chan_f) {
  const float C = 128.0 / 255.0;
  int ch   = int(chan_f + 0.5);
  if (ch < 0 || ch > 2) return 0.0;
  int lod  = clamp(int(floor(log2(max(1.0, bandw * 576.0)))), 0, 9);
  int lodW = max(1, 576 >> lod);
  int idx  = clamp(int(band * float(lodW)), 0, lodW - 1);
  vec4 s   = texelFetch(uAudioData, ivec2(idx, 0), lod);
  if (ch == 0) return (s.b - C) + (s.a - C);
  float ov = ch == 1 ? s.b : s.a;
  return (ov - C) * 2.0;
}
`;

// Manages a 576×1 RGBA8 texture with full mipmap chain.
// Call update() once per frame after audio.update().
export class AudioGLBuffer {
  constructor(gl) {
    this._buf = new Uint8Array(BINS * 4);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, BINS, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  update(gl, visdata) {
    const buf    = this._buf;
    const specL  = visdata[0][0];
    const specR  = visdata[0][1];
    const oscL   = visdata[1][0];
    const oscR   = visdata[1][1];
    for (let i = 0; i < BINS; i++) {
      const j = i * 4;
      buf[j]     = specL[i] | 0;
      buf[j + 1] = specR[i] | 0;
      buf[j + 2] = oscL[i]  | 0;
      buf[j + 3] = oscR[i]  | 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BINS, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  destroy(gl) {
    gl.deleteTexture(this.texture);
  }
}
