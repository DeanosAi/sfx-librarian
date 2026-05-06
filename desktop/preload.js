/**
 * Preload script — runs with Node access in an isolated context.
 * Exposes a minimal, deliberately-narrow API to the renderer via window.api.
 *
 * The renderer cannot access Node APIs directly. Everything goes through these
 * named channels, which match the ipcMain.handle(...) registrations in main.js.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings:      ()       => ipcRenderer.invoke('settings:get'),
  setSettings:      (patch)  => ipcRenderer.invoke('settings:set', patch),

  dbStatus:         ()       => ipcRenderer.invoke('db:status'),
  pickDb:           ()       => ipcRenderer.invoke('db:open-picker'),
  pickLibrary:      ()       => ipcRenderer.invoke('library:pick-folder'),

  stats:            (args)   => ipcRenderer.invoke('stats', args || {}),
  categories:       (args)   => ipcRenderer.invoke('categories', args || {}),
  search:           (args)   => ipcRenderer.invoke('search', args || {}),
  suggest:          (args)   => ipcRenderer.invoke('suggest', args || {}),

  resolveAudio:     (args)   => ipcRenderer.invoke('audio:resolve', args || {}),
  revealInFinder:   (args)   => ipcRenderer.invoke('reveal', args || {}),
});
