/**
 * Electron main process.
 *
 * Owns the window, the SQLite database connections, the filesystem access,
 * and exposes a small RPC surface to the renderer via preload.js.
 *
 * Renderer never touches Node APIs directly (contextIsolation: true).
 */

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
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
const VIDEO_MIME = {
  '.mp4':  'video/mp4',
  '.m4v':  'video/mp4',
  '.mov':  'video/quicktime',
  '.mkv':  'video/x-matroska',
  '.webm': 'video/webm',
  '.avi':  'video/x-msvideo',
};
function audioMime(p) { return AUDIO_MIME[path.extname(p).toLowerCase()] || 'audio/*'; }
function videoMime(p) { return VIDEO_MIME[path.extname(p).toLowerCase()] || 'video/*'; }
function mediaMime(p) {
  const ext = path.extname(p).toLowerCase();
  return AUDIO_MIME[ext] || VIDEO_MIME[ext] || 'application/octet-stream';
}

// ---- paths ---------------------------------------------------------------

const isPackaged = app.isPackaged;
const userDataDir = app.getPath('userData');
const settingsFile = path.join(userDataDir, 'settings.json');

/**
 * Resolve the DB path for a given media kind. Each tab can point at its own
 * .db file; if a kind has no specific path set, we fall back to the legacy
 * single dbPath setting (so existing setups keep working).
 *
 * Settings shape:
 *   {
 *     dbPath: "<legacy single DB>",
 *     dbPaths: { sfx: "...", music: "...", broll: "...", transitions: "..." },
 *     libraryPaths: { sfx: "...", music: "...", broll: "...", transitions: "..." }
 *   }
 */
function resolveDbPath(kind = 'sfx') {
  const settings = loadSettings();
  const perKind = settings.dbPaths && settings.dbPaths[kind];
  if (perKind && fs.existsSync(perKind)) return perKind;
  // SFX falls back to legacy single dbPath, music shares it (same DB, different filter).
  if ((kind === 'sfx' || kind === 'music') && settings.dbPath && fs.existsSync(settings.dbPath)) {
    return settings.dbPath;
  }
  if (kind === 'sfx' || kind === 'music') {
    if (isPackaged) {
      const bundled = path.join(process.resourcesPath, 'sfx_library.db');
      if (fs.existsSync(bundled)) return bundled;
    }
    const dev = path.join(__dirname, '..', 'data', 'sfx_library.db');
    if (fs.existsSync(dev)) return dev;
  }
  return null;
}

function resolveLibraryPath(kind = 'sfx') {
  const settings = loadSettings();
  const perKind = settings.libraryPaths && settings.libraryPaths[kind];
  if (perKind) return perKind;
  // Legacy: single libraryPath used for sfx + music.
  if ((kind === 'sfx' || kind === 'music') && settings.libraryPath) return settings.libraryPath;
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
//
// One DB connection cached per kind. Opens lazily on first use, reused
// across calls. resolveDbPath returns null if nothing's set — callers
// should handle that.

const dbConnections = new Map();  // kind -> Database instance

function getDb(kind = 'sfx') {
  const dbPath = resolveDbPath(kind);
  if (!dbPath) return null;
  const existing = dbConnections.get(kind);
  if (existing && existing.path === dbPath) return existing.db;
  // Path changed (or first call) — open fresh
  if (existing) {
    try { existing.db.close(); } catch (e) {}
  }
  try {
    const conn = new Database(dbPath, { readonly: true, fileMustExist: true });
    dbConnections.set(kind, { path: dbPath, db: conn });
    return conn;
  } catch (e) {
    console.error(`[db] open failed for kind=${kind} at ${dbPath}:`, e.message);
    return null;
  }
}

function closeAllDbs() {
  for (const [, entry] of dbConnections) {
    try { entry.db.close(); } catch (e) {}
  }
  dbConnections.clear();
}

// SFX and Music share one DB but split it on category. Video kinds (broll,
// transitions) get their own DB each so we don't filter — let them return
// everything in their DB.
const MEDIA_KIND_FILTERS = {
  sfx:         { sql: "AND ai_category != 'musical'", params: [] },
  music:       { sql: "AND ai_category  = 'musical'", params: [] },
  broll:       { sql: '', params: [] },
  transitions: { sql: '', params: [] },
};

function buildKindClause(kind) {
  return MEDIA_KIND_FILTERS[kind] || { sql: '', params: [] };
}

const VIDEO_KINDS = new Set(['broll', 'transitions']);
function isVideoKind(kind) { return VIDEO_KINDS.has(kind); }

// ---- IPC handlers --------------------------------------------------------

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  const cur = loadSettings();
  const next = { ...cur, ...patch };
  saveSettings(next);
  return next;
});

/** Deep-merge a per-kind settings update — `kind:'broll', dbPath:'/foo'`
 *  merges into settings.dbPaths.broll without clobbering other kinds. */
function patchPerKind(field, kind, value) {
  const settings = loadSettings();
  const map = { ...(settings[field] || {}) };
  if (value) map[kind] = value;
  else delete map[kind];
  saveSettings({ ...settings, [field]: map });
}

ipcMain.handle('db:status', (_e, { kind } = {}) => {
  const dbPath = resolveDbPath(kind || 'sfx');
  return { dbPath, ok: !!dbPath, kind: kind || 'sfx' };
});

ipcMain.handle('db:open-picker', async (_e, { kind } = {}) => {
  const k = kind || 'sfx';
  const r = await dialog.showOpenDialog({
    title: `Select the ${k.toUpperCase()} library database (.db)`,
    properties: ['openFile'],
    filters: [{ name: 'SQLite database', extensions: ['db'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  patchPerKind('dbPaths', k, r.filePaths[0]);
  // Also keep legacy dbPath in sync for SFX (so old settings field still works)
  if (k === 'sfx') {
    const settings = loadSettings();
    saveSettings({ ...settings, dbPath: r.filePaths[0] });
  }
  closeAllDbs();
  return r.filePaths[0];
});

ipcMain.handle('library:pick-folder', async (_e, { kind } = {}) => {
  const k = kind || 'sfx';
  const r = await dialog.showOpenDialog({
    title: `Select the ${k.toUpperCase()} folder on this Mac`,
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  patchPerKind('libraryPaths', k, r.filePaths[0]);
  if (k === 'sfx') {
    const settings = loadSettings();
    saveSettings({ ...settings, libraryPath: r.filePaths[0] });
  }
  return r.filePaths[0];
});

ipcMain.handle('stats', (_e, { kind } = {}) => {
  const db = getDb(kind || 'sfx');
  if (!db) return { error: 'no database', kind };
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
  const db = getDb(kind || 'sfx');
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

// In-memory search index per kind. Built lazily on first search and reset
// when the underlying DB changes (e.g. user picks a different file).
const searchIndexCache = new Map();

function invalidateSearchCaches(kind) {
  if (kind) {
    searchIndexCache.delete(kind);
    vocabCache.delete(kind);
    vocabCache.delete(kind || '*');
  } else {
    searchIndexCache.clear();
    vocabCache.clear();
  }
}

function buildSearchIndex(kind) {
  const cacheKey = `${kind || '*'}`;
  if (searchIndexCache.has(cacheKey)) return searchIndexCache.get(cacheKey);
  const db = getDb(kind || 'sfx');
  if (!db) return [];
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
  if (!idx) return [];
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
  const db = getDb(kind || 'sfx');
  if (!db) return { results: [], suggestions: [], error: 'no database for ' + (kind || 'sfx') };

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
              waveform_peaks, transcript,
              media_type, width, height, fps, video_codec, thumbnail_path
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
        media_type: r.media_type || 'audio',
        width: r.width,
        height: r.height,
        fps: r.fps,
        video_codec: r.video_codec,
        thumbnail_path: r.thumbnail_path,
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
 * Read a media file (audio OR video) off disk and return raw bytes + MIME.
 * Renderer wraps the bytes in a Blob and creates an object URL.
 *
 * For video, this returns the whole file — fine for short B-roll, slower
 * for multi-GB clips. We accept that for now; future optimisation could
 * stream via a custom protocol.
 */
ipcMain.handle('audio:read', (_e, { filepath_relative, kind } = {}) => {
  const root = resolveLibraryPath(kind || 'sfx');
  if (!root) return { error: 'library folder not set — open Settings' };
  const full = path.join(root, String(filepath_relative).replace(/[\\/]/g, path.sep));
  if (!fs.existsSync(full)) return { error: `file missing on disk: ${full}` };
  try {
    const buf = fs.readFileSync(full);
    return {
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      mime: mediaMime(full),
      absolutePath: full,
    };
  } catch (e) {
    return { error: 'read failed: ' + (e && e.message ? e.message : String(e)) };
  }
});

ipcMain.handle('audio:resolve-path', (_e, { filepath_relative, kind } = {}) => {
  const root = resolveLibraryPath(kind || 'sfx');
  if (!root) return { error: 'library folder not set' };
  const full = path.join(root, String(filepath_relative).replace(/[\\/]/g, path.sep));
  if (!fs.existsSync(full)) return { error: `file missing: ${full}` };
  return { absolutePath: full };
});

/** Read a thumbnail JPEG off disk. Used by video result rows. */
ipcMain.handle('thumbnail:read', (_e, { thumbnail_path } = {}) => {
  if (!thumbnail_path || !fs.existsSync(thumbnail_path)) {
    return { error: 'thumbnail missing' };
  }
  try {
    const buf = fs.readFileSync(thumbnail_path);
    return {
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      mime: 'image/jpeg',
    };
  } catch (e) {
    return { error: 'read failed: ' + (e && e.message ? e.message : String(e)) };
  }
});

ipcMain.handle('reveal', (_e, { absolutePath }) => {
  if (!absolutePath) return false;
  shell.showItemInFolder(absolutePath);
  return true;
});

/**
 * Native OS-level drag-out. Renderer calls this from a `dragstart` listener.
 * Premiere (and any other macOS app that accepts file drops) treats this the
 * same as dragging from Finder — because that's exactly what it is at the
 * AppKit level.
 *
 * Important: must be called synchronously inside the dragstart event, which
 * is why this is `ipcMain.on` (fire-and-forget) not `handle` (async).
 */
/**
 * Find an installed Premiere variant by scanning /Applications/. Returns the
 * full app name (without .app suffix) suitable for `open -a`, or null if
 * nothing is found. Prefers the most recent year (highest folder number).
 */
function detectPremiereApp() {
  if (process.platform !== 'darwin') return null;
  const candidates = [];
  try {
    for (const entry of fs.readdirSync('/Applications')) {
      if (!/premiere/i.test(entry)) continue;
      // Walk one level deeper too — Adobe installs at /Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app
      const top = path.join('/Applications', entry);
      try {
        const st = fs.statSync(top);
        if (st.isDirectory() && entry.endsWith('.app')) {
          candidates.push(entry.replace(/\.app$/, ''));
        } else if (st.isDirectory()) {
          for (const sub of fs.readdirSync(top)) {
            if (sub.endsWith('.app') && /premiere/i.test(sub)) {
              candidates.push(sub.replace(/\.app$/, ''));
            }
          }
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* skip */ }
  if (!candidates.length) return null;
  // Sort so newest year wins ("Adobe Premiere Pro 2026" > "...2025" > "...CC")
  candidates.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return candidates[0];
}

ipcMain.handle('detect-premiere', () => detectPremiereApp());

/**
 * Open a file in Premiere via macOS `open -a`. Premiere imports it into the
 * active project's bin. Accepts either a `filepath_relative` (resolved
 * against the user's audio folder) or a direct `absolutePath`.
 *
 * App name resolution order:
 *   1. settings.premiereAppName (explicit override)
 *   2. Auto-detected from /Applications/
 *   3. "Adobe Premiere Pro" (last-ditch)
 *
 * `execFile` captures the actual exit code so failures are reported back
 * instead of silently "succeeding".
 */
ipcMain.handle('send-to-premiere', async (_e, args = {}) => {
  let full = null;
  if (args.absolutePath) {
    full = args.absolutePath;
  } else if (args.filepath_relative) {
    const root = resolveLibraryPath(args.kind || 'sfx');
    if (!root) return { error: 'library folder not set — open Settings' };
    full = path.join(root, String(args.filepath_relative).replace(/[\\/]/g, path.sep));
  }
  if (!full) return { error: 'no file specified' };
  if (!fs.existsSync(full)) return { error: `file missing on disk: ${full}` };
  if (process.platform !== 'darwin') {
    return { error: 'Send to Premiere only works on macOS for now' };
  }

  const settings = loadSettings();
  const explicit = (settings.premiereAppName || '').trim();
  const detected = detectPremiereApp();
  const appName = explicit || detected || 'Adobe Premiere Pro';

  return await new Promise((resolve) => {
    execFile('open', ['-a', appName, full], { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        const msg = (stderr && stderr.toString().trim()) || error.message || 'unknown error';
        resolve({
          error: `Couldn't open in "${appName}": ${msg}. ` +
                 `Try setting the exact Premiere app name in Settings.`,
          appName,
          tried: { explicit, detected },
        });
        return;
      }
      resolve({ success: true, appName, full });
    });
  });
});

// ----- temp trim files -------------------------------------------------

const TEMP_TRIMS_DIR = path.join(os.tmpdir(), 'editors-librarian');
const TEMP_TTL_MS = 60 * 60 * 1000; // 1 hour

function cleanTempTrims() {
  try {
    if (!fs.existsSync(TEMP_TRIMS_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(TEMP_TRIMS_DIR)) {
      const full = path.join(TEMP_TRIMS_DIR, f);
      try {
        const stats = fs.statSync(full);
        if (now - stats.mtimeMs > TEMP_TTL_MS) fs.unlinkSync(full);
      } catch (e) { /* keep going */ }
    }
  } catch (e) { /* non-fatal */ }
}

/**
 * Write an ArrayBuffer (the renderer-encoded trimmed WAV) to OS tmp, and
 * return its absolute path. The renderer hands this path to send-to-premiere.
 */
ipcMain.handle('audio:save-temp', (_e, { bytes, filename }) => {
  if (!bytes || !filename) return { error: 'missing args' };
  try {
    fs.mkdirSync(TEMP_TRIMS_DIR, { recursive: true });
    const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, '_');
    const stamp = Date.now().toString(36);
    const full = path.join(TEMP_TRIMS_DIR, `${stamp}_${safe}`);
    fs.writeFileSync(full, Buffer.from(bytes));
    return { absolutePath: full };
  } catch (e) {
    return { error: 'write failed: ' + (e && e.message ? e.message : String(e)) };
  }
});

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.on('start-drag-file', (event, payload) => {
  // Accept either a string filepath_relative (legacy) or { filepath_relative, kind }
  let filepath_relative, kind;
  if (typeof payload === 'string') { filepath_relative = payload; kind = 'sfx'; }
  else { filepath_relative = payload.filepath_relative; kind = payload.kind || 'sfx'; }
  const root = resolveLibraryPath(kind);
  if (!root) return;
  const full = path.join(root, String(filepath_relative).replace(/[\\/]/g, path.sep));
  if (!fs.existsSync(full)) return;

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'drag-icon.png')
    : path.join(__dirname, 'build', 'drag-icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch (e) {
    icon = nativeImage.createEmpty();
  }

  event.sender.startDrag({ file: full, icon });
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
  cleanTempTrims();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
