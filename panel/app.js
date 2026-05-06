/* SFX Librarian — panel client (presentation layer).
 *
 * All data access goes through ./data.js so the same code works in browser
 * (Flask backend) and in Premiere UXP (sql.js + UXP fs backend).
 */

import { data } from './data.js';

const $ = (id) => document.getElementById(id);
const $q = $('q');
const $results = $('results');
const $stats = $('stats');
const $hint = $('hint');
const $player = $('player');
const $nowPlaying = $('now-playing');
const $stopBtn = $('stop-btn');
const $suggestions = $('suggestions');
const $filters = $('filters');
const $libBtn = $('lib-btn');
const $libModal = $('lib-modal');
const $libInput = $('lib-input');
const $libSave = $('lib-save');
const $libCancel = $('lib-cancel');
const $libCurrent = $('lib-current');
const $libBrowse = $('lib-browse');
const $libNote = $('lib-note');

let currentPlayingId = null;
let activeSuggestionIdx = -1;
const selectedCategories = new Set();

const ICON_PLAY = '▶';
const ICON_PAUSE = '⏸';
const WAVE_W = 600;

// ----- bootstrap -----

loadStats();
loadCategories();
syncLibraryButtonLabel();

let searchTimer = null;
let suggestTimer = null;

$q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 200);
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(loadSuggestions, 80);
});
$q.addEventListener('keydown', handleKey);
$q.addEventListener('focus', () => {
  if ($q.value.trim().length >= 2) loadSuggestions();
});
$q.addEventListener('blur', () => setTimeout(() => hideSuggestions(), 150));

$stopBtn.addEventListener('click', stopPlayback);

if ($libBtn) $libBtn.addEventListener('click', openLibModal);
if ($libCancel) $libCancel.addEventListener('click', closeLibModal);
if ($libSave) $libSave.addEventListener('click', saveLibPath);
if ($libBrowse) $libBrowse.addEventListener('click', browseLibPath);
if ($libModal) $libModal.addEventListener('click', (e) => {
  if (e.target === $libModal) closeLibModal();
});

$player.addEventListener('play', () => {
  setAllPlayBtns(ICON_PLAY);
  const el = currentRowEl();
  if (el) el.querySelector('.play-btn').textContent = ICON_PAUSE;
});
$player.addEventListener('pause', () => {
  const el = currentRowEl();
  if (el) el.querySelector('.play-btn').textContent = ICON_PLAY;
});
$player.addEventListener('ended', () => {
  const el = currentRowEl();
  if (el) {
    el.classList.remove('playing');
    el.querySelector('.play-btn').textContent = ICON_PLAY;
  }
  currentPlayingId = null;
  $nowPlaying.textContent = '';
});
$player.addEventListener('timeupdate', () => {
  const el = currentRowEl();
  if (!el) return;
  const out = parseFloat(el.dataset.outSec || 'NaN');
  if (!isNaN(out) && $player.currentTime >= out) {
    $player.pause();
    $player.currentTime = parseFloat(el.dataset.inSec || '0') || 0;
  }
  const dur = parseFloat(el.dataset.duration || 'NaN');
  if (!isNaN(dur) && dur > 0) {
    const ph = el.querySelector('.playhead');
    if (ph) {
      const x = ($player.currentTime / dur) * WAVE_W;
      ph.setAttribute('x1', x.toFixed(2));
      ph.setAttribute('x2', x.toFixed(2));
    }
  }
});

// ----- data loaders -----

async function loadStats() {
  try {
    const d = await data.getStats();
    const tagPct = d.total ? Math.round(100 * d.tagged / d.total) : 0;
    $stats.textContent =
      `${d.tagged.toLocaleString()} / ${d.total.toLocaleString()} tagged (${tagPct}%)`;
  } catch (e) {
    $stats.textContent = 'stats unavailable';
  }
}

async function loadCategories() {
  try {
    const cats = await data.getCategories();
    renderFilters(cats || []);
  } catch (e) {
    // non-fatal
  }
}

async function doSearch() {
  const q = $q.value.trim();
  const cats = [...selectedCategories];
  if (!q && cats.length === 0) {
    $results.innerHTML = '';
    $hint.textContent = '';
    return;
  }
  $hint.textContent = 'searching…';
  try {
    const d = await data.search({ q, categories: cats, limit: 30 });
    if (d.error) { renderError(d.error); return; }
    renderResults(d.results, q, d.suggestions || []);
    const filterHint = cats.length ? ` · in ${cats.join(', ')}` : '';
    $hint.textContent =
      d.results.length === 0
        ? `no results${filterHint}`
        : `${d.results.length} result${d.results.length === 1 ? '' : 's'}${filterHint}`;
  } catch (e) {
    renderError(String(e));
  }
}

async function loadSuggestions() {
  const q = $q.value;
  if (q.trim().length < 2) { hideSuggestions(); return; }
  try {
    const items = await data.getSuggestions(q, 8);
    showSuggestions(items, q);
  } catch (e) {
    hideSuggestions();
  }
}

// ----- library folder modal -----

function syncLibraryButtonLabel() {
  if (!$libBtn) return;
  const path = data.getLibraryPath();
  $libBtn.textContent = path ? '📁 library' : '📁 set library…';
  $libBtn.title = path ? `Library: ${path}` : 'Set the SFX library folder for this machine';
}

function openLibModal() {
  if (!$libModal) return;
  $libInput.value = data.getLibraryPath() || '';
  $libCurrent.textContent = $libInput.value || '(not set on this machine)';
  if ($libNote) $libNote.textContent = '';
  $libModal.classList.add('show');
  setTimeout(() => $libInput.focus(), 50);
}

function closeLibModal() {
  if ($libModal) $libModal.classList.remove('show');
}

function saveLibPath() {
  const v = ($libInput.value || '').trim();
  data.setLibraryPath(v);
  syncLibraryButtonLabel();
  closeLibModal();
}

async function browseLibPath() {
  if (!$libBrowse) return;
  $libBrowse.disabled = true;
  const oldText = $libBrowse.textContent;
  $libBrowse.textContent = '… opening';
  try {
    const result = await data.pickFolder();
    if (!result) {
      // User cancelled
      return;
    }
    $libInput.value = result.path;
    if (result.complete) {
      // UXP returned a real native path
      if ($libNote) $libNote.textContent = '';
    } else {
      // Browser returned only the folder name — user must prepend the parent path
      if ($libNote) {
        $libNote.textContent =
          'Browsers only return the folder name (security restriction). ' +
          'Please prepend the full parent path before saving — e.g. ' +
          'E:\\…\\ on Windows or /Volumes/…/ on Mac. The native picker will work properly inside Premiere on Mac.';
      }
      $libInput.focus();
      $libInput.setSelectionRange(0, 0);
    }
  } catch (e) {
    if ($libNote) $libNote.textContent = 'Picker failed: ' + String(e);
  } finally {
    $libBrowse.disabled = false;
    $libBrowse.textContent = oldText;
  }
}

// ----- category filters -----

function renderFilters(cats) {
  if (!cats.length) { $filters.innerHTML = ''; return; }
  const buttons = cats.map(c =>
    `<button class="filter-btn" type="button" data-cat="${escapeHtml(c.name)}">
       ${escapeHtml(c.name)}<span class="count">${c.count}</span>
     </button>`
  ).join('');
  $filters.innerHTML = buttons +
    `<button class="filter-btn filter-clear" type="button" id="filter-clear" hidden>clear filters</button>`;

  $filters.querySelectorAll('.filter-btn[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => toggleCategory(btn.dataset.cat, btn));
  });
  const clear = $('filter-clear');
  if (clear) clear.addEventListener('click', clearAllCategories);
}

function toggleCategory(cat, btn) {
  if (selectedCategories.has(cat)) {
    selectedCategories.delete(cat);
    btn.classList.remove('active');
  } else {
    selectedCategories.add(cat);
    btn.classList.add('active');
  }
  updateClearVisibility();
  doSearch();
}

function clearAllCategories() {
  selectedCategories.clear();
  $filters.querySelectorAll('.filter-btn.active').forEach(b => b.classList.remove('active'));
  updateClearVisibility();
  doSearch();
}

function updateClearVisibility() {
  const clear = $('filter-clear');
  if (clear) clear.hidden = selectedCategories.size === 0;
}

// ----- suggestion dropdown -----

function showSuggestions(items, currentQuery) {
  if (!items.length || items.every(s => s === currentQuery)) {
    hideSuggestions(); return;
  }
  const lastToken = currentQuery.split(/\s+/).pop().toLowerCase();
  $suggestions.innerHTML = items.map(s => {
    const lower = s.toLowerCase();
    const idx = lastToken ? lower.lastIndexOf(lastToken) : -1;
    let html;
    if (idx >= 0 && lastToken.length > 0) {
      html = escapeHtml(s.slice(0, idx)) +
        '<span class="match">' + escapeHtml(s.slice(idx, idx + lastToken.length)) + '</span>' +
        escapeHtml(s.slice(idx + lastToken.length));
    } else {
      html = escapeHtml(s);
    }
    return `<div class="suggestion-item" role="option" data-suggestion="${escapeHtml(s)}">${html}</div>`;
  }).join('');
  $suggestions.classList.add('show');
  activeSuggestionIdx = -1;
  $suggestions.querySelectorAll('.suggestion-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      acceptSuggestion(el.dataset.suggestion);
    });
  });
}

function hideSuggestions() {
  $suggestions.classList.remove('show');
  $suggestions.innerHTML = '';
  activeSuggestionIdx = -1;
}

function acceptSuggestion(text) {
  $q.value = text;
  hideSuggestions();
  $q.focus();
  doSearch();
}

function handleKey(e) {
  const items = $suggestions.querySelectorAll('.suggestion-item');
  if (e.key === 'ArrowDown' && items.length) {
    e.preventDefault();
    activeSuggestionIdx = Math.min(activeSuggestionIdx + 1, items.length - 1);
    updateActiveSuggestion(items);
  } else if (e.key === 'ArrowUp' && items.length) {
    e.preventDefault();
    activeSuggestionIdx = Math.max(activeSuggestionIdx - 1, -1);
    updateActiveSuggestion(items);
  } else if (e.key === 'Enter') {
    if (activeSuggestionIdx >= 0 && items[activeSuggestionIdx]) {
      e.preventDefault();
      acceptSuggestion(items[activeSuggestionIdx].dataset.suggestion);
    } else {
      hideSuggestions();
    }
  } else if (e.key === 'Tab' && items.length && activeSuggestionIdx >= 0) {
    e.preventDefault();
    acceptSuggestion(items[activeSuggestionIdx].dataset.suggestion);
  } else if (e.key === 'Escape') {
    if ($suggestions.classList.contains('show')) {
      hideSuggestions();
    } else if ($libModal && $libModal.classList.contains('show')) {
      closeLibModal();
    } else {
      $q.value = '';
      $results.innerHTML = '';
      $hint.textContent = '';
    }
  }
}

function updateActiveSuggestion(items) {
  items.forEach((el, i) => {
    el.classList.toggle('active', i === activeSuggestionIdx);
    if (i === activeSuggestionIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

// ----- result rendering -----

function renderResults(rows, query, suggestions) {
  if (!rows.length) {
    let html = '<p class="empty">No results.';
    if (suggestions && suggestions.length) {
      html += '</p>' + renderDidYouMean(query, suggestions);
    } else {
      html += ' Try fewer or different words.</p>';
    }
    $results.innerHTML = html;
    wireDidYouMean();
    return;
  }
  const queryTokens = new Set(
    query.toLowerCase().split(/\s+/).filter(t => t.length > 0)
  );
  $results.innerHTML = '';
  for (const row of rows) {
    const el = renderResult(row, queryTokens);
    $results.appendChild(el);
    wireWaveformSelection(el, row);
  }
}

function renderDidYouMean(query, suggestions) {
  const tokens = query.toLowerCase().split(/\s+/);
  const chips = suggestions.map(s => {
    const candidate = tokens.map(t => (s.startsWith(t.slice(0, 2)) ? s : t)).join(' ');
    const replacement = candidate === query ? s : candidate;
    return `<span class="sug" data-q="${escapeHtml(replacement)}">${escapeHtml(s)}</span>`;
  }).join('');
  return `<div class="did-you-mean"><span class="did-you-mean-label">Did you mean:</span>${chips}</div>`;
}

function wireDidYouMean() {
  $results.querySelectorAll('.did-you-mean .sug').forEach(el => {
    el.addEventListener('click', () => {
      $q.value = el.dataset.q;
      hideSuggestions();
      doSearch();
      $q.focus();
    });
  });
}

function renderResult(row, queryTokens) {
  const el = document.createElement('div');
  el.className = 'result';
  el.dataset.id = String(row.id);
  el.dataset.duration = String(row.duration || 0);

  const dur = row.duration ? row.duration.toFixed(1) + 's' : '—';
  const lufs = row.lufs != null ? row.lufs.toFixed(1) + ' LUFS' : '';
  const meta = [dur, lufs].filter(Boolean).join(' · ');
  const cat = row.category || 'other';

  const topTags = (row.tags || []).slice(0, 14);
  const tagsHtml = topTags.map(t => {
    const matched = queryTokens.has(t.toLowerCase()) ||
      [...queryTokens].some(qt => t.toLowerCase().includes(qt));
    return `<span class="tag${matched ? ' matched' : ''}">${escapeHtml(t)}</span>`;
  }).join('');

  el.innerHTML = `
    <div class="result-header">
      <button class="play-btn" type="button" aria-label="Play or pause">${ICON_PLAY}</button>
      <span class="filename">${escapeHtml(row.filename)}</span>
      <span class="meta">${escapeHtml(meta)}</span>
    </div>
    <div class="mood">
      <span class="category-pill category-${escapeHtml(cat)}">${escapeHtml(cat)}</span>
      ${row.mood ? escapeHtml(row.mood) : ''}
    </div>
    <div class="result-tags">${tagsHtml}</div>
    ${renderWaveformSvg(row.peaks)}
  `;

  el.querySelector('.result-header').addEventListener('click', () => togglePlayRow(row, el));
  return el;
}

function renderWaveformSvg(peaks) {
  if (!peaks || !peaks.length) return '';
  const w = WAVE_W;
  const h = 32;
  const n = peaks.length;
  const barW = w / n;
  let bars = '';
  for (let i = 0; i < n; i++) {
    const ph = Math.max(1, peaks[i] * (h - 2));
    const x = i * barW;
    const y = (h - ph) / 2;
    bars += `<rect class="peak" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(barW - 0.4).toFixed(2)}" height="${ph.toFixed(2)}"/>`;
  }
  return `
    <div class="waveform-wrap">
      <svg class="waveform" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        ${bars}
        <rect class="selection" x="0" y="0" width="0" height="${h}"/>
        <rect class="handle handle-in"  x="-2" y="0" width="2" height="${h}"/>
        <rect class="handle-hit handle-hit-in"  x="-7" y="0" width="14" height="${h}"/>
        <rect class="handle handle-out" x="-2" y="0" width="2" height="${h}"/>
        <rect class="handle-hit handle-hit-out" x="-7" y="0" width="14" height="${h}"/>
        <line class="playhead" x1="0" y1="0" x2="0" y2="${h}"/>
      </svg>
      <div class="range-info">
        <span class="range-times"></span>
        <button class="save-trim-btn" type="button" title="Save the selected section as a new WAV file">⬇ Save trim</button>
        <button class="clear-trim-btn" type="button" title="Clear selection">✕</button>
      </div>
    </div>
  `;
}

function renderError(msg) {
  $results.innerHTML = `<div class="error">${escapeHtml(msg)}</div>`;
  $hint.textContent = '';
}

// ----- waveform in/out selection -----

function wireWaveformSelection(resultEl, row) {
  const wrap = resultEl.querySelector('.waveform-wrap');
  const svg = resultEl.querySelector('.waveform');
  if (!svg || !wrap) return;
  const sel = svg.querySelector('.selection');
  const handleIn = svg.querySelector('.handle-in');
  const handleOut = svg.querySelector('.handle-out');
  const handleHitIn = svg.querySelector('.handle-hit-in');
  const handleHitOut = svg.querySelector('.handle-hit-out');
  const info = resultEl.querySelector('.range-info');
  const rangeTimes = info.querySelector('.range-times');
  const saveBtn = info.querySelector('.save-trim-btn');
  const clearBtn = info.querySelector('.clear-trim-btn');
  const duration = row.duration || 0;
  if (!duration) return;
  const HANDLE_VIS_W = 2;
  const HANDLE_HIT_W = 14;

  let mode = null;
  let startFrac = 0;
  let curIn = 0;
  let curOut = 0;

  function xToFrac(clientX) {
    const rect = svg.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function applySelection(fracIn, fracOut) {
    const lo = Math.min(fracIn, fracOut);
    const hi = Math.max(fracIn, fracOut);
    curIn = lo; curOut = hi;
    if (hi - lo < 0.005) { clearSelection(); return; }
    const x = lo * WAVE_W;
    const w = (hi - lo) * WAVE_W;
    sel.setAttribute('x', x.toFixed(2));
    sel.setAttribute('width', w.toFixed(2));
    handleIn.setAttribute('x', (x - HANDLE_VIS_W / 2).toFixed(2));
    handleOut.setAttribute('x', (x + w - HANDLE_VIS_W / 2).toFixed(2));
    handleHitIn.setAttribute('x', (x - HANDLE_HIT_W / 2).toFixed(2));
    handleHitOut.setAttribute('x', (x + w - HANDLE_HIT_W / 2).toFixed(2));
    wrap.classList.add('has-selection');

    const inSec = lo * duration;
    const outSec = hi * duration;
    resultEl.dataset.inSec = String(inSec);
    resultEl.dataset.outSec = String(outSec);
    rangeTimes.textContent =
      `${inSec.toFixed(2)}s → ${outSec.toFixed(2)}s · ${(outSec - inSec).toFixed(2)}s`;

    if (currentPlayingId === row.id) {
      if ($player.currentTime < inSec || $player.currentTime > outSec) {
        $player.currentTime = inSec;
      }
    }
  }

  function clearSelection() {
    curIn = 0; curOut = 0;
    sel.setAttribute('width', '0');
    handleIn.setAttribute('x', String(-HANDLE_VIS_W));
    handleOut.setAttribute('x', String(-HANDLE_VIS_W));
    handleHitIn.setAttribute('x', String(-HANDLE_HIT_W));
    handleHitOut.setAttribute('x', String(-HANDLE_HIT_W));
    wrap.classList.remove('has-selection');
    rangeTimes.textContent = '';
    delete resultEl.dataset.inSec;
    delete resultEl.dataset.outSec;
  }

  function startDrag(e, m) {
    e.preventDefault(); e.stopPropagation();
    mode = m;
    startFrac = xToFrac(e.clientX);
    if (m === 'new') applySelection(startFrac, startFrac);
  }

  handleHitIn.addEventListener('mousedown', e => startDrag(e, 'in'));
  handleHitOut.addEventListener('mousedown', e => startDrag(e, 'out'));
  svg.addEventListener('mousedown', (e) => {
    if (e.target === handleHitIn || e.target === handleHitOut) return;
    startDrag(e, 'new');
  });

  window.addEventListener('mousemove', (e) => {
    if (!mode) return;
    const f = xToFrac(e.clientX);
    if (mode === 'new')      applySelection(startFrac, f);
    else if (mode === 'in')  applySelection(Math.min(f, curOut - 0.005), curOut);
    else if (mode === 'out') applySelection(curIn, Math.max(f, curIn + 0.005));
  });

  window.addEventListener('mouseup', (e) => {
    if (!mode) return;
    const wasMode = mode;
    mode = null;
    if (wasMode === 'new') {
      const endFrac = xToFrac(e.clientX);
      if (Math.abs(endFrac - startFrac) < 0.005) {
        const seekTo = startFrac * duration;
        if (currentPlayingId === row.id) {
          $player.currentTime = seekTo;
        } else {
          togglePlayRow(row, resultEl);
          const onLoaded = () => {
            try { $player.currentTime = seekTo; } catch (e) {}
            $player.removeEventListener('loadedmetadata', onLoaded);
          };
          $player.addEventListener('loadedmetadata', onLoaded);
        }
        clearSelection();
      }
    }
  });

  if (saveBtn) {
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const inSec = resultEl.dataset.inSec;
      const outSec = resultEl.dataset.outSec;
      if (!inSec || !outSec) return;
      saveBtn.disabled = true;
      const oldText = saveBtn.textContent;
      saveBtn.textContent = '… working';
      data.trim(row, inSec, outSec);
      setTimeout(() => {
        saveBtn.disabled = false;
        saveBtn.textContent = oldText;
      }, 1500);
    });
  }
  if (clearBtn) clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearSelection();
  });
}

// ----- playback -----

async function togglePlayRow(row, el) {
  if (currentPlayingId === row.id) {
    if ($player.paused) {
      const inSec = parseFloat(el.dataset.inSec || 'NaN');
      if (!isNaN(inSec) && ($player.currentTime < inSec ||
          $player.currentTime >= parseFloat(el.dataset.outSec || 'Infinity'))) {
        $player.currentTime = inSec;
      }
      $player.play().catch(() => {});
    } else {
      $player.pause();
    }
    return;
  }
  clearPlayingClass();
  el.classList.add('playing');
  el.querySelector('.play-btn').textContent = ICON_PAUSE;
  currentPlayingId = row.id;
  $nowPlaying.textContent = row.filename;
  try {
    $player.src = await data.getAudioUrl(row);
  } catch (e) {
    $nowPlaying.textContent = String(e.message || e);
    el.classList.remove('playing');
    el.querySelector('.play-btn').textContent = ICON_PLAY;
    currentPlayingId = null;
    return;
  }

  const inSec = parseFloat(el.dataset.inSec || 'NaN');
  if (!isNaN(inSec)) {
    const onLoaded = () => {
      try { $player.currentTime = inSec; } catch (e) {}
      $player.removeEventListener('loadedmetadata', onLoaded);
    };
    $player.addEventListener('loadedmetadata', onLoaded);
  }
  $player.play().catch(() => {});
}

function stopPlayback() {
  $player.pause();
  try { $player.currentTime = 0; } catch (e) {}
  $player.removeAttribute('src');
  $player.load();
  clearPlayingClass();
  currentPlayingId = null;
  $nowPlaying.textContent = '';
}

function clearPlayingClass() {
  document.querySelectorAll('.result.playing').forEach(n => {
    n.classList.remove('playing');
    const btn = n.querySelector('.play-btn');
    if (btn) btn.textContent = ICON_PLAY;
  });
}

function currentRowEl() {
  if (currentPlayingId == null) return null;
  return document.querySelector(`.result[data-id="${currentPlayingId}"]`);
}

function setAllPlayBtns(text) {
  document.querySelectorAll('.play-btn').forEach(b => b.textContent = text);
}

// ----- utils -----

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
