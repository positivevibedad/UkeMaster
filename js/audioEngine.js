/*
 * audioEngine.js
 * Builds and controls the Web Audio processing graph.
 *
 * Signal flow:
 *   source -> inputGain -> HPF -> LPF -> EQ(10 bands) -> de-esser
 *          -> compressor -> maximizer(gain -> limiter) -> analyser
 *          -> masterGain -> destination (+ recording tap)
 */

// Four musical EQ bands (Low, Low-Mid, Hi-Mid, High).
const EQ_BANDS = [
  { freq: 120,  label: 'Low' },
  { freq: 600,  label: 'Low-Mid' },
  { freq: 2500, label: 'Hi-Mid' },
  { freq: 9000, label: 'High' },
];

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.connectedEl = null;
    this.nodes = {};
    this.eqBands = [];
    this.recordDest = null;
  }

  /** Lazily create the AudioContext (must follow a user gesture). */
  ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  _buildGraph() {
    const ctx = this.ctx;

    // --- Input ---
    const inputGain = ctx.createGain();
    inputGain.gain.value = 1;

    // --- High-pass filter --- (starts neutralised; toggle defaults to off)
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 10;     // neutral
    hpf.Q.value = 0.0001;
    hpf._userFreq = 80;           // remembered cutoff when engaged
    hpf._userQ = 0.7;
    this._hpfOn = false;

    // --- Low-pass filter --- (starts neutralised; toggle defaults to off)
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 22050;  // neutral
    lpf.Q.value = 0.0001;
    lpf._userFreq = 18000;
    lpf._userQ = 0.7;
    this._lpfOn = false;

    // --- Parametric EQ: 4 peaking bands in series, shared Q ---
    this._eqQ = 1.5;
    this.eqBands = EQ_BANDS.map((b) => {
      const band = ctx.createBiquadFilter();
      band.type = 'peaking';
      band.frequency.value = b.freq;
      band.Q.value = this._eqQ;
      band.gain.value = 0;
      return band;
    });

    // --- De-esser (split-band dynamic) ---
    // Split signal into low and high (sibilance) bands; compress only the
    // high band, then recombine. A genuine split-band de-esser.
    const deEss = this._buildDeEsser(ctx);

    // --- Compressor ---
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    comp.knee.value = 24;
    this._compOn = true;

    // Bypass path for compressor (so toggle is seamless)
    const compIn = ctx.createGain();
    const compWet = ctx.createGain();
    const compDry = ctx.createGain();
    const compOut = ctx.createGain();
    compWet.gain.value = 1;
    compDry.gain.value = 0;
    compIn.connect(comp);
    comp.connect(compWet);
    compWet.connect(compOut);
    compIn.connect(compDry);
    compDry.connect(compOut);

    // --- Maximizer: makeup gain + soft-clip limiter (WaveShaper) ---
    const maxGain = ctx.createGain();
    maxGain.gain.value = this._dbToGain(3);
    const limiter = ctx.createWaveShaper();
    limiter.curve = this._makeLimiterCurve(this._dbToGain(-0.3));
    limiter.oversample = '4x';
    this._ceilingGain = this._dbToGain(-0.3);

    // --- Analyser (centerpiece) ---
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.78;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;

    // Per-channel meters
    const splitter = ctx.createChannelSplitter(2);
    const meterL = ctx.createAnalyser();
    const meterR = ctx.createAnalyser();
    meterL.fftSize = 1024;
    meterR.fftSize = 1024;

    // --- Master ---
    const masterGain = ctx.createGain();
    masterGain.gain.value = 1;

    // Recording tap
    const recordDest = ctx.createMediaStreamDestination();

    // --- Wire it together ---
    inputGain.connect(hpf);
    hpf.connect(lpf);
    let prev = lpf;
    this.eqBands.forEach((b) => {
      prev.connect(b);
      prev = b;
    });
    prev.connect(deEss.input);
    deEss.output.connect(compIn);
    compOut.connect(maxGain);
    maxGain.connect(limiter);
    limiter.connect(analyser);
    analyser.connect(masterGain);
    masterGain.connect(ctx.destination);
    masterGain.connect(recordDest);
    // meters tap
    limiter.connect(splitter);
    splitter.connect(meterL, 0);
    splitter.connect(meterR, 1);

    this.nodes = {
      inputGain, hpf, lpf, deEss, comp,
      compIn, compWet, compDry, compOut,
      maxGain, limiter, analyser, masterGain,
      meterL, meterR, recordDest,
    };
    this.recordDest = recordDest;
  }

  _buildDeEsser(ctx) {
    const input = ctx.createGain();
    const output = ctx.createGain();

    // --- Engaged path: split into low band + compressed sibilance band ---
    // Low band (everything below crossover) passes clean
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 6500;
    low.Q.value = 0.5;
    const lowGain = ctx.createGain();
    lowGain.gain.value = 0; // off by default

    // High band (sibilance) -> aggressive compressor
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 6500;
    high.Q.value = 0.5;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; // controlled by "amount"
    comp.ratio.value = 12;
    comp.attack.value = 0.001;
    comp.release.value = 0.05;
    comp.knee.value = 6;

    const highGain = ctx.createGain();
    highGain.gain.value = 0; // off by default

    input.connect(low);
    low.connect(lowGain);
    lowGain.connect(output);
    input.connect(high);
    high.connect(comp);
    comp.connect(highGain);
    highGain.connect(output);

    // --- Bypass path: full-range signal when disabled ---
    const bypass = ctx.createGain();
    bypass.gain.value = 1; // on by default (de-esser starts disabled)
    input.connect(bypass);
    bypass.connect(output);

    return { input, output, low, lowGain, high, comp, highGain, bypass, _on: false };
  }

  // ---- Media source ----
  connectMediaElement(el) {
    this.ensureContext();
    if (this.connectedEl === el && this.source) return;
    // A MediaElement can only be tied to one source node for its lifetime.
    if (this.source) {
      try { this.source.disconnect(); } catch (e) {}
    }
    this.source = this.ctx.createMediaElementSource(el);
    this.source.connect(this.nodes.inputGain);
    this.connectedEl = el;
  }

  // ---- Parameter setters ----
  _dbToGain(db) { return Math.pow(10, db / 20); }

  setHPF({ on, freq, q }) {
    const hpf = this.nodes.hpf;
    if (on !== undefined) this._hpfOn = on;
    if (freq !== undefined) hpf._userFreq = freq;
    if (q !== undefined) hpf._userQ = q;
    const f = hpf._userFreq ?? hpf.frequency.value;
    const qv = hpf._userQ ?? hpf.Q.value;
    // "Off" => effectively no filtering (sub-audible cutoff, gentle slope)
    hpf.frequency.value = this._hpfOn ? f : 10;
    hpf.Q.value = this._hpfOn ? qv : 0.0001;
  }

  setLPF({ on, freq, q }) {
    const lpf = this.nodes.lpf;
    if (on !== undefined) this._lpfOn = on;
    if (freq !== undefined) lpf._userFreq = freq;
    if (q !== undefined) lpf._userQ = q;
    const f = lpf._userFreq ?? lpf.frequency.value;
    const qv = lpf._userQ ?? lpf.Q.value;
    lpf.frequency.value = this._lpfOn ? f : 22050;
    lpf.Q.value = this._lpfOn ? qv : 0.0001;
  }

  setEQBand(index, gainDb) {
    if (this.eqBands[index]) this.eqBands[index].gain.value = gainDb;
  }

  setEQQ(q) {
    this._eqQ = q;
    this.eqBands.forEach((b) => { b.Q.value = q; });
  }

  resetEQ() {
    this.eqBands.forEach((b) => { b.gain.value = 0; });
  }

  /**
   * Combined magnitude response of all EQ bands over the given frequencies.
   * Returns a Float32Array of linear magnitudes (multiply each band).
   */
  getEQResponse(freqArray) {
    const n = freqArray.length;
    const total = new Float32Array(n).fill(1);
    const mag = new Float32Array(n);
    const phase = new Float32Array(n);
    this.eqBands.forEach((band) => {
      band.getFrequencyResponse(freqArray, mag, phase);
      for (let i = 0; i < n; i++) total[i] *= mag[i];
    });
    return total;
  }

  setDeEsser({ on, freq, amount }) {
    const d = this.nodes.deEss;
    if (!d) return;
    if (on !== undefined) {
      d._on = on;
      const t = this.ctx.currentTime;
      // Cross-fade between the split (engaged) path and the clean bypass.
      d.lowGain.gain.setTargetAtTime(on ? 1 : 0, t, 0.01);
      d.highGain.gain.setTargetAtTime(on ? 1 : 0, t, 0.01);
      d.bypass.gain.setTargetAtTime(on ? 0 : 1, t, 0.01);
    }
    if (freq !== undefined) {
      d.low.frequency.value = freq;
      d.high.frequency.value = freq;
    }
    if (amount !== undefined) {
      // amount (0..40 dB) maps to a lower threshold -> more reduction
      d.comp.threshold.value = -8 - amount;
    }
  }

  setCompressor({ on, threshold, ratio, attack, release, knee }) {
    const c = this.nodes.comp;
    if (threshold !== undefined) c.threshold.value = threshold;
    if (ratio !== undefined) c.ratio.value = ratio;
    if (attack !== undefined) c.attack.value = attack / 1000;
    if (release !== undefined) c.release.value = release / 1000;
    if (knee !== undefined) c.knee.value = knee;
    if (on !== undefined) {
      this._compOn = on;
      const t = this.ctx.currentTime;
      this.nodes.compWet.gain.setTargetAtTime(on ? 1 : 0, t, 0.01);
      this.nodes.compDry.gain.setTargetAtTime(on ? 0 : 1, t, 0.01);
    }
  }

  setMaximizer({ gainDb, ceilingDb }) {
    if (gainDb !== undefined) {
      this.nodes.maxGain.gain.value = this._dbToGain(gainDb);
    }
    if (ceilingDb !== undefined) {
      this._ceilingGain = this._dbToGain(ceilingDb);
      this.nodes.limiter.curve = this._makeLimiterCurve(this._ceilingGain);
    }
  }

  setMasterGain(g) {
    if (this.nodes.masterGain) this.nodes.masterGain.gain.value = g;
  }

  // ---- Metering ----
  getCompReduction() {
    return this.nodes.comp ? this.nodes.comp.reduction : 0;
  }

  getDeEssReduction() {
    return this.nodes.deEss && this.nodes.deEss._on
      ? this.nodes.deEss.comp.reduction : 0;
  }

  // ---- Limiter curve (soft tanh clip at ceiling) ----
  _makeLimiterCurve(ceiling) {
    const n = 2048;
    const curve = new Float32Array(n);
    const c = Math.max(0.05, ceiling);
    // Unity slope at the origin (k = 1/c) so quiet signals pass through
    // untouched, while the curve saturates softly toward +/- the ceiling.
    const k = 1 / c;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1; // -1..1
      curve[i] = Math.tanh(x * k) * c;
    }
    return curve;
  }

  // ---- Recording ----
  getRecordStream() {
    return this.recordDest ? this.recordDest.stream : null;
  }
}

window.AudioEngine = AudioEngine;
window.EQ_BANDS = EQ_BANDS;
