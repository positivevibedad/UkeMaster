/*
 * videoExport.js
 * Isolated "baked-in" video export: muxes a normalized WAV audio track into
 * the original video (video stream copied, audio re-encoded to AAC) using
 * ffmpeg.wasm. Kept self-contained so it can be swapped for a native
 * (AVFoundation / MediaMuxer) implementation when this becomes a store app.
 *
 * Uses the single-threaded ffmpeg core (no SharedArrayBuffer / COOP-COEP
 * headers required), so it runs on static hosts like GitHub Pages.
 */
(function () {
  const FFMPEG_JS = 'https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js';
  const CORE_PATH = 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js';

  let ff = null;
  let fetchFile = null;
  let loadingPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensureLoaded(onStatus) {
    if (ff) return ff;
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async () => {
      if (!window.FFmpeg) {
        if (onStatus) onStatus('Loading video exporter…');
        await loadScript(FFMPEG_JS);
      }
      const { createFFmpeg, fetchFile: ffFetch } = window.FFmpeg;
      fetchFile = ffFetch;
      ff = createFFmpeg({ log: false, corePath: CORE_PATH });
      await ff.load();
      return ff;
    })();
    return loadingPromise;
  }

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : 'mp4';
  }

  /**
   * Extract the audio track from a video as a 48 kHz stereo PCM WAV using
   * FFmpeg. Used as a robust decode fallback when the browser's
   * decodeAudioData can't read the original container/codec (e.g. some .mov).
   * @returns {Promise<Blob>} a WAV blob.
   */
  async function extractAudioWav(videoFile, { onStatus } = {}) {
    const ffmpeg = await ensureLoaded(onStatus);
    const inName = 'src.' + extOf(videoFile.name);
    if (onStatus) onStatus('Reading file…');
    ffmpeg.FS('writeFile', inName, await fetchFile(videoFile));
    if (onStatus) onStatus('Extracting audio…');
    await ffmpeg.run('-i', inName, '-vn', '-ac', '2', '-ar', '48000',
      '-c:a', 'pcm_s16le', 'extracted.wav');
    const data = ffmpeg.FS('readFile', 'extracted.wav');
    try { ffmpeg.FS('unlink', 'extracted.wav'); } catch (e) {}
    try { ffmpeg.FS('unlink', inName); } catch (e) {}
    return new Blob([data.buffer], { type: 'audio/wav' });
  }

  /**
   * Mux a normalized WAV into the original video file.
   * @returns {Promise<Blob>} an mp4 with the original video + new audio.
   */
  async function mux(videoFile, wavBlob, { onStatus, onProgress } = {}) {
    const ffmpeg = await ensureLoaded(onStatus);
    const inName = 'input.' + extOf(videoFile.name);

    if (onStatus) onStatus('Preparing media…');
    ffmpeg.FS('writeFile', inName, await fetchFile(videoFile));
    ffmpeg.FS('writeFile', 'audio.wav', await fetchFile(wavBlob));

    if (onProgress) ffmpeg.setProgress(({ ratio }) => onProgress(ratio));
    if (onStatus) onStatus('Muxing video…');

    // Copy the video stream (fast, no quality loss), encode the normalized
    // audio to AAC, and keep them the same length.
    await ffmpeg.run(
      '-i', inName,
      '-i', 'audio.wav',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '256k',
      '-shortest',
      '-movflags', '+faststart',
      'output.mp4'
    );

    const data = ffmpeg.FS('readFile', 'output.mp4');
    // Tidy up the in-memory filesystem.
    try { ffmpeg.FS('unlink', inName); } catch (e) {}
    try { ffmpeg.FS('unlink', 'audio.wav'); } catch (e) {}
    try { ffmpeg.FS('unlink', 'output.mp4'); } catch (e) {}

    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  window.VideoExport = { mux, ensureLoaded, extractAudioWav };
})();
