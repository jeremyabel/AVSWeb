import { AudioAnalyzer } from './audio.js';
import { AudioGLBuffer } from './audio-data.js';
import { FBOManager } from './framebuffer-manager.js';
import { EffectChain } from './effect-chain.js';

export class AVSEngine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    this.audio = new AudioAnalyzer();
    this.audioBuffer = new AudioGLBuffer(gl);
    this.chain = new EffectChain(gl);
    this.fboManager = null;

    this._running = false;
    this._raf = null;
    this._frame = 0;
    this._lastTime = 0;
    this._time = 0;
    this.fps = 0;
    this.afterRender = null;

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const canvas = this.canvas;
    const area = canvas.parentElement;
    const w = Math.max(1, area ? area.clientWidth  : canvas.clientWidth);
    const h = Math.max(1, area ? area.clientHeight : canvas.clientHeight);

    // Render at half-res for performance, matching original AVS default of 640x480
    const rw = Math.min(w, 1600);
    const rh = Math.min(h, 1200);

    if (canvas.width === rw && canvas.height === rh) return;
    canvas.width  = rw;
    canvas.height = rh;
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';

    if (this.fboManager) {
      this.fboManager.resize(rw, rh);
    } else {
      this.fboManager = new FBOManager(this.gl, rw, rh);
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    const loop = (now) => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      this._tick(now);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _tick(now) {
    const dt = now - this._lastTime;
    if (dt > 0) { this.fps = Math.round(1000 / dt); this._time += dt / 1000; }
    this._lastTime = now;
    this._frame++;

    this.audio.update();
    this.audioBuffer.update(this.gl, this.audio.visdata);

    const ctx = {
      gl: this.gl,
      visdata: this.audio.visdata,
      audioTex: this.audioBuffer.texture,
      isBeat: this.audio.isBeat,
      fboManager: this.fboManager,
      w: this.canvas.width,
      h: this.canvas.height,
      frame: this._frame,
      time: this._time,
      lineBlendMode: 0,
    };

    this.chain.render(ctx);
    this.chain.blitToCanvas(this.gl, this.fboManager);
    if (this.afterRender) this.afterRender();
  }

  destroy() {
    this.stop();
    this.chain.destroy();
    this.fboManager.destroy();
    this.audioBuffer.destroy(this.gl);
  }
}
