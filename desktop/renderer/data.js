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
     * Read the file via IPC, wrap it as a Blob, and return an object URL
     * usable as an <audio> element's src. Revokes the previous URL first.
     */
    async getAudioUrl(row) {
      revokeLastBlobUrl();
      const r = await window.api.readAudio({ filepath_relative: row.filepath_relative });
      if (!r || r.error) throw new Error(r && r.error ? r.error : 'no audio');
      // r.bytes is an ArrayBuffer (transferred over IPC).
      const blob = new Blob([r.bytes], { type: r.mime || 'audio/*' });
      lastBlobUrl = URL.createObjectURL(blob);
      return lastBlobUrl;
    },
    revokeAudioUrl: revokeLastBlobUrl,

    async revealInFinder(row) {
      const r = await window.api.resolveAudioPath({ filepath_relative: row.filepath_relative });
      if (!r || !r.absolutePath) throw new Error(r && r.error ? r.error : 'no path');
      return window.api.revealInFinder({ absolutePath: r.absolutePath });
    },

    async getSettings() { return window.api.getSettings(); },
    async setSettings(patch) { return window.api.setSettings(patch); },
    async dbStatus() { return window.api.dbStatus(); },
    async pickDb() { return window.api.pickDb(); },
    async pickLibrary() { return window.api.pickLibrary(); },
  };
})();
