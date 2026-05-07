/**
 * Data layer for the desktop app.
 *
 * Wraps window.api (preload bridge) into a friendlier shape and gives app.js
 * the same surface it already uses — search/getStats/getCategories/etc.
 */
(() => {
  if (!window.api) {
    console.error('window.api missing — preload.js did not load');
  }

  /** Currently active media kind (sfx | music | broll | …). */
  let currentKind = 'sfx';

  /** Most-recently-created blob URL for the playing clip. Revoked when we
   *  switch to the next clip so we don't leak memory. */
  let lastBlobUrl = null;
  function revokeLastBlobUrl() {
    if (lastBlobUrl) {
      try { URL.revokeObjectURL(lastBlobUrl); } catch (e) {}
      lastBlobUrl = null;
    }
  }

  window.data = {
    setKind(kind) { currentKind = kind; },
    getKind()     { return currentKind; },

    async getStats() {
      return window.api.stats({ kind: currentKind });
    },
    async getCategories() {
      return window.api.categories({ kind: currentKind });
    },
    async search({ q, categories, limit }) {
      return window.api.search({ q, categories, kind: currentKind, limit });
    },
    async getSuggestions(q, limit) {
      return window.api.suggest({ q, kind: currentKind, limit });
    },

    /**
     * Read the file via IPC, wrap it as a Blob, return an object URL
     * usable as an <audio> or <video> element's src. Revokes the previous
     * URL first to avoid leaking memory across switches.
     */
    async getAudioUrl(row) {
      revokeLastBlobUrl();
      const r = await window.api.readAudio({
        filepath_relative: row.filepath_relative,
        kind: currentKind,
      });
      if (!r || r.error) throw new Error(r && r.error ? r.error : 'no media');
      const blob = new Blob([r.bytes], { type: r.mime || 'application/octet-stream' });
      lastBlobUrl = URL.createObjectURL(blob);
      return lastBlobUrl;
    },
    revokeAudioUrl: revokeLastBlobUrl,

    /** Returns a blob: URL for a thumbnail JPEG, or null if missing. */
    async getThumbnailUrl(row) {
      if (!row.thumbnail_path) return null;
      const r = await window.api.readThumbnail({ thumbnail_path: row.thumbnail_path });
      if (!r || r.error) return null;
      const blob = new Blob([r.bytes], { type: r.mime || 'image/jpeg' });
      return URL.createObjectURL(blob);
    },

    async revealInFinder(row) {
      const r = await window.api.resolveAudioPath({
        filepath_relative: row.filepath_relative,
        kind: currentKind,
      });
      if (!r || !r.absolutePath) throw new Error(r && r.error ? r.error : 'no path');
      return window.api.revealInFinder({ absolutePath: r.absolutePath });
    },

    /**
     * Decode the source file via Web Audio, slice [inSec, outSec], encode as
     * 16-bit PCM WAV in memory, and write it to an OS temp file via IPC.
     * Returns the absolute path of the temp file. Caller can then hand it
     * to sendToPremiere (or any other absolute-path consumer).
     */
    async trimToTempFile(row, inSec, outSec) {
      if (outSec <= inSec) throw new Error('invalid trim range');
      const r = await window.api.readAudio({ filepath_relative: row.filepath_relative });
      if (!r || r.error) throw new Error(r && r.error ? r.error : 'no audio');
      const audioBuffer = await decodeAudioBytes(r.bytes);
      const sr = audioBuffer.sampleRate;
      const startSample = Math.max(0, Math.floor(inSec * sr));
      const endSample = Math.min(audioBuffer.length, Math.floor(outSec * sr));
      const length = endSample - startSample;
      if (length <= 0) throw new Error('trim range produced zero samples');

      const trimmed = sharedAudioCtx().createBuffer(audioBuffer.numberOfChannels, length, sr);
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const src = audioBuffer.getChannelData(ch);
        trimmed.copyToChannel(src.subarray(startSample, endSample), ch);
      }

      const wavBuf = audioBufferToWavArrayBuffer(trimmed);
      const stem = String(row.filename || 'clip').replace(/\.[^.]+$/, '');
      const filename = `${stem}__trim_${inSec.toFixed(2)}-${outSec.toFixed(2)}.wav`;
      const saved = await window.api.saveTempAudio({ bytes: wavBuf, filename });
      if (!saved || saved.error) throw new Error(saved && saved.error ? saved.error : 'temp save failed');
      return saved.absolutePath;
    },

    async getSettings() { return window.api.getSettings(); },
    async setSettings(patch) { return window.api.setSettings(patch); },
    async dbStatus(kind) { return window.api.dbStatus({ kind: kind || currentKind }); },
    async pickDb(kind) { return window.api.pickDb({ kind: kind || currentKind }); },
    async pickLibrary(kind) { return window.api.pickLibrary({ kind: kind || currentKind }); },
  };

  // ----- web-audio helpers (used by trim) -------------------------------

  let _audioCtx = null;
  function sharedAudioCtx() {
    if (!_audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      _audioCtx = new Ctor();
    }
    return _audioCtx;
  }
  async function decodeAudioBytes(arrayBuffer) {
    // decodeAudioData detaches the buffer; pass a slice so the original
    // ArrayBuffer is left intact for any other consumer.
    return sharedAudioCtx().decodeAudioData(arrayBuffer.slice(0));
  }

  /**
   * Encode an AudioBuffer as a 16-bit PCM WAV (interleaved). Returns an
   * ArrayBuffer suitable for writing as a .wav file.
   */
  function audioBufferToWavArrayBuffer(audioBuffer) {
    const numCh = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const dataSize = length * numCh * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    let offset = 0;
    const writeStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i)); };
    const writeU32 = (v) => { view.setUint32(offset, v, true); offset += 4; };
    const writeU16 = (v) => { view.setUint16(offset, v, true); offset += 2; };
    writeStr('RIFF'); writeU32(36 + dataSize);
    writeStr('WAVE');
    writeStr('fmt '); writeU32(16); writeU16(1); writeU16(numCh);
    writeU32(sampleRate); writeU32(sampleRate * numCh * 2);
    writeU16(numCh * 2); writeU16(16);
    writeStr('data'); writeU32(dataSize);
    const channels = [];
    for (let ch = 0; ch < numCh; ch++) channels.push(audioBuffer.getChannelData(ch));
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        let s = channels[ch][i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }
    }
    return buffer;
  }
})();
