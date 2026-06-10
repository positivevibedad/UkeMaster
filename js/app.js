/*
 * app.js
 * Entry point: wires the UI to the AudioEngine and SpectrumAnalyzer.
 */
(function () {
  const engine = new AudioEngine();
  let analyzer = null;
  const eqKnobs = [];
  let eqQKnob = null;

  // --- Elements ---
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const changeFileBtn = document.getElementById('changeFileBtn');
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
      }
      analyzer.start();
      document.getElementById('recordBtn').disabled = false;
    }, { once: true });
  }

  browseBtn.addEventListener('click', () => fileInput.click());
  changeFileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));

  ['dragover', 'dragenter'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    })
  );
  dropZone.addEventListener('drop', (e) => {
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
  videoEl.addEventListener('play', () => { playBtn.textContent = '⏸ Pause'; });
  videoEl.addEventListener('pause', () => { playBtn.textContent = '▶ Play'; });

  UI.bindRange('masterGain', null, (v) => engine.setMasterGain(v));

  // ---------------------------------------------------------------
  // EQ — build 4 gain knobs + shared Q knob
  // ---------------------------------------------------------------
  function buildEQ() {
    const wrap = document.getElementById('eqKnobs');
    EQ_BANDS.forEach((band, i) => {
      const el = document.createElement('div');
      el.className = 'knob';
      el.dataset.min = -15;
      el.dataset.max = 15;
      el.dataset.step = 0.5;
      el.dataset.value = 0;
      el.dataset.default = 0;
      el.innerHTML = `
        <div class="knob-dial"><div class="knob-pointer"></div></div>
        <span class="knob-label">${band.label}</span>
        <span class="knob-sub">${UI.fmtHz(band.freq)}</span>
        <span class="knob-val">0.0 dB</span>`;
      wrap.appendChild(el);
      const knob = new Knob(el, (v) => engine.setEQBand(i, v));
      knob.setFormatter(UI.fmtDb);
      eqKnobs.push(knob);
    });

    eqQKnob = new Knob(document.getElementById('eqQKnob'), (v) => engine.setEQQ(v));
    eqQKnob.setFormatter(UI.fmtNum);
  }

  document.getElementById('eqReset').addEventListener('click', () => {
    eqKnobs.forEach((k) => k.set(0, true));
  });

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
    if (eqQKnob && p.q != null) eqQKnob.set(p.q, true);
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

  document.querySelectorAll('.preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyPreset(btn.dataset.preset);
    });
  });

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
