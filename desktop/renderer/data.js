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

    async getAudioUrl(row) {
      const r = await window.api.resolveAudio({ filepath_relative: row.filepath_relative });
      if (r && r.url) return r.url;
      throw new Error(r && r.error ? r.error : 'Could not resolve audio path');
    },
    async revealInFinder(row) {
      const r = await window.api.resolveAudio({ filepath_relative: row.filepath_relative });
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
