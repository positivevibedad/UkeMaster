/*
 * ui.js
 * Reusable rotary Knob control + helpers for wiring DOM controls to the engine.
 */

/** A draggable rotary knob built on a DOM element with data-* config. */
class Knob {
  constructor(el, onChange) {
    this.el = el;
    this.min = parseFloat(el.dataset.min);
    this.max = parseFloat(el.dataset.max);
    this.step = parseFloat(el.dataset.step || '0.01');
    this.value = parseFloat(el.dataset.value);
    this.default = parseFloat(el.dataset.default ?? el.dataset.value);
    this.format = (v) => v;
    this.onChange = onChange || (() => {});
    this.dial = el.querySelector('.knob-dial');
    this.valEl = el.querySelector('.knob-val');
    this._bind();
    this._render();
  }

  setFormatter(fn) { this.format = fn; this._render(); return this; }

  _bind() {
    let startY = 0, startVal = 0, dragging = false;
    const range = this.max - this.min;

    const onMove = (e) => {
      if (!dragging) return;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      const dy = startY - y;
      // 200px of travel covers the full range; shift slows it down.
      const speed = e.shiftKey ? 4 : 1;
      let v = startVal + (dy / 200) * range / speed;
      this.set(v, true);
      e.preventDefault();
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
    const onDown = (e) => {
      dragging = true;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      startVal = this.value;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
      e.preventDefault();
    };

    this.el.addEventListener('mousedown', onDown);
    this.el.addEventListener('touchstart', onDown, { passive: false });
    // Wheel to fine-tune
    this.el.addEventListener('wheel', (e) => {
      const dir = e.deltaY < 0 ? 1 : -1;
      this.set(this.value + dir * this.step * 4, true);
      e.preventDefault();
    }, { passive: false });
    // Double-click resets to default
    this.el.addEventListener('dblclick', () => this.set(this.default, true));
  }

  set(v, fire) {
    v = Math.max(this.min, Math.min(this.max, v));
    v = Math.round(v / this.step) * this.step;
    this.value = v;
    this._render();
    if (fire) this.onChange(v);
  }

  _render() {
    // Map value to -135deg..+135deg
    const frac = (this.value - this.min) / (this.max - this.min);
    const deg = -135 + frac * 270;
    if (this.dial) this.dial.style.transform = `rotate(${deg}deg)`;
    if (this.valEl) this.valEl.textContent = this.format(this.value);
    // bipolar glow for gain knobs centered at 0
    this.el.classList.toggle('knob-pos', this.value > this.default + 1e-6);
    this.el.classList.toggle('knob-neg', this.value < this.default - 1e-6);
  }
}

/** Wire a range <input> to a callback, keeping a value label in sync. */
function bindRange(id, valId, onInput, fmt) {
  const el = document.getElementById(id);
  const valEl = valId ? document.getElementById(valId) : null;
  if (!el) return null;
  const update = () => {
    const v = parseFloat(el.value);
    if (valEl && fmt) valEl.textContent = fmt(v);
    onInput(v);
  };
  el.addEventListener('input', update);
  el.__update = update;
  return el;
}

function bindCheckbox(id, onChange) {
  const el = document.getElementById(id);
  if (!el) return null;
  el.addEventListener('change', () => onChange(el.checked));
  return el;
}

// Formatters
const fmtHz = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz');
const fmtDb = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
const fmtDbInt = (v) => (v > 0 ? '+' : '') + Math.round(v) + ' dB';
const fmtMs = (v) => Math.round(v) + ' ms';
const fmtRatio = (v) => v.toFixed(1) + ':1';
const fmtNum = (v) => v.toFixed(1);

window.Knob = Knob;
window.UI = { bindRange, bindCheckbox, fmtHz, fmtDb, fmtDbInt, fmtMs, fmtRatio, fmtNum };
