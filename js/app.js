/*
 * app.js
 * Entry point: wires the UI to the AudioEngine and SpectrumAnalyzer.
 */
(function () {
  const engine = new AudioEngine();
  let analyzer = null;
  let eqNodes = null;
  let currentFileName = '';
  const eqKnobs = [];
  const eqQInputs = [];
  const eqQVals = [];

  // --- Elements ---
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const stage = document.querySelector('.stage');
  const dropZone = document.getElementById('dropZone');
  const playerWrap = document.getElementById('playerWrap');
  const videoEl = document.getElementById('videoEl');
  const playBtn = document.getElementById('playBtn');
  const fileName = document.getElementById('fileName');

  // ---------------------------------------------------------------
  // File loading
  // ---------------------------------------------------------------
  // Push every current control value into the (newly built) audio graph,
  // so any tweaks made before a video was loaded take effect.
  function syncEngineFromUI() {
    document.querySelectorAll('input[type="range"]').forEach((el) => {
      if (el.__update) el.__update();
      else el.dispatchEvent(new Event('input'));
    });
    ['hpfOn', 'lpfOn', 'deEssOn', 'compOn'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.dispatchEvent(new Event('change'));
    });
    eqKnobs.forEach((k, i) => engine.setEQBand(i, k.value));
    // Apply the currently-selected filter slopes.
    document.querySelectorAll('.slope-seg').forEach((seg) => {
      const active = seg.querySelector('.slope-btn.active');
      if (!active) return;
      const slope = parseInt(active.dataset.slope, 10);
      if (seg.dataset.filter === 'hpf') engine.setHPF({ slope });
      else engine.setLPF({ slope });
    });
  }

  // Accept any picked file (so the iOS picker stays fully selectable) but only
  // load real media; gently reject anything else (e.g. a photo).
  function isMediaFile(file) {
    const t = (file.type || '').toLowerCase();
    if (t.startsWith('video/') || t.startsWith('audio/')) return true;
    if (t.startsWith('image/')) return false;
    // type can be empty on iOS — fall back to the extension.
    return /\.(mov|mp4|m4v|m4a|aac|mp3|wav|aif|aiff|caf|webm|ogg|3gp)$/i.test(file.name || '');
  }

  function loadFile(file) {
    if (!file) return;
    if (!isMediaFile(file)) {
      const hint = dropZone.querySelector('.hint');
      if (hint) hint.textContent = 'That’s not a video or audio file — pick a video.';
      return;
    }
    const url = URL.createObjectURL(file);
    videoEl.src = url;
    currentFile = file;
    currentFileName = file.name;
    fileName.textContent = file.name;
    dropZone.classList.add('hidden');
    playerWrap.classList.remove('hidden');
    // Connect to the audio graph once metadata is ready.
    videoEl.addEventListener('loadedmetadata', () => {
      engine.connectMediaElement(videoEl); // builds the audio graph
      syncEngineFromUI();                   // apply current control values
      if (!analyzer) {
        analyzer = new SpectrumAnalyzer(document.getElementById('spectrum'), engine);
        bindAnalyzerControls();
        analyzer.start();
        // Draggable EQ nodes live on top of the spectrum and stay aligned
        // with it via the analyzer's coordinate mapping.
        eqNodes = new EQNodes(document.getElementById('eqNodes'), engine, analyzer, eqKnobs, applyQ);
        analyzer.onLayout = () => eqNodes.layoutAll();
        eqNodes.layoutAll();
      }
      document.getElementById('recordBtn').disabled = false;
    }, { once: true });
  }

  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));
  // Clicking the filename in the analyzer overlay lets you swap the file.
  fileName.addEventListener('click', () => fileInput.click());

  // Drag-and-drop works over the whole stage, before and after loading.
  ['dragover', 'dragenter'].forEach((ev) =>
    stage.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    stage.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    })
  );
  stage.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  // ---------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------
  playBtn.addEventListener('click', () => {
    engine.ensureContext();
    if (videoEl.paused) videoEl.play();
    else videoEl.pause();
  });
  videoEl.addEventListener('play', () => {
    // Resume the graph no matter which control started playback, so the
    // analyzer always reacts to the audio (autoplay policy can leave the
    // AudioContext suspended otherwise — especially on iOS).
    engine.ensureContext();
    playBtn.textContent = '⏸';
  });
  videoEl.addEventListener('pause', () => { playBtn.textContent = '▶'; });

  // The bottom slider is the Maximizer: it drives makeup gain into the
  // soft-clip limiter, so pushing right raises loudness while the fixed
  // ceiling (-0.3 dB, set when the graph is built) holds the peaks.
  // Show the dB plus the equivalent % increase in level (gain factor - 1).
  function fmtMaximizer(v) {
    const pct = Math.round((Math.pow(10, v / 20) - 1) * 100);
    return `+${v.toFixed(1)} dB · +${pct}%`;
  }
  UI.bindRange('maximizer', 'maximizerVal', (v) => engine.setMaximizer({ gainDb: v }), fmtMaximizer);

  // ---------------------------------------------------------------
  // EQ — each band: a gain knob + its own compact Q slider
  // ---------------------------------------------------------------
  // Apply a band's Q from anywhere (slider, node scroll, preset, reset)
  // and keep the slider + its label in sync.
  function applyQ(i, v) {
    v = Math.max(1, Math.min(5, Math.round(v * 10) / 10));
    engine.setEQBandQ(i, v);
    if (eqQInputs[i]) eqQInputs[i].value = v;
    if (eqQVals[i]) eqQVals[i].textContent = v.toFixed(1);
  }

  function buildEQ() {
    const wrap = document.getElementById('eqKnobs');
    EQ_BANDS.forEach((band, i) => {
      const col = document.createElement('div');
      col.className = 'eq-band';

      // Gain knob
      const g = document.createElement('div');
      g.className = 'knob';
      g.dataset.min = -10; g.dataset.max = 10; g.dataset.step = 0.5;
      g.dataset.value = 0; g.dataset.default = 0;
      g.innerHTML = `
        <div class="knob-dial"><div class="knob-pointer"></div></div>
        <span class="knob-label">${band.label}</span>
        <span class="knob-sub">${UI.fmtHz(band.freq)}</span>
        <span class="knob-val">0.0 dB</span>`;
      col.appendChild(g);

      // Per-band Q slider (compact, keeps the page static)
      const qRow = document.createElement('div');
      qRow.className = 'eq-q-row';
      const qLabel = document.createElement('span');
      qLabel.className = 'eq-q-label';
      qLabel.textContent = 'Q';
      const qInput = document.createElement('input');
      qInput.type = 'range';
      qInput.min = 1; qInput.max = 5; qInput.step = 0.1; qInput.value = 1.0;
      const qVal = document.createElement('span');
      qVal.className = 'eq-q-val';
      qVal.textContent = '1.0';
      qRow.append(qLabel, qInput, qVal);
      col.appendChild(qRow);

      wrap.appendChild(col);

      const gainKnob = new Knob(g, (v) => {
        engine.setEQBand(i, v);
        if (eqNodes) eqNodes.layout(i);   // keep the analyzer node in sync
      });
      gainKnob.setFormatter(UI.fmtDb);
      eqKnobs.push(gainKnob);

      eqQInputs.push(qInput);
      eqQVals.push(qVal);
      qInput.addEventListener('input', () => applyQ(i, parseFloat(qInput.value)));
    });
  }

  document.getElementById('eqReset').addEventListener('click', () => {
    eqKnobs.forEach((k) => k.set(0, true));
    eqQInputs.forEach((_, i) => applyQ(i, 1.0));
  });

  // ---------------------------------------------------------------
  // Draggable EQ nodes on the analyzer (two-way synced with the knobs)
  //   horizontal drag = pick frequency, vertical drag = boost / cut
  // ---------------------------------------------------------------
  class EQNodes {
    constructor(container, engine, analyzer, knobs, setQ) {
      this.container = container;
      this.engine = engine;
      this.analyzer = analyzer;
      this.knobs = knobs;
      this.setQ = setQ;
      this.handles = EQ_BANDS.map((band, i) => {
        const h = document.createElement('div');
        h.className = 'eq-node';
        h.textContent = String(i + 1);
        const tip = document.createElement('span');
        tip.className = 'eq-node-tip';
        h.appendChild(tip);
        h._tip = tip;
        container.appendChild(h);
        this._attachDrag(h, i);
        return h;
      });
    }

    layout(i) {
      const h = this.handles[i];
      const freq = this.engine.getEQBandFreq(i);
      const gain = this.engine.getEQBandGain(i);
      h.style.left = this.analyzer.freqToX(freq) + 'px';
      h.style.top = this.analyzer.gainToY(gain) + 'px';
      h._tip.textContent = `${UI.fmtHz(freq)}  ${UI.fmtDb(gain)}`;
      // Reflect the (now movable) frequency on the matching knob label.
      const sub = this.knobs[i] && this.knobs[i].el.querySelector('.knob-sub');
      if (sub) sub.textContent = UI.fmtHz(freq);
    }

    layoutAll() { this.handles.forEach((_, i) => this.layout(i)); }

    _attachDrag(h, i) {
      const move = (clientX, clientY) => {
        const rect = this.container.getBoundingClientRect();
        let freq = Math.round(this.analyzer.xToFreq(clientX - rect.left));
        let gain = Math.round(this.analyzer.yToGain(clientY - rect.top) * 2) / 2;
        freq = Math.max(20, Math.min(20000, freq));
        gain = Math.max(-10, Math.min(10, gain));
        this.engine.setEQBandFreq(i, freq);
        this.engine.setEQBand(i, gain);
        if (this.knobs[i]) this.knobs[i].set(gain, false); // sync knob, no feedback
        this.layout(i);
      };
      const down = (e) => {
        h.classList.add('dragging');
        const onMove = (ev) => {
          const t = ev.touches ? ev.touches[0] : ev;
          move(t.clientX, t.clientY);
          ev.preventDefault();
        };
        const onUp = () => {
          h.classList.remove('dragging');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          window.removeEventListener('touchmove', onMove);
          window.removeEventListener('touchend', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);
        e.preventDefault();
      };
      h.addEventListener('mousedown', down);
      h.addEventListener('touchstart', down, { passive: false });
      // scroll over a node to tighten / widen its Q (bandwidth)
      h.addEventListener('wheel', (e) => {
        this.setQ(i, this.engine.getEQBandQ(i) + (e.deltaY < 0 ? 0.1 : -0.1));
        e.preventDefault();
      }, { passive: false });
      // double-tap resets this band's gain (keeps the chosen frequency)
      h.addEventListener('dblclick', () => {
        this.engine.setEQBand(i, 0);
        if (this.knobs[i]) this.knobs[i].set(0, false);
        this.layout(i);
      });
    }
  }

  // ---------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------
  UI.bindCheckbox('hpfOn', (on) => engine.setHPF({ on }));
  UI.bindRange('hpfFreq', 'hpfFreqVal', (v) => engine.setHPF({ freq: v }), UI.fmtHz);
  UI.bindCheckbox('lpfOn', (on) => engine.setLPF({ on }));
  UI.bindRange('lpfFreq', 'lpfFreqVal', (v) => engine.setLPF({ freq: v }), UI.fmtHz);

  // Filter slope selectors (−12 vs −24 dB/oct)
  document.querySelectorAll('.slope-seg').forEach((seg) => {
    const which = seg.dataset.filter; // 'hpf' | 'lpf'
    seg.querySelectorAll('.slope-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        seg.querySelectorAll('.slope-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const slope = parseInt(btn.dataset.slope, 10);
        if (which === 'hpf') engine.setHPF({ slope });
        else engine.setLPF({ slope });
      });
    });
  });

  // ---------------------------------------------------------------
  // De-Esser
  // ---------------------------------------------------------------
  UI.bindCheckbox('deEssOn', (on) => engine.setDeEsser({ on }));
  UI.bindRange('deEssFreq', 'deEssFreqVal', (v) => engine.setDeEsser({ freq: v }), UI.fmtHz);
  UI.bindRange('deEssAmount', 'deEssAmountVal', (v) => engine.setDeEsser({ amount: v }), fmtDbAmt);
  function fmtDbAmt(v) { return Math.round(v) + ' dB'; }

  // ---------------------------------------------------------------
  // Compressor + Maximizer
  // ---------------------------------------------------------------
  UI.bindCheckbox('compOn', (on) => engine.setCompressor({ on }));
  UI.bindRange('compThreshold', 'compThresholdVal', (v) => engine.setCompressor({ threshold: v }), UI.fmtDbInt);
  UI.bindRange('compRatio', 'compRatioVal', (v) => engine.setCompressor({ ratio: v }), UI.fmtRatio);
  UI.bindRange('compAttack', 'compAttackVal', (v) => engine.setCompressor({ attack: v }), UI.fmtMs);
  UI.bindRange('compRelease', 'compReleaseVal', (v) => engine.setCompressor({ release: v }), UI.fmtMs);
  UI.bindRange('compKnee', 'compKneeVal', (v) => engine.setCompressor({ knee: v }), fmtKnee);
  // 0 dB = a sharp "hard knee"; 20 dB+ = a gentle "soft knee".
  function fmtKnee(v) {
    const lbl = v <= 0 ? 'Hard' : v >= 20 ? 'Soft' : '';
    return lbl ? `${lbl} · ${v} dB` : `${v} dB`;
  }

  // ---------------------------------------------------------------
  // Gain-reduction meters (driven from a small RAF loop)
  // ---------------------------------------------------------------
  function meterLoop() {
    const compGr = document.getElementById('compGr');
    const deEssGr = document.getElementById('deEssGr');
    if (engine.nodes.comp) {
      const r = Math.min(20, -engine.getCompReduction());
      compGr.style.width = (r / 20 * 100) + '%';
    }
    if (engine.nodes.deEss) {
      const r = Math.min(20, -engine.getDeEssReduction());
      deEssGr.style.width = (r / 20 * 100) + '%';
    }
    requestAnimationFrame(meterLoop);
  }
  requestAnimationFrame(meterLoop);

  // ---------------------------------------------------------------
  // Analyzer view controls
  // ---------------------------------------------------------------
  function bindAnalyzerControls() {
    const modeSel = document.getElementById('analyzerMode');
    const scaleSel = document.getElementById('analyzerScale');
    modeSel.addEventListener('change', () => analyzer.setMode(modeSel.value));
    scaleSel.addEventListener('change', () => analyzer.setScale(scaleSel.value));
    analyzer.setMode(modeSel.value);
    analyzer.setScale(scaleSel.value);
  }

  // ---------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------
  const PRESETS = {
    flat: {
      eq: [0, 0, 0, 0], q: 1.5,
      hpf: { on: false }, lpf: { on: false },
      deEss: { on: false }, comp: { on: false },
      max: { gain: 0, ceiling: -0.3 },
    },
    voice: {
      eq: [-3, 1, 3, 2], q: 1.4,
      hpf: { on: true, freq: 90 }, lpf: { on: false },
      deEss: { on: true, freq: 6500, amount: 14 },
      comp: { on: true, threshold: -22, ratio: 4, attack: 8, release: 180, knee: 24 },
      max: { gain: 4, ceiling: -0.3 },
    },
    podcast: {
      eq: [2, 1, 1, -1], q: 1.2,
      hpf: { on: true, freq: 75 }, lpf: { on: true, freq: 14000 },
      deEss: { on: true, freq: 6000, amount: 16 },
      comp: { on: true, threshold: -26, ratio: 5, attack: 12, release: 220, knee: 28 },
      max: { gain: 5, ceiling: -0.5 },
    },
    bright: {
      eq: [-1, -1, 3, 6], q: 2.0,
      hpf: { on: true, freq: 100 }, lpf: { on: false },
      deEss: { on: true, freq: 7000, amount: 10 },
      comp: { on: true, threshold: -28, ratio: 6, attack: 5, release: 150, knee: 18 },
      max: { gain: 7, ceiling: -0.2 },
    },
    music: {
      eq: [3, -1, 1, 3], q: 1.0,
      hpf: { on: false }, lpf: { on: false },
      deEss: { on: false },
      comp: { on: true, threshold: -20, ratio: 2.5, attack: 20, release: 300, knee: 30 },
      max: { gain: 3, ceiling: -0.3 },
    },
  };

  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    // EQ
    p.eq.forEach((g, i) => eqKnobs[i] && eqKnobs[i].set(g, true));
    if (p.q != null) eqQInputs.forEach((_, i) => applyQ(i, p.q));
    // HPF
    setControl('hpfOn', p.hpf.on);
    if (p.hpf.freq != null) setControl('hpfFreq', p.hpf.freq);
    // LPF
    setControl('lpfOn', p.lpf.on);
    if (p.lpf.freq != null) setControl('lpfFreq', p.lpf.freq);
    // De-esser
    setControl('deEssOn', p.deEss.on);
    if (p.deEss.freq != null) setControl('deEssFreq', p.deEss.freq);
    if (p.deEss.amount != null) setControl('deEssAmount', p.deEss.amount);
    // Compressor
    setControl('compOn', p.comp.on);
    ['threshold', 'ratio', 'attack', 'release', 'knee'].forEach((k) => {
      if (p.comp[k] != null) setControl('comp' + cap(k), p.comp[k]);
    });
    // Maximizer (bottom slider); ceiling stays fixed
    setControl('maximizer', p.max.gain);
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function setControl(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') {
      el.checked = !!value;
      el.dispatchEvent(new Event('change'));
    } else {
      el.value = value;
      if (el.__update) el.__update();
      else el.dispatchEvent(new Event('input'));
    }
  }

  document.getElementById('presetSelect').addEventListener('change', (e) => {
    if (e.target.value) applyPreset(e.target.value);
  });

  // ---------------------------------------------------------------
  // Tab switching (one effect module visible at a time)
  // ---------------------------------------------------------------
  const tabs = document.querySelectorAll('.tab');
  const views = document.querySelectorAll('.module-view');
  function showTab(name) {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    views.forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  }
  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  showTab('eq');

  // Reflect each module's enabled state as a dot on its tab.
  function syncTabDot(tabName, on) {
    const tab = document.querySelector(`.tab[data-tab="${tabName}"]`);
    if (tab) tab.classList.toggle('tab-enabled', on);
  }
  const deEssOnEl = document.getElementById('deEssOn');
  const compOnEl = document.getElementById('compOn');
  const hpfOnEl = document.getElementById('hpfOn');
  const lpfOnEl = document.getElementById('lpfOn');
  function refreshDots() {
    syncTabDot('deesser', deEssOnEl.checked);
    syncTabDot('comp', compOnEl.checked);
    syncTabDot('filters', hpfOnEl.checked || lpfOnEl.checked);
  }
  [deEssOnEl, compOnEl, hpfOnEl, lpfOnEl].forEach((el) =>
    el.addEventListener('change', refreshDots));
  refreshDots();

  // ---------------------------------------------------------------
  // Recording the processed mix
  // ---------------------------------------------------------------
  const exportBtn = document.getElementById('recordBtn');   // now the Export button
  const downloadLink = document.getElementById('downloadLink');
  let currentFile = null;     // the loaded File, decoded for the audio export
  let exporting = false;

  // Transient status shown in the analyzer's filename slot.
  let statusTimer = null;
  function setStatus(msg, restoreMs) {
    const el = document.getElementById('fileName');
    if (!el) return;
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    el.textContent = msg;
    if (restoreMs) statusTimer = setTimeout(() => { el.textContent = currentFileName; }, restoreMs);
  }

  // Full export pipeline: decode original audio → render the effect chain
  // offline → normalize to −13 LUFS / −0.5 dBTP → export as a mastered WAV.
  //
  // Note: we intentionally do NOT bake the audio back into the video here.
  // In-browser muxing (ffmpeg.wasm) is unreliable on iOS Safari, so for now we
  // ship the reliable mastered-audio export. Baked-in video will be done
  // natively (AVFoundation) in the store app. The mux path is still present in
  // videoExport.js so we can pick that work back up later.
  exportBtn.addEventListener('click', async () => {
    if (exporting || !currentFile) return;
    exporting = true;
    exportBtn.disabled = true;
    downloadLink.classList.add('hidden');
    try {
      let processed;
      try {
        // Fast path: decode the source offline and render the chain.
        setStatus('Decoding audio…');
        const decoded = await decodeOriginalAudio(currentFile);
        setStatus('Rendering effects…');
        processed = await engine.renderOffline(decoded);
      } catch (decodeErr) {
        // The browser couldn't decode this container (common for iPhone .mov).
        // Fall back to a real-time capture of the live processed graph — no
        // ffmpeg.wasm, so it works on iOS Safari.
        console.warn('Offline decode failed; capturing in real time:', decodeErr);
        processed = await captureProcessedRealtime((r) =>
          setStatus(`Capturing audio (real-time)… ${Math.round((r || 0) * 100)}%`));
      }

      setStatus('Normalizing to −13 LUFS…');
      const norm = await Loudness.normalizeAudioBuffer(processed,
        { targetLUFS: -13, ceilingDbTP: -0.5 });
      const info = norm.info;
      const wavBlob = Loudness.encodeWAV(norm.buffer);

      downloadLink.href = URL.createObjectURL(wavBlob);
      downloadLink.download = 'ukemaster-mix-13LUFS.wav';
      downloadLink.title = `Mastered audio −13 LUFS / −0.5 dBTP `
        + `(measured ${info.inLUFS.toFixed(1)} LUFS, ${info.gainDb >= 0 ? '+' : ''}`
        + `${info.gainDb.toFixed(1)} dB, peak ${info.outTP.toFixed(1)} dBTP)`;
      downloadLink.classList.remove('hidden');
      setStatus(`✓ Audio ready: −13 LUFS · peak ${info.outTP.toFixed(1)} dBTP`, 9000);
    } catch (err) {
      console.error('Export error:', err);
      const msg = (err && err.message) ? err.message : String(err);
      setStatus('Export failed: ' + msg, 12000);
    }
    exportBtn.disabled = false;
    exporting = false;
  });

  // Decode the original file's audio offline. Two tiers, fast → robust:
  //   1. Browser decodeAudioData on the raw file (works for most files).
  //   2. mp4box.js demux of just the AAC track → decode that (handles iPhone
  //      .mov, whose HEVC video track makes Safari refuse the whole file).
  // Throws if both fail — the caller then falls back to real-time capture.
  async function decodeOriginalAudio(file) {
    try {
      const buf = await file.arrayBuffer();
      return await engine.ctx.decodeAudioData(buf.slice(0));
    } catch (e1) {
      const aac = await AudioDemux.extractAAC(file, { onStatus: setStatus });
      const ab = await aac.arrayBuffer();
      return await engine.ctx.decodeAudioData(ab);
    }
  }

  // Real-time export fallback: play the video from the start through the live
  // effect chain and capture the fully-processed audio into an AudioBuffer.
  // Takes as long as the clip itself, but needs no decoder/FFmpeg, so it works
  // on iOS Safari for files the browser can't decode offline.
  async function captureProcessedRealtime(onProgress) {
    engine.ensureContext();
    videoEl.pause();
    // Rewind to the start and wait for the seek to settle.
    try { videoEl.currentTime = 0; } catch (e) {}
    await new Promise((res) => {
      if (videoEl.currentTime === 0 && videoEl.readyState >= 2) return res();
      const onSeeked = () => { videoEl.removeEventListener('seeked', onSeeked); res(); };
      videoEl.addEventListener('seeked', onSeeked);
      setTimeout(res, 400);
    });

    engine.startCapture();
    const ended = new Promise((res) => {
      const onEnded = () => { videoEl.removeEventListener('ended', onEnded); res(); };
      videoEl.addEventListener('ended', onEnded);
    });
    let prog = null;
    if (onProgress) {
      prog = setInterval(() => {
        if (videoEl.duration) onProgress(videoEl.currentTime / videoEl.duration);
      }, 250);
    }
    try {
      await videoEl.play();
      await ended;
    } finally {
      if (prog) clearInterval(prog);
    }
    const buf = engine.stopCapture();
    if (!buf || buf.length === 0) throw new Error('Real-time capture produced no audio');
    return buf;
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  buildEQ();
})();
