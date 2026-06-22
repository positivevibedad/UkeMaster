/*
 * deEsserWorklet.js — AudioWorklet de-esser processor.
 *
 * Sample-accurate split-band de-esser with no node-graph latency, so it can
 * never comb-filter or brighten (the failure mode of the node-based versions).
 *
 * Per sample:
 *   high = highpass(input)            // 2nd-order Butterworth, RBJ coeffs
 *   env  = attack/release envelope of |high|
 *   g    = downward gain (<=1) when env exceeds the threshold, else 1
 *   out  = (input - high) + g * high  = input - (1 - g) * high
 *
 * When there's no sibilance, g == 1 and out == input exactly (transparent).
 * When sibilance exceeds the threshold, only the high band is pulled down —
 * the result can only ever get darker, never brighter.
 */
class DeEsserProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'freq', defaultValue: 6500, minValue: 1000, maxValue: 16000, automationRate: 'k-rate' },
      { name: 'amount', defaultValue: 12, minValue: 0, maxValue: 40, automationRate: 'k-rate' },
      { name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.sr = sampleRate;
    this.hp = [];     // per-channel biquad state {x1,x2,y1,y2}
    this.env = [];    // per-channel envelope
    this._freq = 0;
    this.attCoef = Math.exp(-1 / (0.001 * this.sr)); // 1 ms attack
    this.relCoef = Math.exp(-1 / (0.050 * this.sr)); // 50 ms release
    this._gr = 0;     // smoothed gain reduction (dB) for metering
    this._frame = 0;
    this._calc(6500);
  }

  _calc(freq) {
    const w0 = 2 * Math.PI * freq / this.sr;
    const cosw = Math.cos(w0), sinw = Math.sin(w0);
    const Q = 0.7071;
    const alpha = sinw / (2 * Q);
    const a0 = 1 + alpha;
    this.b0 = ((1 + cosw) / 2) / a0;
    this.b1 = (-(1 + cosw)) / a0;
    this.b2 = ((1 + cosw) / 2) / a0;
    this.a1 = (-2 * cosw) / a0;
    this.a2 = (1 - alpha) / a0;
    this._freq = freq;
  }

  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;

    const enabled = params.enabled[0] > 0.5;
    const freq = params.freq[0];
    const amount = params.amount[0];
    if (freq !== this._freq) this._calc(freq);

    const threshold = Math.pow(10, (-8 - amount) / 20); // amount lowers threshold
    const ratio = 10;
    const nch = input.length;
    let blockGR = 0;

    for (let ch = 0; ch < nch; ch++) {
      const x = input[ch];
      const y = output[ch];
      if (!x) continue;
      if (!enabled) { y.set(x); continue; }
      if (!this.hp[ch]) this.hp[ch] = { x1: 0, x2: 0, y1: 0, y2: 0 };
      if (this.env[ch] === undefined) this.env[ch] = 0;
      const st = this.hp[ch];
      let env = this.env[ch];

      for (let i = 0; i < x.length; i++) {
        const xn = x[i];
        // 2nd-order highpass (Direct Form I)
        const hn = this.b0 * xn + this.b1 * st.x1 + this.b2 * st.x2
                 - this.a1 * st.y1 - this.a2 * st.y2;
        st.x2 = st.x1; st.x1 = xn; st.y2 = st.y1; st.y1 = hn;
        // envelope follower on the high band
        const rect = hn < 0 ? -hn : hn;
        const coef = rect > env ? this.attCoef : this.relCoef;
        env = rect + coef * (env - rect);
        // downward gain on the high band
        let g = 1;
        if (env > threshold) {
          const overDb = 20 * Math.log10(env / threshold);
          const grDb = overDb * (1 - 1 / ratio);
          g = Math.pow(10, -grDb / 20);
          if (grDb > blockGR) blockGR = grDb;
        }
        y[i] = (xn - hn) + g * hn;
      }
      this.env[ch] = env;
    }

    // Report gain reduction (negative dB) to the main thread for the meter.
    this._gr = Math.max(this._gr * 0.85, blockGR);
    if ((this._frame++ & 7) === 0) this.port.postMessage({ reduction: -this._gr });

    return true;
  }
}

registerProcessor('de-esser', DeEsserProcessor);
