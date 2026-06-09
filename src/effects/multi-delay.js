import { Effect, createProgram, getQuadVAO } from './effect.js';
import vertSrc from '../shaders/fullscreen.vert?raw';

// ── Design notes ──────────────────────────────────────────────────────────────
//
// Multiple instances of MultiDelay in one preset share 6 ring-buffer slots.
// Typical use: one instance (mode=1) writes the current frame into slot N;
// later in the chain, another instance (mode=2) reads a time-delayed copy out.
//
// The original uses global C++ state for the 6 buffers.  Here a module-level
// singleton (G) plays the same role and is safe for one WebGL context / page.
//
// Ring mechanics (per slot, framedelay = delay + 1):
//   outIdx = 0              (oldest frame → what mode-2 reads)
//   inIdx  = framedelay-1  (newest write position)
//   Both advance together each frame (last instance drives the advance).
//   After delay frames, outIdx catches up to where inIdx started → delay frames old.
//
// MAX_RING caps VRAM: 6 slots × 32 textures × 640×480 ≈ 230 MB worst-case.

const MAX_RING = 32;

const FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
out vec4 fragColor;
void main() {
  fragColor = vec4(texture(uInput, vUv).rgb, 1.0);
}`;

// ── Shared global state ────────────────────────────────────────────────────────
const G = {
  numInstances:    0,
  renderId:        0,
  framessincebeat: 0,
  framesperbeat:   0,
  lastW:           0,
  lastH:           0,

  usebeats:   new Array(6).fill(false),
  delays:     new Array(6).fill(0),        // user-set value (frames or beats count)
  framedelays: new Array(6).fill(0),        // actual delay in frames (= delay+1 in frame mode)

  slots: Array.from({ length: 6 }, () => ({
    ring:   [],    // [{ tex, fbo }]
    inIdx:  0,     // write position
    outIdx: 0,     // read position (outIdx = 0, inIdx = size-1 initially)
    size:   0,
  })),
};

// ── GL helpers ─────────────────────────────────────────────────────────────────
function makeEntry(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { tex, fbo };
}

function freeSlot(gl, slot) {
  for (const { tex, fbo } of slot.ring) {
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fbo);
  }
  slot.ring  = [];
  slot.size  = 0;
  slot.inIdx = 0;
  slot.outIdx = 0;
}

function freeAllSlots(gl) {
  for (const slot of G.slots) freeSlot(gl, slot);
}

// Resize (or allocate) one slot to match the required framedelay.
function ensureSlot(gl, i, w, h) {
  const fd = G.framedelays[i];
  const slot = G.slots[i];

  if (fd <= 1) {
    if (slot.size > 0) freeSlot(gl, slot);
    return;
  }

  const needed = Math.min(fd, MAX_RING);
  if (slot.size === needed) return;

  // Size changed: rebuild (brief transition glitch is acceptable, matching
  // the original's "allocate new memory" path without the complex copy logic).
  freeSlot(gl, slot);
  for (let j = 0; j < needed; j++) slot.ring.push(makeEntry(gl, w, h));
  slot.size   = needed;
  slot.outIdx = 0;
  slot.inIdx  = needed - 1;  // distance = framedelay-1 (capped)
}

function blit(gl, prog, uInput, srcTex, dstFBO, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, dstFBO);
  gl.viewport(0, 0, w, h);
  gl.useProgram(prog);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(uInput, 0);
  const vao = getQuadVAO(gl);
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindVertexArray(null);
}

// ── Effect class ──────────────────────────────────────────────────────────────
const BUFFER_OPTIONS = [0,1,2,3,4,5].map(i => ({ value: i, label: `Buffer ${i + 1}` }));

export class MultiDelayEffect extends Effect {
  constructor(gl) {
    super(gl);
    G.numInstances++;
    this._creationId = G.numInstances;

    this.mode         = 0;   // 0=disabled  1=write  2=read
    this.activebuffer = 0;   // 0-5

    this._prog   = createProgram(gl, vertSrc, FRAG);
    this._uInput = gl.getUniformLocation(this._prog, 'uInput');
  }

  render(ctx) {
    const { gl, isBeat, fboManager, inputTex, outputFBO } = ctx;
    const w = fboManager.w, h = fboManager.h;

    // Track which instance is rendering this frame (mirrors renderid logic in original)
    if (G.renderId === G.numInstances) G.renderId = 0;
    G.renderId++;
    const isFirst = G.renderId === 1;
    const isLast  = G.renderId === G.numInstances;

    // ── First instance: global housekeeping (matches renderid==1 block) ──────
    if (isFirst) {
      // Canvas resize → free all rings (they'll be rebuilt below)
      if (w !== G.lastW || h !== G.lastH) {
        freeAllSlots(gl);
        G.lastW = w;
        G.lastH = h;
      }

      // Beat-based delay update
      if (isBeat) {
        G.framesperbeat = G.framessincebeat;
        for (let i = 0; i < 6; i++) {
          if (G.usebeats[i]) G.framedelays[i] = G.framesperbeat + 1;
        }
        G.framessincebeat = 0;
      }
      G.framessincebeat++;

      // Ensure all active slots have the right ring size
      for (let i = 0; i < 6; i++) ensureSlot(gl, i, w, h);
    }

    // ── Current instance action ───────────────────────────────────────────────
    const ab   = this.activebuffer;
    const slot = G.slots[ab];
    if (this.mode !== 0 && G.framedelays[ab] > 1 && slot.size > 0) {
      if (this.mode === 1) {
        // Write: store current frame at inIdx (no output change)
        blit(gl, this._prog, this._uInput, inputTex, slot.ring[slot.inIdx].fbo, w, h);
      } else {
        // Read: replace current framebuffer with delayed frame at outIdx
        blit(gl, this._prog, this._uInput, slot.ring[slot.outIdx].tex, outputFBO, w, h);
        fboManager.swap();
      }
    }

    // ── Last instance: advance all ring pointers (matches renderid==numinstances block)
    if (isLast) {
      for (let i = 0; i < 6; i++) {
        const s = G.slots[i];
        if (s.size > 0) {
          s.inIdx  = (s.inIdx  + 1) % s.size;
          s.outIdx = (s.outIdx + 1) % s.size;
        }
      }
    }
  }

  getConfig() {
    const cfg = { mode: this.mode, activebuffer: this.activebuffer };
    for (let i = 0; i < 6; i++) {
      cfg[`usebeats${i}`] = G.usebeats[i] ? 1 : 0;
      cfg[`delay${i}`]    = G.delays[i];
    }
    return cfg;
  }

  setConfig(cfg) {
    if (cfg.mode         !== undefined) this.mode         = cfg.mode;
    if (cfg.activebuffer !== undefined) this.activebuffer = Math.max(0, Math.min(5, cfg.activebuffer));
    for (let i = 0; i < 6; i++) {
      const ub = cfg[`usebeats${i}`];
      const d  = cfg[`delay${i}`];
      if (ub !== undefined) G.usebeats[i] = !!ub;
      if (d  !== undefined) {
        G.delays[i] = Math.max(0, d);
        // For frame mode, set framedelay immediately; beat mode waits for next beat
        if (!G.usebeats[i]) G.framedelays[i] = G.delays[i] + 1;
      }
    }
  }

  getDescriptor() {
    const params = [
      { name: 'mode', label: 'Mode', type: 'select', options: [
        { value: 0, label: 'Disabled'        },
        { value: 1, label: 'Write to buffer' },
        { value: 2, label: 'Read from buffer'},
      ], default: 0 },
      { name: 'activebuffer', label: 'Buffer', type: 'select',
        options: BUFFER_OPTIONS, default: 0 },
    ];
    for (let i = 0; i < 6; i++) {
      params.push({ name: `usebeats${i}`, label: `Buf ${i + 1} Unit`,
        type: 'select',
        options: [{ value: 0, label: 'Frames' }, { value: 1, label: 'Beats' }],
        default: 0 });
      params.push({ name: `delay${i}`, label: `Buf ${i + 1} Delay`,
        type: 'range', min: 0, max: 200, step: 1, default: 0 });
    }
    return { name: 'Multi Delay', params };
  }

  destroy() {
    G.numInstances--;
    if (G.numInstances === 0) {
      freeAllSlots(this.gl);
      G.renderId        = 0;
      G.framessincebeat = 0;
      G.framesperbeat   = 0;
      G.lastW           = 0;
      G.lastH           = 0;
      G.usebeats.fill(false);
      G.delays.fill(0);
      G.framedelays.fill(0);
    }
    this.gl.deleteProgram(this._prog);
  }
}
