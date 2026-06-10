/*
 * analyzer.js
 * Renders the real-time spectrum analyzer and L/R level meters onto a canvas.
 */

class SpectrumAnalyzer {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.engine = engine;
    this.mode = 'both';     // 'bars' | 'line' | 'both'
    this.scale = 'log';     // 'log' | 'linear'
    this.running = false;
    this.peaks = null;      // per-bar peak hold
    this.peakDecay = 0.9;
    this._resize = this._resize.bind(this);
    this._frame = this._frame.bind(this);
    window.addEventListener('resize', this._resize);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
    if (this.onLayout) this.onLayout();
  }

  start() {
    if (this.running) return;
    this._resize();
    this.running = true;
    requestAnimationFrame(this._frame);
  }

  stop() { this.running = false; }

  setMode(m) { this.mode = m; }
  setScale(s) { this.scale = s; this.peaks = null; if (this.onLayout) this.onLayout(); }

  // ---- Coordinate mapping (shared with the draggable EQ nodes) ----
  _range() {
    const nyquist = this.engine.ctx ? this.engine.ctx.sampleRate / 2 : 24000;
    return { minF: 20, maxF: Math.min(nyquist, 20000) };
  }
  freqToX(freq) {
    const { minF, maxF } = this._range();
    const f = Math.max(minF, Math.min(maxF, freq));
    const frac = this.scale === 'log'
      ? Math.log(f / minF) / Math.log(maxF / minF)
      : (f - minF) / (maxF - minF);
    return frac * this.w;
  }
  xToFreq(x) {
    const { minF, maxF } = this._range();
    const frac = Math.max(0, Math.min(1, x / this.w));
    return this.scale === 'log'
      ? minF * Math.pow(maxF / minF, frac)
      : minF + (maxF - minF) * frac;
  }
  // Gain axis: +/-15 dB, 0 dB at vertical centre (matches the EQ curve).
  gainToY(db) { return this.h / 2 - (db / 15) * (this.h / 2 - 6); }
  yToGain(y) { return ((this.h / 2 - y) / (this.h / 2 - 6)) * 15; }

  _frame() {
    if (!this.running) return;
    this._draw();
    this._drawMeters();
    requestAnimationFrame(this._frame);
  }

  _draw() {
    const ctx = this.ctx2d;
    const analyser = this.engine.nodes.analyser;
    const w = this.w, h = this.h;

    // Background
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0c1118');
    bg.addColorStop(1, '#070a0f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    if (!analyser) return;

    const binCount = analyser.frequencyBinCount;
    const data = new Uint8Array(binCount);
    analyser.getByteFrequencyData(data);
    const sampleRate = this.engine.ctx ? this.engine.ctx.sampleRate : 48000;
    const nyquist = sampleRate / 2;

    this._drawGrid(ctx, w, h, nyquist);

    const barCount = Math.max(32, Math.min(96, Math.floor(w / 9)));
    if (!this.peaks || this.peaks.length !== barCount) {
      this.peaks = new Float32Array(barCount);
    }

    const minF = 20;
    const maxF = Math.min(nyquist, 20000);
    const gap = 2;
    const barW = (w - gap * (barCount - 1)) / barCount;

    // Build line path values too
    const linePts = [];

    for (let i = 0; i < barCount; i++) {
      // Frequency range for this bar
      let f0, f1;
      if (this.scale === 'log') {
        f0 = minF * Math.pow(maxF / minF, i / barCount);
        f1 = minF * Math.pow(maxF / minF, (i + 1) / barCount);
      } else {
        f0 = minF + (maxF - minF) * (i / barCount);
        f1 = minF + (maxF - minF) * ((i + 1) / barCount);
      }
      const b0 = Math.floor((f0 / nyquist) * binCount);
      const b1 = Math.max(b0 + 1, Math.floor((f1 / nyquist) * binCount));

      // Peak magnitude within the band
      let mag = 0;
      for (let b = b0; b < b1 && b < binCount; b++) {
        if (data[b] > mag) mag = data[b];
      }
      const norm = mag / 255; // 0..1
      const barH = norm * (h - 4);
      const x = i * (barW + gap);
      const y = h - barH;

      if (this.mode === 'bars' || this.mode === 'both') {
        const grad = ctx.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, '#1fd1a0');
        grad.addColorStop(0.55, '#3ad6ff');
        grad.addColorStop(0.82, '#f5d142');
        grad.addColorStop(1, '#ff5a6e');
        ctx.fillStyle = grad;
        this._roundRectTop(ctx, x, y, barW, barH, Math.min(3, barW / 2));
        ctx.fill();
      }

      // Peak hold
      const peakY = h - this.peaks[i] * (h - 4);
      if (norm > this.peaks[i]) this.peaks[i] = norm;
      else this.peaks[i] *= this.peakDecay;

      if (this.mode === 'both') {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(x, h - this.peaks[i] * (h - 4) - 2, barW, 2);
      }

      linePts.push([x + barW / 2, y]);
    }

    // Live EQ response curve overlaid on the spectrum
    this._drawEQCurve(ctx, w, h, nyquist);

    if (this.mode === 'line') {
      ctx.beginPath();
      linePts.forEach((p, idx) => {
        if (idx === 0) ctx.moveTo(p[0], p[1]);
        else ctx.lineTo(p[0], p[1]);
      });
      ctx.lineWidth = 2;
      const lg = ctx.createLinearGradient(0, 0, w, 0);
      lg.addColorStop(0, '#1fd1a0');
      lg.addColorStop(0.5, '#3ad6ff');
      lg.addColorStop(1, '#ff5a6e');
      ctx.strokeStyle = lg;
      ctx.stroke();
      // soft fill under line
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = 'rgba(58,214,255,0.08)';
      ctx.fill();
    }
  }

  /**
   * Draws the combined EQ frequency response as a live curve. Reads the
   * actual biquad nodes each frame, so it tracks knob moves in real time.
   */
  _drawEQCurve(ctx, w, h, nyquist) {
    if (!this.engine.getEQResponse) return;
    const minF = 20, maxF = Math.min(nyquist, 20000);
    const steps = Math.min(256, Math.floor(w));
    const freqs = new Float32Array(steps);
    const xs = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
      const frac = i / (steps - 1);
      let f, x;
      if (this.scale === 'log') {
        f = minF * Math.pow(maxF / minF, frac);
        x = frac * w;
      } else {
        f = minF + (maxF - minF) * frac;
        x = frac * w;
      }
      freqs[i] = f;
      xs[i] = x;
    }
    const mag = this.engine.getEQResponse(freqs);

    // Map +/-15 dB onto the canvas height, 0 dB at vertical centre.
    const dbRange = 15;
    const mid = h / 2;
    ctx.save();
    ctx.beginPath();
    let active = false;
    for (let i = 0; i < steps; i++) {
      const db = 20 * Math.log10(mag[i] + 1e-9);
      if (Math.abs(db) > 0.1) active = true;
      const y = mid - (db / dbRange) * (h / 2 - 6);
      if (i === 0) ctx.moveTo(xs[i], y);
      else ctx.lineTo(xs[i], y);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = active ? 'rgba(255,158,77,0.95)' : 'rgba(255,158,77,0.35)';
    ctx.shadowColor = 'rgba(255,158,77,0.6)';
    ctx.shadowBlur = active ? 8 : 0;
    ctx.stroke();
    ctx.restore();

    // 0 dB reference line for the EQ curve
    ctx.save();
    ctx.strokeStyle = 'rgba(255,158,77,0.15)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    ctx.restore();
  }

  _drawGrid(ctx, w, h, nyquist) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.lineWidth = 1;
    const marks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    const minF = 20, maxF = Math.min(nyquist, 20000);
    marks.forEach((f) => {
      if (f < minF || f > maxF) return;
      let x;
      if (this.scale === 'log') {
        x = (Math.log(f / minF) / Math.log(maxF / minF)) * w;
      } else {
        x = ((f - minF) / (maxF - minF)) * w;
      }
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      const label = f >= 1000 ? (f / 1000) + 'k' : '' + f;
      ctx.fillText(label, x + 3, h - 5);
    });
    // horizontal dB-ish lines
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  _roundRectTop(ctx, x, y, w, h, r) {
    r = Math.min(r, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }

  _drawMeters() {
    const { meterL, meterR } = this.engine.nodes;
    if (!meterL || !meterR) return;
    const lEl = document.getElementById('meterL');
    const rEl = document.getElementById('meterR');
    const rms = (analyser) => {
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const r = Math.sqrt(sum / buf.length);
      // map to 0..100% with a dB-ish curve
      const db = 20 * Math.log10(r + 1e-6);
      return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    };
    if (lEl) lEl.style.height = rms(meterL) + '%';
    if (rEl) rEl.style.height = rms(meterR) + '%';
  }
}

window.SpectrumAnalyzer = SpectrumAnalyzer;
