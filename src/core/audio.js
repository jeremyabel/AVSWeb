const FFT_SIZE = 2048;
const BINS = 576;

// Constants from bpm.h
const BEAT_REAL    = 1;
const BEAT_GUESSED = 2;
const MAX_BPM      = 170;
const MIN_BPM      = 60;
const TOP_CONF_ADOPT       = 8;
const MIN_STICKY           = 8;
const STICKY_THRESHOLD     = 70;
const STICKY_THRESHOLD_LOW = 85;

// float equivalent of the original (576*16) integer threshold (÷128 because float amp is 0..1 not 0..128)
const MIN_BEAT_ENERGY = 576 * 16 / 128; // = 72.0

export class AudioAnalyzer {
  constructor() {
    this.ctx       = null;
    this.analyserL = null;
    this.analyserR = null;
    this.source    = null;
    this.splitter  = null;
    this.active    = false;

    // visdata[spectrum|waveform][L|R][0..575]
    this.visdata = [
      [new Float32Array(BINS), new Float32Array(BINS)],
      [new Float32Array(BINS), new Float32Array(BINS)],
    ];

    this._specBufL = new Float32Array(FFT_SIZE / 2);
    this._specBufR = new Float32Array(FFT_SIZE / 2);
    this._waveBufL = new Float32Array(FFT_SIZE);
    this._waveBufR = new Float32Array(FFT_SIZE);

    // ── Raw beat detection state (main.cpp globals) ───────────────────────────
    this._beatPeak1     = 0;
    this._beatPeak2     = 0;
    this._beatCnt       = 0;
    this._beatPeak1Peak = 0;
    this.isBeat         = false;

    // ── Smart BPM state (bpm.cpp initBpm) ────────────────────────────────────
    this._tcHist      = Array.from({ length: 8 }, () => ({ tc: 0, type: 0 }));
    this._smoother    = new Array(8).fill(0);
    this._halfDisc    = new Array(8).fill(0);
    this._hdPos       = 0;
    this._smPtr       = 0;
    this._smSize      = 8;
    this._offIMax     = 8;
    this._bpm         = 0;
    this._avg         = 0;
    this._insertCount = 0;
    this._predLastTC  = 0;
    this._confidence  = 0;
    this._halfCount   = 0;
    this._doubleCount = 0;
    this._tcHistSize  = 8;
    this._predBpm     = 0;
    this._lastBpm     = 0;
    this._lastTC      = 0;   // set to performance.now() on first beat
    this._sticked         = false;
    this._stickyConfCount = 0;
    this._forceNewBeat    = 0;
    this._topConfCount    = 0;
    this._bestConfidence  = 0;
    this._tcUsed          = 0;

    // cfg_smartbeat=0 in original (simple mode = pass raw beat through)
    this.smartBeat = false;
  }

  async connectMicrophone() {
    if (!this.ctx) this._initCtx();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.source) this.source.disconnect();
    this.source = this.ctx.createMediaStreamSource(stream);
    this._connectSource();
    this.active = true;
  }

  connectAudioElement(el) {
    if (!this.ctx) this._initCtx();
    if (this.source) this.source.disconnect();
    this.source = this.ctx.createMediaElementSource(el);
    this._connectSource();
    this.active = true;
  }

  disconnect() {
    if (this.source) { this.source.disconnect(); this.source = null; }
    this.active = false;
  }

  _initCtx() {
    this.ctx = new AudioContext();
    this.analyserL = this.ctx.createAnalyser();
    this.analyserR = this.ctx.createAnalyser();
    for (const a of [this.analyserL, this.analyserR]) {
      a.fftSize = FFT_SIZE;
      a.smoothingTimeConstant = 0.5;
    }
    this.splitter = this.ctx.createChannelSplitter(2);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
  }

  _connectSource() {
    this.source.connect(this.splitter);
    this.source.connect(this.ctx.destination);
  }

  update() {
    if (!this.active) return;

    this.analyserL.getFloatFrequencyData(this._specBufL);
    this.analyserR.getFloatFrequencyData(this._specBufR);
    this.analyserL.getFloatTimeDomainData(this._waveBufL);
    this.analyserR.getFloatTimeDomainData(this._waveBufR);

    this._resample(this._specBufL, this.visdata[0][0], true);
    this._resample(this._specBufR, this.visdata[0][1], true);
    this._resample(this._waveBufL, this.visdata[1][0], false);
    this._resample(this._waveBufR, this.visdata[1][1], false);

    this._detectBeat();
  }

  _resample(src, dst, isSpectrum) {
    const srcLen = src.length;
    const dstLen = dst.length;
    const scale  = srcLen / dstLen;
    for (let i = 0; i < dstLen; i++) {
      const r  = i * scale;
      const lo = Math.floor(r);
      const hi = Math.min(lo + 1, srcLen - 1);
      const t  = r - lo;
      let v = src[lo] * (1 - t) + src[hi] * t;
      if (isSpectrum) {
        v = Math.max(0, (v + 100) / 100) * 255;
      } else {
        v = (v * 0.5 + 0.5) * 255;
      }
      dst[i] = Math.max(0, Math.min(255, v));
    }
  }

  // ── Raw beat detection ─────────────────────────────────────────────────────
  // Matches main.cpp render() lines 350-384.
  // Original uses sum-of-abs of 8-bit waveform (0..128 per sample, 0..73728 total).
  // Float equivalent: abs(float) per sample (0..1), total 0..576.
  // Threshold 576*16 (int) → 576*16/128 = 72.0 (float).
  _detectBeat() {
    const wL = this._waveBufL;
    const wR = this._waveBufR;
    let ltL = 0, ltR = 0;
    for (let i = 0; i < 576; i++) {
      ltL += Math.abs(wL[i]);
      ltR += Math.abs(wR[i]);
    }
    const lt = ltL > ltR ? ltL : ltR;

    this._beatPeak1 = (this._beatPeak1 * 125 + this._beatPeak2 * 3) / 128;
    this._beatCnt++;

    let rawBeat = 0;
    if (lt >= (this._beatPeak1 * 34) / 32 && lt > MIN_BEAT_ENERGY) {
      if (this._beatCnt > 0) {
        this._beatCnt = 0;
        rawBeat = 1;
      }
      this._beatPeak1     = (lt + this._beatPeak1Peak) / 2;
      this._beatPeak1Peak = lt;
    } else if (lt > this._beatPeak2) {
      this._beatPeak2 = lt;
    } else {
      this._beatPeak2 = (this._beatPeak2 * 14) / 16;
    }

    this.isBeat = !!this._refineBeat(rawBeat);
  }

  // ── BPM tracker helpers (bpm.cpp) ─────────────────────────────────────────

  _readyToLearn() {
    for (let i = 0; i < this._tcHistSize; i++)
      if (this._tcHist[i].tc === 0) return false;
    return true;
  }

  _readyToGuess() {
    return this._insertCount === this._tcHistSize * 2;
  }

  _insertHistStep(tc, type, i) {
    if (i >= this._tcHistSize) return;
    if (this._insertCount < this._tcHistSize * 2) this._insertCount++;
    // Shift t[i..end-1] right by one slot
    for (let j = this._tcHistSize - 1; j > i; j--) {
      this._tcHist[j].tc   = this._tcHist[j - 1].tc;
      this._tcHist[j].type = this._tcHist[j - 1].type;
    }
    this._tcHist[0].tc   = tc;
    this._tcHist[0].type = type;
  }

  // Returns true if this beat was accepted into history.
  _tcHistStep(tc, type) {
    const learning = this._readyToLearn();
    const thisLen  = tc - this._lastTC;

    // Discard if sooner than half avg - 20%
    if (thisLen < this._avg / 2 - this._avg * 0.2) {
      if (learning) {
        const t = this._tcHist;
        if (Math.abs(this._avg - (tc - t[1].tc)) <
            Math.abs(this._avg - (t[0].tc - t[1].tc))) {
          t[0].tc   = tc;
          t[0].type = type;
          return true;
        }
      }
      return false;
    }

    // Check if this is a sub-division of the current beat period
    if (learning) {
      for (let offI = 2; offI < this._offIMax; offI++) {
        if (Math.abs(this._avg / offI - thisLen) < (this._avg / offI) * 0.2) {
          this._halfDisc[this._hdPos++] = 1;
          this._hdPos %= 8;
          return false;
        }
      }
    }

    this._halfDisc[this._hdPos++] = 0;
    this._hdPos %= 8;

    this._lastTC = tc;
    this._insertHistStep(tc, type, 0);
    return true;
  }

  _newBpm(bpm) {
    this._smoother[this._smPtr++] = bpm;
    this._smPtr %= this._smSize;
  }

  _getBpm() {
    let sum = 0, n = 0;
    for (let i = 0; i < this._smSize; i++)
      if (this._smoother[i] > 0) { sum += this._smoother[i]; n++; }
    return n ? Math.floor(sum / n) : 0;
  }

  _doubleBeat() {
    if (this._sticked && this._bpm > MIN_BPM) return;
    const t  = this._tcHist;
    const iv = new Array(this._tcHistSize);
    for (let i = 0; i < this._tcHistSize - 1; i++) iv[i] = t[i].tc - t[i + 1].tc;
    for (let i = 1; i < this._tcHistSize; i++)      t[i].tc = t[i - 1].tc - Math.floor(iv[i - 1] / 2);
    this._avg  = Math.floor(this._avg / 2);
    this._bpm *= 2;
    this._doubleCount = 0;
    this._smoother.fill(0);
    this._halfDisc.fill(0);
  }

  _halfBeat() {
    if (this._sticked && this._bpm < MIN_BPM) return;
    const t  = this._tcHist;
    const iv = new Array(this._tcHistSize);
    for (let i = 0; i < this._tcHistSize - 1; i++) iv[i] = t[i].tc - t[i + 1].tc;
    for (let i = 1; i < this._tcHistSize; i++)      t[i].tc = t[i - 1].tc - iv[i - 1] * 2;
    this._avg  *= 2;
    this._bpm   = Math.floor(this._bpm / 2);
    this._halfCount = 0;
    this._smoother.fill(0);
    this._halfDisc.fill(0);
  }

  _resetAdapt() {
    this._tcUsed      = 0;
    this._hdPos       = 0;
    this._avg         = 0;
    this._confidence  = 0;
    this._topConfCount    = 0;
    this._bpm         = 0;
    this._smPtr       = 0;
    this._smSize      = 8;
    this._offIMax     = 8;
    this._insertCount = 0;
    this._predLastTC  = 0;
    this._halfCount   = 0;
    this._doubleCount = 0;
    this._tcHistSize  = 8;
    this._predBpm     = 0;
    this._bestConfidence  = 0;
    this._lastTC          = performance.now();
    this._sticked         = false;
    this._stickyConfCount = 0;
    for (const slot of this._tcHist) { slot.tc = 0; slot.type = 0; }
    this._smoother.fill(0);
    this._halfDisc.fill(0);
  }

  _calcBPM() {
    if (!this._readyToLearn()) return;

    const t  = this._tcHist;
    const sz = this._tcHistSize;

    // Simple average of inter-beat intervals
    let totalTC = 0;
    for (let i = 0; i < sz - 1; i++) totalTC += t[i].tc - t[i + 1].tc;
    this._avg = totalTC / (sz - 1);

    // Count real beats for confidence part 1
    let r = 0;
    for (let i = 0; i < sz; i++) if (t[i].type === BEAT_REAL) r++;
    const rC = Math.min((r / sz) * 2, 1.0);

    // Compute standard deviation of intervals
    let sc = 0, mx = 0, v = 0;
    for (let i = 0; i < sz - 1; i++) {
      v   = t[i].tc - t[i + 1].tc;
      if (v > mx) mx = v;
      sc += v * v;
    }
    // v intentionally carries the last interval value into the second loop (matches original)
    const et  = Math.sqrt(Math.max(0, sc / (sz - 1) - this._avg * this._avg));
    const etC = mx > 0 ? 1.0 - et / mx : 0.0;

    this._confidence = Math.max(0, Math.floor(((rC * etC) * 100.0 - 50) * 2));

    // Refined average: only intervals within typical drift, accumulating v (original quirk)
    totalTC = 0;
    let totalN = 0;
    for (let i = 0; i < sz - 1; i++) {
      v += t[i].tc - t[i + 1].tc;
      if (Math.abs(this._avg - v) < et) {
        totalTC += v;
        totalN++;
        v = 0;
      } else if (v > this._avg) {
        v = 0;
      }
    }
    this._tcUsed = totalN;
    if (totalN) this._avg = totalTC / totalN;

    if (!this._readyToGuess()) return;

    if (this._avg) this._bpm = Math.floor(60000 / this._avg);

    if (this._bpm !== this._lastBpm) {
      this._newBpm(this._bpm);
      this._lastBpm = this._bpm;
      if (this.smartBeat && this._predBpm &&
          this._confidence >= (this._predBpm < 90 ? STICKY_THRESHOLD_LOW : STICKY_THRESHOLD)) {
        if (++this._stickyConfCount >= MIN_STICKY) this._sticked = true;
      } else {
        this._stickyConfCount = 0;
      }
    }

    this._bpm = this._getBpm();

    // Auto double-beat when too many sub-divisions were discriminated
    let hdCount = 0;
    for (let i = 0; i < sz; i++) if (this._halfDisc[i]) hdCount++;
    if (hdCount >= sz / 2 && this._bpm * 2 < MAX_BPM) {
      this._doubleBeat();
      this._halfDisc.fill(0);
    }

    if (this._bpm > 500 || this._bpm < 0) { this._resetAdapt(); return; }

    if (this._bpm < MIN_BPM) { if (++this._doubleCount > 4) this._doubleBeat(); }
    else                      { this._doubleCount = 0; }

    if (this._bpm > MAX_BPM) { if (++this._halfCount > 4) this._halfBeat(); }
    else                      { this._halfCount = 0; }
  }

  // ── refineBeat (bpm.cpp) ──────────────────────────────────────────────────
  // In simple mode (smartBeat=false) returns isBeat unchanged.
  // In smart mode predicts beats from learned BPM and filters raw detections.
  _refineBeat(isBeat) {
    const now = performance.now();
    if (this._lastTC === 0) this._lastTC = now;

    // Predict whether this frame is a beat based on current tempo
    let predicted = false;
    if (this._bpm && now > this._predLastTC + 60000 / this._bpm)
      predicted = true;

    let accepted = false;
    if (isBeat) accepted = this._tcHistStep(now, BEAT_REAL);

    this._calcBPM();

    // Try to adopt a new predictionBpm
    if ((accepted || predicted) && !this._sticked &&
        (!this._predBpm || this._predBpm > MAX_BPM || this._predBpm < MIN_BPM)) {
      if (this._confidence >= this._bestConfidence)
        this._forceNewBeat = 1;
      if (this._confidence >= 50) {
        if (++this._topConfCount >= TOP_CONF_ADOPT) {
          this._forceNewBeat = 1;
          this._topConfCount = 0;
        }
      }
      if (this._forceNewBeat) {
        this._forceNewBeat    = 0;
        this._bestConfidence  = this._confidence;
        this._predBpm         = this._bpm;
      }
    }

    if (!this._sticked) this._predBpm = this._bpm;
    this._bpm = this._predBpm;

    // Resync: accepted beat that's early or late vs prediction
    let resyncin = false, resyncout = false;
    if (this._predBpm && accepted && !predicted) {
      const interval = 60000 / this._predBpm;
      if (now > this._predLastTC + interval * 0.7) resyncin  = true;
      if (now < this._predLastTC + interval * 0.3) resyncout = true;
    }

    if (resyncin) {
      this._predLastTC = now;
      return this.smartBeat ? 1 : isBeat;
    }
    if (predicted) {
      this._predLastTC = now;
      if (this._confidence > 25) this._tcHistStep(now, BEAT_GUESSED);
      return this.smartBeat ? 1 : isBeat;
    }
    if (resyncout) {
      this._predLastTC = now;
      return this.smartBeat ? 0 : isBeat;
    }

    return this.smartBeat ? (this._predBpm ? 0 : isBeat) : isBeat;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
}
