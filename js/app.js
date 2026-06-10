/*
 * app.js
 * Entry point: wires the UI to the AudioEngine and SpectrumAnalyzer.
 */
(function () {
  const engine = new AudioEngine();
  let analyzer = null;
  let eqNodes = null;
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
  function loadFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    videoEl.src = url;
    fileName.textContent = file.name;
    dropZone.classList.add('hidden');
    playerWrap.classList.remove('hidden');
    // Connect to the audio graph once metadata is ready.
    videoEl.addEventListener('loadedmetadata', () => {
      engine.connectMediaElement(videoEl);
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

  UI.bindRange('masterGain', null, (v) => engine.setMasterGain(v));

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
      g.dataset.min = -15; g.dataset.max = 15; g.dataset.step = 0.5;
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
      qInput.min = 1; qInput.max = 5; qInput.step = 0.1; qInput.value = 1.5;
      const qVal = document.createElement('span');
      qVal.className = 'eq-q-val';
      qVal.textContent = '1.5';
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
    eqQInputs.forEach((_, i) => applyQ(i, 1.5));
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
        gain = Math.max(-15, Math.min(15, gain));
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
  UI.bindRange('hpfQ', 'hpfQVal', (v) => engine.setHPF({ q: v }), UI.fmtNum);
  UI.bindCheckbox('lpfOn', (on) => engine.setLPF({ on }));
  UI.bindRange('lpfFreq', 'lpfFreqVal', (v) => engine.setLPF({ freq: v }), UI.fmtHz);
  UI.bindRange('lpfQ', 'lpfQVal', (v) => engine.setLPF({ q: v }), UI.fmtNum);

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
  UI.bindRange('compKnee', 'compKneeVal', (v) => engine.setCompressor({ knee: v }), UI.fmtDbInt);
  UI.bindRange('maxGain', 'maxGainVal', (v) => engine.setMaximizer({ gainDb: v }), UI.fmtDb);
  UI.bindRange('maxCeiling', 'maxCeilingVal', (v) => engine.setMaximizer({ ceilingDb: v }), UI.fmtDb);

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
    // Maximizer
    setControl('maxGain', p.max.gain);
    setControl('maxCeiling', p.max.ceiling);
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
  let recorder = null, chunks = [];
  const recordBtn = document.getElementById('recordBtn');
  const downloadLink = document.getElementById('downloadLink');

  recordBtn.addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }
    const stream = engine.getRecordStream();
    if (!stream) return;
    chunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';
    recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      downloadLink.href = URL.createObjectURL(blob);
      downloadLink.classList.remove('hidden');
      recordBtn.textContent = '● Record Mix';
      recordBtn.classList.remove('recording');
    };
    recorder.start();
    recordBtn.textContent = '■ Stop';
    recordBtn.classList.add('recording');
    if (videoEl.paused) videoEl.play();
  });

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  buildEQ();
})();
