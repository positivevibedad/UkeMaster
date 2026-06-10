# 🎚️ UkeMaster — Audio Mixing Studio

A browser-based audio mixing studio for the videos you shoot on your iPhone.
Drop in a `.mov` / `.mp4`, watch the spectrum move in real time, and shape the
sound with a full processing chain. Everything runs locally in your browser
using the **Web Audio API** — your videos never leave your device.

## Layout

A single-frame, no-scroll interface (phone-style column):

```
┌─────────────────────────┐
│  brand      presets ● ⬇  │  top bar
├─────────────────────────┤
│        video            │  player
├─────────────────────────┤
│  ▮▮▯▮ frequency analyzer │  real-time spectrum + L/R meters
├─────────────────────────┤
│   active effect module   │  one effect shown at a time
├─────────────────────────┤
│  🔊 ───────●─────         │  master volume
├─────────────────────────┤
│ De-Esser │ EQ │ Filt │Cmp│  tab selector
└─────────────────────────┘
```

Tap a tab to switch which effect you're editing; a dot on the tab marks an
enabled effect. Everything stays in one frame — no scrolling.

## Features

- **🎬 Video upload** — drag-and-drop or browse for iPhone `.mov`/`.mp4` (and
  plain audio files). Video plays back while you mix its audio live.
- **📊 Real-time spectrum analyzer** *(the centerpiece)* — an FFT graphic
  equalizer analyzer with moving frequency bars, peak-hold, log/linear scaling,
  and L/R level meters. **The live EQ response curve is drawn right on top of
  the spectrum and updates the instant you turn an EQ knob.**
- **🎛️ Equalizer** — a simple 4-band parametric EQ (Low / Low-Mid / Hi-Mid /
  High) with rotary gain knobs and a shared **Q (1.0–5.0)** control.
- **🔇 De-Esser** — split-band sibilance reduction with adjustable frequency
  and amount, plus a live reduction meter.
- **🎚️ High-Pass & Low-Pass Filters** — each with frequency + resonance and an
  on/off switch.
- **🔊 Compressor + Maximizer** — full dynamics compressor (threshold, ratio,
  attack, release, knee) with a gain-reduction meter, followed by a maximizer
  (makeup gain + soft-clip brick-wall limiter with adjustable ceiling).
- **🎙️ Record & export** — capture the fully processed mix and download it.
- **⚡ Presets** — Flat, Voice/Vlog, Podcast Warm, Bright & Loud, Music.

## Signal chain

```
video → input gain → HPF → LPF → 4-band EQ → de-esser
      → compressor → maximizer (gain → limiter) → analyzer → master → output
```

## Running it

No build step. Because browsers restrict the Web Audio API over `file://`,
serve the folder over HTTP:

```bash
# from the project root
python3 -m http.server 8000
# then open http://localhost:8000
```

or with Node:

```bash
npx serve .
```

Then open the printed URL, drop in a video, and press **Play**.

## How the knobs work

- **Drag** a knob up/down to change its value.
- **Shift-drag** for fine adjustment.
- **Scroll** over a knob to nudge it.
- **Double-click** to reset to default.

## Browser support

Works in any modern Chromium, Safari, or Firefox build with Web Audio +
`MediaRecorder`. Tested target: desktop Chrome/Safari. iPhone `.mov` (H.264 /
HEVC) plays in Safari and Chrome.

## Project structure

```
index.html          # layout + controls
styles.css          # dark DAW-style theme
js/audioEngine.js   # Web Audio graph (filters, EQ, de-esser, comp, maximizer)
js/analyzer.js      # spectrum analyzer + EQ-curve overlay + meters
js/ui.js            # rotary Knob component + control helpers
js/app.js           # wiring, presets, file load, recording
```
