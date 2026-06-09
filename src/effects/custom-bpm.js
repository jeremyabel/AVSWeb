import { Effect } from './effect.js';

// Modifies ctx.isBeat for downstream effects in the chain.
// Three mutually exclusive modes (priority: arbitrary > skip > invert):
//   arbitrary – fires a beat every arbVal ms regardless of audio
//   skip      – passes every (skipVal+1)-th incoming beat
//   invert    – fires when there is NO beat, suppresses when there IS
// skipfirst: suppress the first N incoming beats before any mode activates.

export class CustomBPMEffect extends Effect {
  constructor(gl) {
    super(gl);
    this.arbitrary = true;
    this.skip      = false;
    this.invert    = false;
    this.arbVal    = 120;   // BPM for arbitrary mode (6–300)
    this.skipVal   = 1;     // pass every skipVal+1 beats (1–16)
    this.skipfirst = 0;     // suppress first N incoming beats (0–64)

    this._arbLastTC  = performance.now();
    this._skipCount  = 0;
    this._beatCount  = 0;

    // Beat meter state: segment index (0-7) and bounce direction
    this._inSeg  = 0;  this._inDir  = 1;
    this._outSeg = 0;  this._outDir = 1;
  }

  render(ctx) {
    const now    = performance.now();
    const isBeat = ctx.isBeat;

    if (isBeat) {
      this._beatCount++;
      this._inSeg += this._inDir;
      if      (this._inSeg >= 7) { this._inSeg = 7; this._inDir = -1; }
      else if (this._inSeg <= 0) { this._inSeg = 0; this._inDir =  1; }
    }

    if (this.skipfirst !== 0 && this._beatCount <= this.skipfirst) {
      if (isBeat) ctx.isBeat = false;
    } else if (this.arbitrary) {
      if (now > this._arbLastTC + 60000 / this.arbVal) {
        this._arbLastTC = now;
        ctx.isBeat = true;
      } else {
        ctx.isBeat = false;
      }
    } else if (this.skip) {
      if (isBeat && ++this._skipCount >= this.skipVal + 1) {
        this._skipCount = 0;
        ctx.isBeat = true;
      } else {
        ctx.isBeat = false;
      }
    } else if (this.invert) {
      ctx.isBeat = !isBeat;
    }

    if (ctx.isBeat) {
      this._outSeg += this._outDir;
      if      (this._outSeg >= 7) { this._outSeg = 7; this._outDir = -1; }
      else if (this._outSeg <= 0) { this._outSeg = 0; this._outDir =  1; }
    }
  }

  getLiveState() {
    return { inPos: this._inSeg, outPos: this._outSeg };
  }

  getConfig() {
    return {
      arbitrary: this.arbitrary,
      skip:      this.skip,
      invert:    this.invert,
      arbVal:    this.arbVal,
      skipVal:   this.skipVal,
      skipfirst: this.skipfirst,
    };
  }

  setConfig(cfg) {
    if (cfg.arbitrary !== undefined) this.arbitrary = cfg.arbitrary;
    if (cfg.skip      !== undefined) this.skip      = cfg.skip;
    if (cfg.invert    !== undefined) this.invert    = cfg.invert;
    if (cfg.arbVal    !== undefined) this.arbVal    = Math.max(6,   Math.min(300,   cfg.arbVal));
    if (cfg.skipVal   !== undefined) this.skipVal   = Math.max(1,   Math.min(16,    cfg.skipVal));
    if (cfg.skipfirst !== undefined) this.skipfirst = Math.max(0,   Math.min(64,    cfg.skipfirst));
  }

  getDescriptor() {
    return {
      name: 'Custom BPM',
      params: [
        { name: 'arbitrary', label: 'Arbitrary BPM',  type: 'bool',  default: true  },
        { name: 'skip',      label: 'Skip Beats',     type: 'bool',  default: false },
        { name: 'invert',    label: 'Invert Beat',    type: 'bool',  default: false },
        { name: 'arbVal',    label: 'Arbitrary BPM',  type: 'range', min: 6, max: 300, step: 1, default: 120, disabledWhen: { param: 'arbitrary', value: false } },
        { name: 'skipVal',   label: 'Skip',           type: 'range', min: 1,   max: 16,    step: 1,   default: 1, disabledWhen: { param: 'skip', value: false } },
        { name: 'skipfirst', label: 'Skip First N',   type: 'range', min: 0,   max: 64,    step: 1,   default: 0 },
        { name: 'inMeter',   label: 'In',             type: 'beat-meter', liveKey: 'inPos'  },
        { name: 'outMeter',  label: 'Out',            type: 'beat-meter', liveKey: 'outPos' },
      ],
    };
  }

  destroy() {}
}
