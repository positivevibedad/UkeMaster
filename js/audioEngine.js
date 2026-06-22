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
    hpf.frequency.value = 10;     // neutral: out of the audible band
    hpf.Q.value = 0.7071;         // Butterworth — flat, no resonant bump
    hpf._userFreq = 80;           // remembered cutoff when engaged
    hpf._userQ = 0.7071;
    this._hpfOn = false;
    this._hpfSlope = 12;          // 12 or 24 dB/oct
    // second cascaded stage (engaged only for 24 dB/oct)
    const hpf2 = ctx.createBiquadFilter();
    hpf2.type = 'highpass';
    hpf2.frequency.value = 10;
    hpf2.Q.value = 0.7071;

    // --- Low-pass filter --- (starts neutralised; toggle defaults to off)
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 20000;  // neutral: out of the audible band
    lpf.Q.value = 0.7071;
    lpf._userFreq = 18000;
    lpf._userQ = 0.7071;          // Butterworth — flat passband, no reso bump
    this._lpfOn = false;
    this._lpfSlope = 12;
    const lpf2 = ctx.createBiquadFilter();
    lpf2.type = 'lowpass';
    lpf2.frequency.value = 20000;
    lpf2.Q.value = 0.7071;

    // --- Parametric EQ: 4 peaking bands in series, each with its own Q ---
    this.eqBands = EQ_BANDS.map((b) => {
      const band = ctx.createBiquadFilter();
      band.type = 'peaking';
      band.frequency.value = b.freq;
      band.Q.value = 1.0;
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
    maxGain.gain.value = 1; // 0 dB — matches the Maximizer slider's default
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
    // Each filter has a second cascaded stage for the 24 dB/oct option
    // (two Butterworth stages = 24 dB/oct, flat, no resonant bump).
    inputGain.connect(hpf);
    hpf.connect(hpf2);
    hpf2.connect(lpf);
    lpf.connect(lpf2);
    let prev = lpf2;
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
      inputGain, hpf, hpf2, lpf, lpf2, deEss, comp,
      compIn, compWet, compDry, compOut,
      maxGain, limiter, analyser, masterGain,
      meterL, meterR, recordDest,
    };
    this.recordDest = recordDest;
  }

  _buildDeEsser(ctx) {
    const input = ctx.createGain();
    const output = ctx.createGain();

    // Split-band de-esser with a Linkwitz-Riley 4th-order crossover (two
    // cascaded Butterworth biquads per band). LR4 low + high sum flat, so
    // enabling it with no sibilance is transparent (no brightening). The high
    // band is compressed; compressing a band can only ever REDUCE it, so more
    // "amount" always means darker / less sibilance — never brighter.
    const fc = 6500;
    const mk = (type) => {
      const b = ctx.createBiquadFilter();
      b.type = type; b.frequency.value = fc; b.Q.value = 0.7071;
      return b;
    };
    const lp1 = mk('lowpass'), lp2 = mk('lowpass');
    const hp1 = mk('highpass'), hp2 = mk('highpass');

    // Aggressive compressor on the sibilance band ("amount" lowers threshold).
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 12;
    comp.attack.value = 0.001;
    comp.release.value = 0.05;
    comp.knee.value = 6;

    // The DynamicsCompressor adds a small internal latency. Run the low band
    // through a transparent (ratio 1:1) compressor so it gets the SAME latency
    // — otherwise low + high recombine misaligned and comb-filter into a bright
    // peak. Matched latency keeps the LR4 sum flat.
    const lowDelayComp = ctx.createDynamicsCompressor();
    lowDelayComp.threshold.value = 0;
    lowDelayComp.ratio.value = 1;
    lowDelayComp.knee.value = 0;
    lowDelayComp.attack.value = 0.001;
    lowDelayComp.release.value = 0.05;

    // Engaged path = low + comp(high); bypass = clean input when disabled.
    const lowGain = ctx.createGain();  lowGain.gain.value = 0;
    const highGain = ctx.createGain(); highGain.gain.value = 0;
    const bypass = ctx.createGain();   bypass.gain.value = 1;

    input.connect(lp1); lp1.connect(lp2); lp2.connect(lowDelayComp);
    lowDelayComp.connect(lowGain); lowGain.connect(output);
    input.connect(hp1); hp1.connect(hp2); hp2.connect(comp);
    comp.connect(highGain); highGain.connect(output);
    input.connect(bypass); bypass.connect(output);

    return { input, output, lp1, lp2, hp1, hp2, comp, lowDelayComp, lowGain, highGain, bypass, _on: false };
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

  setHPF({ on, freq, q, slope }) {
    const hpf = this.nodes.hpf, hpf2 = this.nodes.hpf2;
    if (!hpf) return;
    if (on !== undefined) this._hpfOn = on;
    if (freq !== undefined) hpf._userFreq = freq;
    if (q !== undefined) hpf._userQ = q;
    if (slope !== undefined) this._hpfSlope = slope;
    const f = hpf._userFreq ?? hpf.frequency.value;
    const qv = hpf._userQ ?? hpf.Q.value;
    // Stage 1 always active when on; neutralise by moving the cutoff out of
    // band (10 Hz). Stage 2 engages only for a 24 dB/oct slope.
    hpf.frequency.value = this._hpfOn ? f : 10;
    hpf.Q.value = qv;
    const stage2 = this._hpfOn && this._hpfSlope === 24;
    hpf2.frequency.value = stage2 ? f : 10;
    hpf2.Q.value = qv;
  }

  setLPF({ on, freq, q, slope }) {
    const lpf = this.nodes.lpf, lpf2 = this.nodes.lpf2;
    if (!lpf) return;
    if (on !== undefined) this._lpfOn = on;
    if (freq !== undefined) lpf._userFreq = freq;
    if (q !== undefined) lpf._userQ = q;
    if (slope !== undefined) this._lpfSlope = slope;
    const f = lpf._userFreq ?? lpf.frequency.value;
    const qv = lpf._userQ ?? lpf.Q.value;
    lpf.frequency.value = this._lpfOn ? f : 20000;
    lpf.Q.value = qv;
    const stage2 = this._lpfOn && this._lpfSlope === 24;
    lpf2.frequency.value = stage2 ? f : 20000;
    lpf2.Q.value = qv;
  }

  setEQBand(index, gainDb) {
    if (this.eqBands[index]) this.eqBands[index].gain.value = gainDb;
  }

  setEQBandFreq(index, freq) {
    if (this.eqBands[index]) this.eqBands[index].frequency.value = freq;
  }

  getEQBandFreq(index) {
    return this.eqBands[index] ? this.eqBands[index].frequency.value : 0;
  }

  getEQBandGain(index) {
    return this.eqBands[index] ? this.eqBands[index].gain.value : 0;
  }

  setEQBandQ(index, q) {
    if (this.eqBands[index]) this.eqBands[index].Q.value = q;
  }

  getEQBandQ(index) {
    return this.eqBands[index] ? this.eqBands[index].Q.value : 1.0;
  }

  resetEQ() {
    this.eqBands.forEach((b) => { b.gain.value = 0; b.Q.value = 1.0; });
  }

  /** True when either filter is engaged (used to draw the filter curve). */
  isFilterActive() { return !!(this._hpfOn || this._lpfOn); }

  /**
   * Combined magnitude response of the *engaged* filters only, computed
   * analytically (RBJ biquad, locked Butterworth Q) rather than via the
   * browser's getFrequencyResponse — guarantees a flat, bump-free curve.
   */
  getFilterResponse(freqArray) {
    const fs = this.ctx ? this.ctx.sampleRate : 48000;
    const Q = 0.7071;
    const n = freqArray.length;
    const total = new Float32Array(n).fill(1);
    const apply = (type, f0) => {
      for (let i = 0; i < n; i++) {
        total[i] *= this._biquadMag(type, f0, Q, freqArray[i], fs);
      }
    };
    if (this._hpfOn && this.nodes.hpf) {
      apply('hp', this.nodes.hpf.frequency.value);
      if (this._hpfSlope === 24) apply('hp', this.nodes.hpf.frequency.value);
    }
    if (this._lpfOn && this.nodes.lpf) {
      apply('lp', this.nodes.lpf.frequency.value);
      if (this._lpfSlope === 24) apply('lp', this.nodes.lpf.frequency.value);
    }
    return total;
  }

  /** Magnitude of an RBJ low/high-pass biquad at frequency f (linear). */
  _biquadMag(type, f0, Q, f, fs) {
    const w0 = 2 * Math.PI * f0 / fs, c = Math.cos(w0), s = Math.sin(w0);
    const alpha = s / (2 * Q);
    let b0, b1, b2;
    const a0 = 1 + alpha, a1 = -2 * c, a2 = 1 - alpha;
    if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    const w = 2 * Math.PI * f / fs;
    const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nRe = b0 + b1 * cw + b2 * c2, nIm = -(b1 * sw + b2 * s2);
    const dRe = a0 + a1 * cw + a2 * c2, dIm = -(a1 * sw + a2 * s2);
    return Math.sqrt((nRe * nRe + nIm * nIm) / (dRe * dRe + dIm * dIm));
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
      // Cross-fade between the split (low + compressed high) path and bypass.
      d.lowGain.gain.setTargetAtTime(on ? 1 : 0, t, 0.01);
      d.highGain.gain.setTargetAtTime(on ? 1 : 0, t, 0.01);
      d.bypass.gain.setTargetAtTime(on ? 0 : 1, t, 0.01);
    }
    if (freq !== undefined) {
      d.lp1.frequency.value = freq; d.lp2.frequency.value = freq;
      d.hp1.frequency.value = freq; d.hp2.frequency.value = freq;
    }
    if (amount !== undefined) {
      // amount (0..40 dB) maps to a lower threshold -> more reduction
      d.comp.threshold.value = -8 - amount;
    }
  }

  setCompressor({ on, threshold, ratio, attack, release, knee }) {
    const c = this.nodes.comp;
    if (!c) return;
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
    if (!this.nodes.maxGain) return;
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

  // ---- Real-time capture (FFmpeg-free export fallback) ----
  // Records the fully-processed signal (post-maximizer, pre master volume —
  // same tap point as renderOffline) straight into Float32 buffers while the
  // video plays. Used when the source container can't be decoded offline
  // (e.g. some iPhone .mov files) so we never need ffmpeg.wasm, which won't
  // load on iOS Safari. Call startCapture(), play the video to the end, then
  // stopCapture() to get the rendered AudioBuffer.
  startCapture() {
    const ctx = this.ctx;
    const tap = this.nodes.limiter;            // fully processed, unity level
    const sp = ctx.createScriptProcessor(4096, 2, 2);
    const left = [], right = [];
    sp.onaudioprocess = (e) => {
      const ib = e.inputBuffer;
      const l = ib.getChannelData(0);
      const r = ib.numberOfChannels > 1 ? ib.getChannelData(1) : l;
      left.push(new Float32Array(l));
      right.push(new Float32Array(r));
    };
    tap.connect(sp);
    // A ScriptProcessor only runs while connected to a destination; route it
    // through a silent gain so capturing adds no extra monitoring sound.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sp.connect(sink);
    sink.connect(ctx.destination);
    this._capture = { sp, sink, tap, left, right, sampleRate: ctx.sampleRate };
  }

  stopCapture() {
    const c = this._capture;
    this._capture = null;
    if (!c) return null;
    c.sp.onaudioprocess = null;
    try { c.tap.disconnect(c.sp); } catch (e) {}
    try { c.sp.disconnect(); } catch (e) {}
    try { c.sink.disconnect(); } catch (e) {}
    const len = c.left.reduce((n, a) => n + a.length, 0);
    if (!len) return null;
    const buf = this.ctx.createBuffer(2, len, c.sampleRate);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let off = 0;
    for (let i = 0; i < c.left.length; i++) {
      L.set(c.left[i], off);
      R.set(c.right[i], off);
      off += c.left[i].length;
    }
    return buf;
  }

  // ---- Offline render (for export) ----
  // Re-creates the current effect chain in an OfflineAudioContext and renders
  // the whole audio buffer through it, using the live parameter values. Faster
  // than real time and sample-accurate (no playback needed).
  async renderOffline(audioBuffer) {
    const oc = new OfflineAudioContext(
      audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
    const src = oc.createBufferSource();
    src.buffer = audioBuffer;
    let node = src;

    const biquad = (type, freq, q, gainDb) => {
      const b = oc.createBiquadFilter();
      b.type = type; b.frequency.value = freq; b.Q.value = q;
      if (gainDb !== undefined) b.gain.value = gainDb;
      node.connect(b); node = b;
    };

    // Filters (mirror slope: one stage for 12, two for 24 dB/oct)
    if (this._hpfOn) {
      const f = this.nodes.hpf._userFreq;
      biquad('highpass', f, 0.7071);
      if (this._hpfSlope === 24) biquad('highpass', f, 0.7071);
    }
    if (this._lpfOn) {
      const f = this.nodes.lpf._userFreq;
      biquad('lowpass', f, 0.7071);
      if (this._lpfSlope === 24) biquad('lowpass', f, 0.7071);
    }
    // EQ (gain 0 bands are transparent)
    this.eqBands.forEach((b) =>
      biquad('peaking', b.frequency.value, b.Q.value, b.gain.value));

    // De-esser (LR4 split-band: low + comp(high)) when engaged. Mirrors the
    // live graph. See _buildDeEsser for the rationale.
    if (this.nodes.deEss && this.nodes.deEss._on) {
      const input = node;
      const out = oc.createGain();
      const fq = this.nodes.deEss.hp1.frequency.value;
      const mk = (type) => {
        const b = oc.createBiquadFilter();
        b.type = type; b.frequency.value = fq; b.Q.value = 0.7071;
        return b;
      };
      const lp1 = mk('lowpass'), lp2 = mk('lowpass');
      const hp1 = mk('highpass'), hp2 = mk('highpass');
      const dc = oc.createDynamicsCompressor();
      const ld = this.nodes.deEss.comp;
      dc.threshold.value = ld.threshold.value; dc.ratio.value = ld.ratio.value;
      dc.attack.value = ld.attack.value; dc.release.value = ld.release.value; dc.knee.value = ld.knee.value;
      // Match the compressor's latency on the low band (see _buildDeEsser).
      const lowDc = oc.createDynamicsCompressor();
      lowDc.threshold.value = 0; lowDc.ratio.value = 1; lowDc.knee.value = 0;
      lowDc.attack.value = 0.001; lowDc.release.value = 0.05;
      input.connect(lp1); lp1.connect(lp2); lp2.connect(lowDc); lowDc.connect(out); // low band
      input.connect(hp1); hp1.connect(hp2); hp2.connect(dc); dc.connect(out);       // comp(high)
      node = out;
    }

    // Compressor
    if (this._compOn) {
      const c = oc.createDynamicsCompressor();
      const lc = this.nodes.comp;
      c.threshold.value = lc.threshold.value; c.ratio.value = lc.ratio.value;
      c.attack.value = lc.attack.value; c.release.value = lc.release.value; c.knee.value = lc.knee.value;
      node.connect(c); node = c;
    }

    // Maximizer gain → soft-clip limiter (same ceiling as live)
    const mg = oc.createGain();
    mg.gain.value = this.nodes.maxGain.gain.value;
    node.connect(mg);
    const lim = oc.createWaveShaper();
    lim.curve = this._makeLimiterCurve(this._ceilingGain);
    lim.oversample = '4x';
    mg.connect(lim);
    lim.connect(oc.destination);

    src.start();
    return oc.startRendering();
  }
}

window.AudioEngine = AudioEngine;
window.EQ_BANDS = EQ_BANDS;
