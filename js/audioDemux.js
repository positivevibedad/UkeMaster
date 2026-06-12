/*
 * audioDemux.js
 * Offline audio extraction for containers the browser won't decode directly
 * (notably iPhone .mov with an HEVC video track — Safari's decodeAudioData
 * chokes on the whole file even though the AAC audio is fine).
 *
 * Uses mp4box.js (pure JS, no wasm — so it loads on iOS Safari, unlike
 * ffmpeg.wasm) to demux just the AAC audio track, then re-wraps the raw AAC
 * frames as an ADTS .aac stream that decodeAudioData CAN decode. This lets the
 * export stay on the fast offline path (no real-time play-through) for files
 * the browser otherwise refuses.
 */
(function () {
  const MP4BOX_JS = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js';
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

  async function ensureMP4Box(onStatus) {
    if (window.MP4Box) return window.MP4Box;
    if (!loadingPromise) {
      if (onStatus) onStatus('Loading audio extractor…');
      loadingPromise = loadScript(MP4BOX_JS);
    }
    await loadingPromise;
    if (!window.MP4Box) throw new Error('MP4Box failed to load');
    return window.MP4Box;
  }

  // ADTS sampling-frequency index table.
  const FREQ_INDEX = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000, 7350];

  // Build a 7-byte ADTS header (no CRC) for one AAC frame.
  function adtsHeader(objType, freqIdx, channels, frameLen) {
    const profile = objType - 1;            // AAC-LC (objType 2) -> profile 1
    const h = new Uint8Array(7);
    h[0] = 0xFF;
    h[1] = 0xF1;                            // syncword, MPEG-4, no CRC
    h[2] = ((profile & 0x3) << 6) | ((freqIdx & 0xF) << 2) | ((channels >> 2) & 0x1);
    h[3] = ((channels & 0x3) << 6) | ((frameLen >> 11) & 0x3);
    h[4] = (frameLen >> 3) & 0xFF;
    h[5] = ((frameLen & 0x7) << 5) | 0x1F;  // frame length + buffer fullness
    h[6] = 0xFC;                            // buffer fullness + 1 frame/packet
    return h;
  }

  /**
   * Extract the AAC audio track of a video/audio file as an ADTS .aac Blob.
   * Rejects if there's no AAC track or mp4box can't parse it (the caller then
   * falls back to real-time capture).
   * @returns {Promise<Blob>}
   */
  async function extractAAC(file, { onStatus } = {}) {
    const MP4Box = await ensureMP4Box(onStatus);
    if (onStatus) onStatus('Extracting audio…');
    const mp4 = MP4Box.createFile();
    const buf = await file.arrayBuffer();
    buf.fileStart = 0;

    return await new Promise((resolve, reject) => {
      const parts = [];
      let track = null, freqIdx = 4, objType = 2, channels = 2, received = 0;

      mp4.onError = (e) => reject(new Error('Demux error: ' + e));

      mp4.onReady = (info) => {
        track = (info.tracks || []).find((t) => t.type === 'audio'
          || (t.codec && t.codec.indexOf('mp4a') === 0));
        if (!track) { reject(new Error('No AAC audio track found')); return; }
        const sr = (track.audio && track.audio.sample_rate) || 44100;
        channels = (track.audio && track.audio.channel_count) || 2;
        freqIdx = FREQ_INDEX.indexOf(sr);
        if (freqIdx < 0) freqIdx = 4;       // default to 44.1 kHz
        const m = /mp4a\.40\.(\d+)/.exec(track.codec || '');
        objType = m ? parseInt(m[1], 10) : 2;
        if (objType < 1 || objType > 4) {
          reject(new Error('Unsupported AAC profile (' + track.codec + ')'));
          return;
        }
        mp4.setExtractionOptions(track.id, null, { nbSamples: 1000000 });
        mp4.start();
      };

      mp4.onSamples = (id, user, samples) => {
        for (const s of samples) {
          const data = s.data;
          parts.push(adtsHeader(objType, freqIdx, channels, data.length + 7));
          parts.push(data);
        }
        received += samples.length;
        if (track && received >= track.nb_samples) {
          resolve(new Blob(parts, { type: 'audio/aac' }));
        }
      };

      try {
        mp4.appendBuffer(buf);
        mp4.flush();
      } catch (e) {
        reject(e);
      }
    });
  }

  window.AudioDemux = { extractAAC };
})();
