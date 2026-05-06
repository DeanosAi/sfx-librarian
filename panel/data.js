/* Data access layer for the SFX Librarian panel.
 *
 * Three modes:
 *   browser/Flask  — default in browser. Hits panel_server.py via /api/*.
 *   browser/sql.js — opt-in via URL param ?backend=sqljs. Lets us validate the
 *                    sql.js code path on Windows before shipping to Mac.
 *   UXP / sql.js   — auto-selected inside Premiere on Mac. No server.
 *
 * app.js never knows which backend is running. It just calls data.search(),
 * data.getStats(), etc.
 */

// ----- environment detection -----

export const IS_UXP = (() => {
  try { return typeof require !== 'undefined' && !!require('uxp'); }
  catch (e) { return false; }
})();

const FORCE_SQLJS = !IS_UXP &&
  typeof location !== 'undefined' &&
  /[?&]backend=sqljs\b/.test(location.search);

const USE_SQLJS = IS_UXP || FORCE_SQLJS;

// Relative path to the lib folder. Works in both browser (Flask serves panel/
// at the root) and UXP (panel/ is the plugin's root folder).
const SQLJS_BASE = 'lib';

// ----- storage -----

const STORAGE_KEY_LIBRARY_PATH = 'sfx-librarian:library-path';
const STORAGE_KEY_LIBRARY_TOKEN = 'sfx-librarian:library-token';

export const storage = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  remove(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

// ----- public API -----

export const data = {
  isUxp: () => IS_UXP,
  isSqljs: () => USE_SQLJS,

  getLibraryPath() { return storage.get(STORAGE_KEY_LIBRARY_PATH); },
  setLibraryPath(p) {
    if (p && p.trim()) storage.set(STORAGE_KEY_LIBRARY_PATH, p.trim());
    else { storage.remove(STORAGE_KEY_LIBRARY_PATH); storage.remove(STORAGE_KEY_LIBRARY_TOKEN); }
  },

  async getStats()             { return USE_SQLJS ? sqljsGetStats()       : apiGetStats(); },
  async getCategories()        { return USE_SQLJS ? sqljsGetCategories()  : apiGetCategories(); },
  async search(args)           { return USE_SQLJS ? sqljsSearch(args)     : apiSearch(args); },
  async getSuggestions(q, n)   { return USE_SQLJS ? sqljsSuggest(q, n)    : apiSuggest(q, n); },
  async getAudioUrl(row)       { return USE_SQLJS ? sqljsAudioUrl(row)    : `/api/audio/${row.id}`; },
  trim(row, inSec, outSec)     { return USE_SQLJS ? sqljsTrim(row, inSec, outSec) : apiTrim(row, inSec, outSec); },

  async pickFolder() { return IS_UXP ? uxpPickFolder() : browserPickFolder(); },
};

// =====================================================================
// 1. Browser/Flask backend
// =====================================================================

async function apiGetStats() {
  const r = await fetch('/api/stats'); return r.json();
}
async function apiGetCategories() {
  const r = await fetch('/api/categories'); const d = await r.json();
  return d.categories || [];
}
async function apiSearch({ q, categories, limit }) {
  const params = new URLSearchParams({
    q: q || '', categories: (categories || []).join(','), limit: String(limit || 30),
  });
  const r = await fetch('/api/search?' + params.toString());
  return r.json();
}
async function apiSuggest(q, limit) {
  const params = new URLSearchParams({ q, limit: String(limit || 8) });
  const r = await fetch('/api/suggest?' + params.toString());
  const d = await r.json();
  return d.suggestions || [];
}
function apiTrim(row, inSec, outSec) {
  const url = `/api/trim/${row.id}?in=${encodeURIComponent(inSec)}&out=${encodeURIComponent(outSec)}`;
  const a = document.createElement('a');
  a.href = url; a.download = ''; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// =====================================================================
// 2. sql.js backend (used by UXP and by browser ?backend=sqljs)
// =====================================================================

let _sqljsDb = null;
let _sqljsPromise = null;
let _vocab = null;
let _currentBlobUrl = null;
let _libraryFolderEntry = null;  // UXP only — cached Folder reference

async function loadSqlJsScript() {
  // sql-wasm.js is a UMD bundle that sets `initSqlJs` as a global. Load it once.
  if (typeof window.initSqlJs === 'function') return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SQLJS_BASE + '/sql-wasm.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load sql-wasm.js from ' + s.src));
    document.head.appendChild(s);
  });
}

async function getSqljsDb() {
  if (_sqljsDb) return _sqljsDb;
  if (_sqljsPromise) return _sqljsPromise;
  _sqljsPromise = (async () => {
    await loadSqlJsScript();
    const SQL = await window.initSqlJs({
      locateFile: (file) => SQLJS_BASE + '/' + file,
    });
    const dbBytes = await readDbBytes();
    _sqljsDb = new SQL.Database(new Uint8Array(dbBytes));
    return _sqljsDb;
  })();
  return _sqljsPromise;
}

async function readDbBytes() {
  if (IS_UXP) {
    // Plugin bundles the DB next to manifest.json
    const uxp = require('uxp');
    const pluginFolder = await uxp.storage.localFileSystem.getPluginFolder();
    const dbFile = await pluginFolder.getEntry('sfx_library.db');
    return await dbFile.read({ format: uxp.storage.formats.binary });
  } else {
    const r = await fetch('/sfx_library.db');
    if (!r.ok) throw new Error('Could not fetch /sfx_library.db (HTTP ' + r.status + ')');
    return await r.arrayBuffer();
  }
}

// ---- query helpers ----

function buildFtsQuery(q) {
  const tokens = (q || '').split(/\s+/).filter(t => t.trim());
  return tokens.map(t => '"' + t.replace(/"/g, '""') + '"').join(' ');
}

function parseJsonField(v) {
  if (!v) return [];
  try { return JSON.parse(v); } catch (e) { return []; }
}

function rowsAsArray(stmt) {
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  return out;
}

// ---- search/stats/categories ----

async function sqljsGetStats() {
  const db = await getSqljsDb();
  const total    = db.exec('SELECT COUNT(*) FROM sfx_files')[0].values[0][0];
  const analyzed = db.exec('SELECT COUNT(*) FROM sfx_files WHERE transcript IS NOT NULL')[0].values[0][0];
  const tagged   = db.exec('SELECT COUNT(*) FROM sfx_files WHERE ai_tags IS NOT NULL')[0].values[0][0];
  const rootRow  = db.exec("SELECT value FROM library_config WHERE key='library_root'");
  const library_root = rootRow.length && rootRow[0].values.length ? rootRow[0].values[0][0] : null;
  return { total, analyzed, tagged, library_root };
}

async function sqljsGetCategories() {
  const db = await getSqljsDb();
  const r = db.exec(
    'SELECT ai_category, COUNT(*) FROM sfx_files ' +
    'WHERE ai_category IS NOT NULL ' +
    'GROUP BY ai_category ORDER BY COUNT(*) DESC'
  );
  if (!r.length) return [];
  return r[0].values.map(([name, count]) => ({ name, count }));
}

/* Search strategy in sql.js mode:
 *
 * sql.js's prebuilt WASM doesn't include the FTS5 module, so we can't use the
 * `sfx_search` virtual table the way panel_server.py does. Instead we build an
 * in-memory inverted-style index once on first search (a flat array of light
 * rows with pre-lowercased haystack text), then filter+rank it in pure JS.
 *
 * Cost: ~1-2 seconds the very first search (loads ~22K lightweight rows),
 * then <50 ms per search. Memory ~25 MB. Both totally fine on any laptop.
 */

let _lightIndex = null;       // [{ id, category, haystack }]
let _lightIndexPromise = null;

async function buildLightIndex() {
  if (_lightIndex) return _lightIndex;
  if (_lightIndexPromise) return _lightIndexPromise;
  _lightIndexPromise = (async () => {
    const db = await getSqljsDb();
    const stmt = db.prepare(
      'SELECT id, filename, ai_category, ai_mood, ai_tags, ai_use_cases, transcript ' +
      'FROM sfx_files WHERE ai_tags IS NOT NULL'
    );
    const out = [];
    try {
      while (stmt.step()) {
        const r = stmt.getAsObject();
        const parts = [];
        if (r.filename)    parts.push(String(r.filename).toLowerCase());
        if (r.ai_mood)     parts.push(String(r.ai_mood).toLowerCase());
        if (r.ai_category) parts.push(String(r.ai_category).toLowerCase());
        if (r.transcript)  parts.push(String(r.transcript).toLowerCase());
        for (const v of [r.ai_tags, r.ai_use_cases]) {
          const arr = parseJsonField(v);
          if (arr.length) parts.push(arr.join(' ').toLowerCase());
        }
        out.push({
          id: r.id,
          category: String(r.ai_category || '').toLowerCase(),
          haystack: parts.join(' '),
        });
      }
    } finally { stmt.free(); }
    _lightIndex = out;
    return out;
  })();
  return _lightIndexPromise;
}

async function sqljsSearch({ q, categories, limit }) {
  q = (q || '').trim();
  const cats = new Set((categories || []).map(c => c.toLowerCase()).filter(Boolean));
  limit = Math.max(1, Math.min(100, limit || 30));

  if (!q && cats.size === 0) {
    return { results: [], count: 0, query: q, suggestions: [] };
  }

  const idx = await buildLightIndex();
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = [];
  for (const item of idx) {
    if (cats.size && !cats.has(item.category)) continue;
    if (tokens.length) {
      // All tokens must appear in the haystack (AND semantics, like FTS5 default).
      let score = 0;
      let allMatch = true;
      for (const t of tokens) {
        const occurrences = countOccurrences(item.haystack, t);
        if (!occurrences) { allMatch = false; break; }
        score += occurrences;
      }
      if (!allMatch) continue;
      scored.push({ id: item.id, score });
    } else {
      scored.push({ id: item.id, score: 0 });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const topIds = scored.slice(0, limit).map(s => s.id);

  let results = [];
  if (topIds.length) {
    const db = await getSqljsDb();
    const ph = topIds.map(() => '?').join(',');
    const stmt = db.prepare(
      `SELECT id, filepath_relative, filename, duration_seconds,
              loudness_lufs, spectral_centroid_mean, sample_rate, channels,
              ai_category, ai_mood, ai_tags, ai_use_cases,
              waveform_peaks, transcript
       FROM sfx_files WHERE id IN (${ph})`
    );
    const byId = new Map();
    try {
      stmt.bind(topIds);
      while (stmt.step()) {
        const r = stmt.getAsObject();
        byId.set(r.id, {
          id: r.id,
          filepath_relative: r.filepath_relative,
          filename: r.filename,
          duration: r.duration_seconds,
          lufs: r.loudness_lufs,
          centroid: r.spectral_centroid_mean,
          sample_rate: r.sample_rate,
          channels: r.channels,
          category: r.ai_category,
          mood: r.ai_mood,
          tags: parseJsonField(r.ai_tags),
          use_cases: parseJsonField(r.ai_use_cases),
          peaks: parseJsonField(r.waveform_peaks),
          transcript: (r.transcript || '').trim(),
        });
      }
    } finally { stmt.free(); }
    results = topIds.map(id => byId.get(id)).filter(Boolean);
  }

  let suggestions = [];
  if (!results.length && q) {
    suggestions = await sqljsSuggestForEmpty(q);
  }
  return { results, count: results.length, query: q, suggestions };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

// ---- vocabulary + fuzzy matching (typo tolerance) ----

async function buildVocab() {
  if (_vocab) return _vocab;
  const db = await getSqljsDb();
  const words = new Set();
  const stmt = db.prepare(
    'SELECT ai_tags, ai_use_cases, ai_mood, filename FROM sfx_files WHERE ai_tags IS NOT NULL'
  );
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject();
      for (const v of [r.ai_tags, r.ai_use_cases]) {
        const arr = parseJsonField(v);
        for (const item of arr) {
          const s = String(item).trim().toLowerCase();
          if (!s) continue;
          words.add(s);
          for (const w of s.split(/\s+/)) if (w.length >= 2) words.add(w);
        }
      }
      if (r.ai_mood) {
        const ms = String(r.ai_mood).toLowerCase().match(/[a-z][a-z]+/g) || [];
        for (const m of ms) words.add(m);
      }
      if (r.filename) {
        const stem = String(r.filename).replace(/\.[^.]+$/, '').toLowerCase();
        const ms = stem.match(/[a-z][a-z]{2,}/g) || [];
        for (const m of ms) words.add(m);
      }
    }
  } finally { stmt.free(); }
  _vocab = [...words].sort();
  return _vocab;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? 1 - levenshtein(a, b) / max : 1;
}

async function fuzzyTopN(token, n, cutoff) {
  const vocab = await buildVocab();
  const scored = [];
  for (const w of vocab) {
    const s = similarity(token, w);
    if (s >= cutoff) scored.push([w, s]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, n).map(x => x[0]);
}

async function sqljsSuggest(q, limit) {
  q = q || '';
  limit = Math.max(1, Math.min(20, limit || 8));
  const parts = q.split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const last = parts[parts.length - 1].toLowerCase();
  if (last.length < 2) return [];
  const prefix = parts.slice(0, -1).join(' ');

  const vocab = await buildVocab();
  const prefixHits = vocab.filter(w => w.startsWith(last));
  prefixHits.sort((a, b) => a.length - b.length);
  const out = prefixHits.slice(0, limit);

  if (out.length < limit) {
    const seen = new Set(out);
    const fuzzy = await fuzzyTopN(last, limit, 0.65);
    for (const f of fuzzy) {
      if (!seen.has(f)) {
        out.push(f);
        if (out.length >= limit) break;
      }
    }
  }
  return out.map(s => prefix ? prefix + ' ' + s : s);
}

async function sqljsSuggestForEmpty(q) {
  const vocab = await buildVocab();
  const vocabSet = new Set(vocab);
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (t.length < 2 || vocabSet.has(t)) continue;
    const matches = await fuzzyTopN(t, 3, 0.65);
    for (const m of matches) if (!out.includes(m)) out.push(m);
    if (out.length >= 6) break;
  }
  return out;
}

// ---- audio ----

async function sqljsAudioUrl(row) {
  if (_currentBlobUrl) {
    URL.revokeObjectURL(_currentBlobUrl);
    _currentBlobUrl = null;
  }

  if (!IS_UXP) {
    // Browser sqljs test mode — no UXP fs available. Fall back to Flask.
    return `/api/audio/${row.id}`;
  }

  // UXP: read the file via the user's picked library folder
  if (!_libraryFolderEntry) {
    await tryRestoreLibraryFolder();
  }
  if (!_libraryFolderEntry) {
    throw new Error('Library folder not set. Click 📁 set library… to point to your SFX folder.');
  }
  const rel = String(row.filepath_relative || '').replace(/\\/g, '/');
  const file = await _libraryFolderEntry.getEntry(rel);
  const uxp = require('uxp');
  const bytes = await file.read({ format: uxp.storage.formats.binary });
  const blob = new Blob([bytes], { type: guessMime(row.filename) });
  _currentBlobUrl = URL.createObjectURL(blob);
  return _currentBlobUrl;
}

function guessMime(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return {
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
    m4a: 'audio/mp4',  aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff',
    opus: 'audio/opus', wma: 'audio/x-ms-wma',
  }[ext] || 'audio/*';
}

function sqljsTrim(row, inSec, outSec) {
  alert(
    'Trim/save isn\'t available in UXP yet — this is replaced by ' +
    '"Add to project as subclip" in Phase C, which uses Premiere\'s native ' +
    'subclip API instead of re-encoding.'
  );
}

// =====================================================================
// 3. Folder picker + persistent library reference
// =====================================================================

async function tryRestoreLibraryFolder() {
  if (!IS_UXP || _libraryFolderEntry) return;
  const token = storage.get(STORAGE_KEY_LIBRARY_TOKEN);
  if (!token) return;
  try {
    const uxp = require('uxp');
    const fs = uxp.storage.localFileSystem;
    if (typeof fs.getEntryForPersistentToken === 'function') {
      _libraryFolderEntry = await fs.getEntryForPersistentToken(token);
    }
  } catch (e) {
    console.warn('Could not restore library folder from token:', e);
    storage.remove(STORAGE_KEY_LIBRARY_TOKEN);
  }
}

async function uxpPickFolder() {
  try {
    const uxp = require('uxp');
    const fs = uxp.storage.localFileSystem;
    const folder = await fs.getFolder();
    if (!folder) return null;
    _libraryFolderEntry = folder;
    // Persist a token so we can restore the same folder reference later.
    if (typeof fs.createPersistentToken === 'function') {
      try {
        const token = await fs.createPersistentToken(folder);
        storage.set(STORAGE_KEY_LIBRARY_TOKEN, token);
      } catch (e) {
        console.warn('Could not create persistent token:', e);
      }
    }
    return { path: folder.nativePath, complete: true };
  } catch (e) {
    console.error('UXP folder picker failed:', e);
    return null;
  }
}

function browserPickFolder() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.setAttribute('mozdirectory', '');
    let resolved = false;
    input.addEventListener('change', () => {
      resolved = true;
      const f = input.files && input.files[0];
      if (!f) { resolve(null); return; }
      const folderName = (f.webkitRelativePath || '').split('/')[0] || '';
      resolve({ path: folderName, complete: false });
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(() => { if (!resolved) { resolve(null); input.remove(); } }, 60000);
  });
}

// Eagerly try to restore the library folder on import (UXP only).
if (IS_UXP) tryRestoreLibraryFolder();
