/*
 * loudness.js
 * ITU-R BS.1770 integrated loudness (LUFS) measurement, true-peak (dBTP)
 * estimation, and export-time normalization to a loudness target with a
 * true-peak ceiling. Produces a 16-bit PCM WAV blob.
 */
(function () {
  // ---- K-weighting (BS.1770), coefficients defined at 48 kHz ----
  const KW_STAGE1_B = [1.53512485958697, -2.69169618940638, 1.19839281085285];
  const KW_STAGE1_A = [1.0, -1.69065929318241, 0.73248077421585];
  const KW_STAGE2_B = [1.0, -2.0, 1.0];
  const KW_STAGE2_A = [1.0, -1.99004745483398, 0.99007225036621];

  function biquad(x, b, a) {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let n = 0; n < x.length; n++) {
      const xn = x[n];
      const yn = b[0] * xn + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
      x2 = x1; x1 = xn; y2 = y1; y1 = yn;
      y[n] = yn;
    }
    return y;
  }

  function kWeight(x) {
    return biquad(biquad(x, KW_STAGE1_B, KW_STAGE1_A), KW_STAGE2_B, KW_STAGE2_A);
  }

  const loudOfZ = (z) => -0.691 + 10 * Math.log10(z);

  /**
   * Integrated loudness (LUFS) of channel arrays sampled at ~48 kHz.
   * channels: array of Float32Array (1 = mono, 2 = stereo).
   */
  function integratedLUFS(channels, fs) {
    const kch = channels.map(kWeight);
    const blockLen = Math.round(0.4 * fs);     // 400 ms blocks
    const step = Math.round(0.1 * fs);         // 75% overlap
    const n = channels[0].length;
    if (n < blockLen) return -Infinity;

    const zs = [];
    for (let start = 0; start + blockLen <= n; start += step) {
      let z = 0;
      for (const c of kch) {                   // channel weight 1.0 (L/R)
        let s = 0;
        for (let i = start; i < start + blockLen; i++) s += c[i] * c[i];
        z += s / blockLen;
      }
      zs.push(z);
    }
    if (!zs.length) return -Infinity;

    // Absolute gate at -70 LUFS
    const abs = zs.filter((z) => z > 0 && loudOfZ(z) >= -70);
    if (!abs.length) return -Infinity;
    // Relative gate at (gated mean - 10 LU)
    const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
    const relThresh = loudOfZ(meanAbs) - 10;
    const rel = abs.filter((z) => loudOfZ(z) >= relThresh);
    const arr = rel.length ? rel : abs;
    const meanRel = arr.reduce((a, b) => a + b, 0) / arr.length;
    return loudOfZ(meanRel);
  }

  // ---- Resample an AudioBuffer to 48 kHz (for accurate K-weighting) ----
  async function resampleChannels(audioBuffer, targetFs) {
    if (audioBuffer.sampleRate === targetFs) {
      const ch = [];
      for (let c = 0; c < audioBuffer.numberOfChannels; c++) ch.push(audioBuffer.getChannelData(c));
      return ch;
    }
    const len = Math.ceil(audioBuffer.duration * targetFs);
    const oc = new OfflineAudioContext(audioBuffer.numberOfChannels, len, targetFs);
    const src = oc.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(oc.destination);
    src.start();
    const r = await oc.startRendering();
    const ch = [];
    for (let c = 0; c < r.numberOfChannels; c++) ch.push(r.getChannelData(c));
    return ch;
  }

  // ---- True peak (dBTP) via 4x oversampling using the browser resampler ----
  async function truePeakDb(audioBuffer) {
    const os = 4;
    const rate = Math.min(audioBuffer.sampleRate * os, 192000);
    const len = Math.ceil(audioBuffer.duration * rate);
    const oc = new OfflineAudioContext(audioBuffer.numberOfChannels, len, rate);
    const src = oc.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(oc.destination);
    src.start();
    const r = await oc.startRendering();
    let peak = 1e-9;
    for (let c = 0; c < r.numberOfChannels; c++) {
      const d = r.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    }
    return 20 * Math.log10(peak);
  }

  function applyGain(audioBuffer, gainDb) {
    const g = Math.pow(10, gainDb / 20);
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const d = audioBuffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
  }

  // ---- 16-bit PCM WAV encoder ----
  function encodeWAV(audioBuffer) {
    const numCh = audioBuffer.numberOfChannels;
    const fs = audioBuffer.sampleRate;
    const len = audioBuffer.length;
    const blockAlign = numCh * 2;
    const dataLen = len * blockAlign;
    const buf = new ArrayBuffer(44 + dataLen);
    const view = new DataView(buf);
    const ws = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE');
    ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true); view.setUint32(24, fs, true);
    view.setUint32(28, fs * blockAlign, true); view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    ws(36, 'data'); view.setUint32(40, dataLen, true);
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(audioBuffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.max(-1, Math.min(1, chans[c][i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /**
   * Decode a recorded blob, normalize it to targetLUFS with a true-peak
   * ceiling, and return { wavBlob, info }.
   */
  async function normalizeBlob(blob, audioCtx, { targetLUFS = -13, ceilingDbTP = -0.5 } = {}) {
    const arr = await blob.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arr);

    // Measure integrated loudness at 48 kHz.
    const ch48 = await resampleChannels(decoded, 48000);
    const inLUFS = integratedLUFS(ch48, 48000);
    if (!isFinite(inLUFS)) {
      return { wavBlob: encodeWAV(decoded), info: { inLUFS: -Infinity, gainDb: 0, outTP: await truePeakDb(decoded), note: 'silent / unmeasurable' } };
    }

    // Loudness gain to hit the target.
    let gainDb = targetLUFS - inLUFS;
    applyGain(decoded, gainDb);

    // True-peak protection: if over ceiling, pull down so peaks are safe.
    let tp = await truePeakDb(decoded);
    if (tp > ceilingDbTP) {
      const reduce = ceilingDbTP - tp;     // negative
      applyGain(decoded, reduce);
      gainDb += reduce;
      tp = ceilingDbTP;
    }

    return {
      wavBlob: encodeWAV(decoded),
      info: { inLUFS, gainDb, outLUFS: targetLUFS + Math.min(0, 0), outTP: tp, targetLUFS, ceilingDbTP },
    };
  }

  const api = { integratedLUFS, kWeight, encodeWAV, normalizeBlob, truePeakDb, resampleChannels };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Loudness = api;
})();
