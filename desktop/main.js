/**
 * Electron main process.
 *
 * Owns the window, the SQLite database connections, the filesystem access,
 * and exposes a small RPC surface to the renderer via preload.js.
 *
 * Renderer never touches Node APIs directly (contextIsolation: true).
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const AUDIO_MIME = {
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.oga':  'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a':  'audio/mp4',
  '.aac':  'audio/aac',
  '.aif':  'audio/aiff',
  '.aiff': 'audio/aiff',
  '.opus': 'audio/opus',
  '.wma':  'audio/x-ms-wma',
};
function audioMime(p) {
  return AUDIO_MIME[path.extname(p).toLowerCase()] || 'audio/*';
}

// ---- paths ---------------------------------------------------------------

const isPackaged = app.isPackaged;
const userDataDir = app.getPath('userData');
const settingsFile = path.join(userDataDir, 'settings.json');

/**
 * Resolve where the SFX library DB lives.
 * Priority:
 *   1. Path stored in user settings (set via the in-app picker)
 *   2. Bundled with the app at extraResources
 *   3. Project root data/sfx_library.db (during dev on Windows)
 */
function resolveDbPath() {
  const settings = loadSettings();
  if (settings.dbPath && fs.existsSync(settings.dbPath)) return settings.dbPath;
  if (isPackaged) {
    const bundled = path.join(process.resourcesPath, 'sfx_library.db');
    if (fs.existsSync(bundled)) return bundled;
  }
  const dev = path.join(__dirname, '..', 'data', 'sfx_library.db');
  if (fs.existsSync(dev)) return dev;
  return null;
}

// ---- settings ------------------------------------------------------------

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveSettings(s) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
}

// ---- database ------------------------------------------------------------

let db = null;

function openDb() {
  if (db) {
    try { db.close(); } catch (e) {}
    db = null;
  }
  const dbPath = resolveDbPath();
  if (!dbPath) return null;
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  return db;
}

// Used to scope queries to a media kind. Centralized so adding tabs is easy.
const MEDIA_KIND_FILTERS = {
  sfx:   { sql: "AND ai_category != 'musical'", params: [] },
  music: { sql: "AND ai_category  = 'musical'", params: [] },
  // Future tabs each get their own filter or their own DB connection.
};

function buildKindClause(kind) {
  return MEDIA_KIND_FILTERS[kind] || { sql: '', params: [] };
}

// ---- IPC handlers --------------------------------------------------------

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  const cur = loadSettings();
  const next = { ...cur, ...patch };
  saveSettings(next);
  return next;
});

ipcMain.handle('db:status', () => {
  const dbPath = resolveDbPath();
  return { dbPath, ok: !!dbPath };
});

ipcMain.handle('db:open-picker', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Select your SFX library database (sfx_library.db)',
    properties: ['openFile'],
    filters: [{ name: 'SQLite database', extensions: ['db'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const settings = loadSettings();
  saveSettings({ ...settings, dbPath: r.filePaths[0] });
  openDb();
  return r.filePaths[0];
});

ipcMain.handle('library:pick-folder', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Select the folder where your audio library lives',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const settings = loadSettings();
  saveSettings({ ...settings, libraryPath: r.filePaths[0] });
  return r.filePaths[0];
});

ipcMain.handle('stats', (_e, { kind } = {}) => {
  if (!db) openDb();
  if (!db) return { error: 'no database' };
  const filt = buildKindClause(kind);
  const total = db.prepare(
    `SELECT COUNT(*) c FROM sfx_files WHERE 1=1 ${filt.sql}`
  ).get(...filt.params).c;
  const tagged = db.prepare(
    `SELECT COUNT(*) c FROM sfx_files WHERE ai_tags IS NOT NULL ${filt.sql}`
  ).get(...filt.params).c;
  return { total, tagged };
});

ipcMain.handle('categories', (_e, { kind } = {}) => {
  if (!db) openDb();
  if (!db) return [];
  const filt = buildKindClause(kind);
  const rows = db.prepare(
    `SELECT ai_category AS name, COUNT(*) AS count
     FROM sfx_files
     WHERE ai_category IS NOT NULL ${filt.sql}
     GROUP BY ai_category
     ORDER BY count DESC`
  ).all(...filt.params);
  return rows;
});

// In-memory search index per (db, kind). Built lazily on first search.
const searchIndexCache = new Map();

function buildSearchIndex(kind) {
  const cacheKey = `${kind || '*'}`;
  if (searchIndexCache.has(cacheKey)) return searchIndexCache.get(cacheKey);
  const filt = buildKindClause(kind);
  const rows = db.prepare(
    `SELECT id, filename, ai_category, ai_mood, ai_tags, ai_use_cases, transcript
     FROM sfx_files
     WHERE ai_tags IS NOT NULL ${filt.sql}`
  ).all(...filt.params);
  const index = rows.map(r => {
    const parts = [];
    if (r.filename)    parts.push(String(r.filename).toLowerCase());
    if (r.ai_mood)     parts.push(String(r.ai_mood).toLowerCase());
    if (r.ai_category) parts.push(String(r.ai_category).toLowerCase());
    if (r.transcript)  parts.push(String(r.transcript).toLowerCase());
    for (const v of [r.ai_tags, r.ai_use_cases]) {
      if (!v) continue;
      try {
        const arr = JSON.parse(v);
        if (Array.isArray(arr) && arr.length) parts.push(arr.join(' ').toLowerCase());
      } catch (e) {}
    }
    return {
      id: r.id,
      category: String(r.ai_category || '').toLowerCase(),
      haystack: parts.join(' '),
    };
  });
  searchIndexCache.set(cacheKey, index);
  return index;
}

// Vocab cache for autocomplete + typo tolerance, also per kind.
const vocabCache = new Map();
function buildVocab(kind) {
  if (vocabCache.has(kind || '*')) return vocabCache.get(kind || '*');
  const idx = buildSearchIndex(kind);
  const words = new Set();
  for (const item of idx) {
    for (const w of item.haystack.split(/\s+/)) {
      if (w.length >= 2) words.add(w);
    }
  }
  const arr = [...words].sort();
  vocabCache.set(kind || '*', arr);
  return arr;
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

function fuzzyTopN(token, vocab, n, cutoff) {
  const scored = [];
  for (const w of vocab) {
    const dist = levenshtein(token, w);
    const sim = 1 - dist / Math.max(token.length, w.length);
    if (sim >= cutoff) scored.push([w, sim]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, n).map(x => x[0]);
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0; let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    count++; from = i + needle.length;
  }
  return count;
}

ipcMain.handle('search', (_e, { q, categories, kind, limit }) => {
  if (!db) openDb();
  if (!db) return { results: [], suggestions: [], error: 'no database' };

  q = (q || '').trim();
  const cats = new Set((categories || []).map(c => String(c).toLowerCase()));
  limit = Math.max(1, Math.min(200, limit || 30));

  if (!q && cats.size === 0) {
    return { results: [], count: 0, suggestions: [] };
  }

  const idx = buildSearchIndex(kind);
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = [];
  for (const item of idx) {
    if (cats.size && !cats.has(item.category)) continue;
    if (tokens.length) {
      let score = 0;
      let allMatch = true;
      for (const t of tokens) {
        const occ = countOccurrences(item.haystack, t);
        if (!occ) { allMatch = false; break; }
        score += occ;
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
    const ph = topIds.map(() => '?').join(',');
    const fullRows = db.prepare(
      `SELECT id, filepath_relative, filename, duration_seconds,
              loudness_lufs, spectral_centroid_mean, sample_rate, channels,
              ai_category, ai_mood, ai_tags, ai_use_cases,
              waveform_peaks, transcript
       FROM sfx_files WHERE id IN (${ph})`
    ).all(...topIds);
    const byId = new Map();
    for (const r of fullRows) {
      const parseJson = (v) => {
        if (!v) return [];
        try { return JSON.parse(v); } catch (e) { return []; }
      };
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
        tags: parseJson(r.ai_tags),
        use_cases: parseJson(r.ai_use_cases),
        peaks: parseJson(r.waveform_peaks),
        transcript: (r.transcript || '').trim(),
      });
    }
    results = topIds.map(id => byId.get(id)).filter(Boolean);
  }

  let suggestions = [];
  if (!results.length && q) {
    const vocab = buildVocab(kind);
    const vocabSet = new Set(vocab);
    for (const t of tokens) {
      if (t.length < 2 || vocabSet.has(t)) continue;
      const matches = fuzzyTopN(t, vocab, 3, 0.65);
      for (const m of matches) if (!suggestions.includes(m)) suggestions.push(m);
      if (suggestions.length >= 6) break;
    }
  }

  return { results, count: results.length, suggestions };
});

ipcMain.handle('suggest', (_e, { q, kind, limit }) => {
  q = q || '';
  limit = Math.max(1, Math.min(20, limit || 8));
  const parts = q.split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const last = parts[parts.length - 1].toLowerCase();
  if (last.length < 2) return [];
  const prefix = parts.slice(0, -1).join(' ');
  const vocab = buildVocab(kind);
  const prefixHits = vocab.filter(w => w.startsWith(last));
  prefixHits.sort((a, b) => a.length - b.length);
  const out = prefixHits.slice(0, limit);
  if (out.length < limit) {
    const seen = new Set(out);
    const fuzzy = fuzzyTopN(last, vocab, limit, 0.65);
    for (const f of fuzzy) {
      if (!seen.has(f)) {
        out.push(f);
        if (out.length >= limit) break;
      }
    }
  }
  return out.map(s => prefix ? prefix + ' ' + s : s);
});

/**
 * Read an audio file off disk and return raw bytes + MIME to the renderer.
 * Renderer wraps the bytes in a Blob and creates an object URL — works in
 * every Electron build without needing custom protocols, file:// quirks, or
 * webSecurity tweaks. SFX files are small (a few MB) so loading the whole
 * file is fast and not memory-pressure relevant.
 */
ipcMain.handle('audio:read', (_e, { filepath_relative }) => {
  const settings = loadSettings();
  const root = settings.libraryPath;
  if (!root) return { error: 'audio folder not set — open Settings and pick it' };
  const full = path.join(root, String(filepath_relative).replace(/[\\/]/g, path.sep));
  if (!fs.existsSync(full)) return { error: `file missing on disk: ${full}` };
  try {
    const buf = fs.readFileSync(full);
    return {
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      mime: audioMime(full),
      absolutePath: full,
    };
  } catch (e) {
    return { error: 'read failed: ' + (e && e.message ? e.message : String(e)) };
  }
});

/**
 * Just resolve the absolute path (without reading bytes). Used by the
 * "reveal in Finder" button.
 */
ipcMain.handle('audio:resolve-path', (_e, { filepath_relative }) => {
  const settings = loadSettings();
  const root = settings.libraryPath;
  if (!root) return { error: 'audio folder not set' };
  const full = path.join(root, String(filepath_relative).replace(/[\\/]/g, path.sep));
  if (!fs.existsSync(full)) return { error: `file missing: ${full}` };
  return { absolutePath: full };
});

ipcMain.handle('reveal', (_e, { absolutePath }) => {
  if (!absolutePath) return false;
  shell.showItemInFolder(absolutePath);
  return true;
});

// ---- window --------------------------------------------------------------

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (!isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  openDb();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
