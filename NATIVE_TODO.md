# Native app — deferred features

Things that can't be done well (or at all) in the browser version and should
be built when UkeMaster becomes a native iOS app. Each has been attempted or
investigated on the web and hit a hard platform limit.

## 1. Baked-in video export
Mux the mastered audio back into the original video.
- **Web blocker:** ffmpeg.wasm won't load on iOS Safari; a real-time canvas
  re-encode is slow/lossy. The web app currently exports mastered **audio**
  (WAV) only.
- **Native:** AVFoundation (`AVAssetExportSession` / `AVMutableComposition`) —
  a few reliable lines, no FFmpeg, no memory limits.

## 2. Custom iCloud download / loading progress UI
A consistent, app-drawn progress indicator while a picked video downloads from
iCloud (the InShot experience).
- **Web blocker:** the file `<input>` only returns the file *after* iOS finishes
  downloading — no selection callback, no progress events, and the native
  picker covers the page. Impossible from web code.
- **Native:** `PHPickerViewController` + `PHImageManager.requestAVAsset` with a
  `progressHandler` driving a custom SwiftUI loading view.

## 3. De-esser
Reduce sibilance ("sss") without coloring the rest of the signal.
- **Web blocker:** every Web Audio approach failed — node-graph designs
  (subtractive and split-band) brighten because the DynamicsCompressor adds
  latency that comb-filters on recombination; the AudioWorklet version (correct
  DSP) silenced audio on device and couldn't be debugged remotely. Currently
  hidden in the web UI (inert passthrough in the signal chain).
- **Native:** AVAudioEngine with a dynamics-processor / parametric EQ band, or a
  proper sample-accurate AU — none of the web-audio landmines.
