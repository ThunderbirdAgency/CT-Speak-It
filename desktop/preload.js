/**
 * The only bridge between Mockingbird's windows and the main process.
 *
 * window.mb    — the listening overlay: records audio, draws the pill.
 * window.mbapp — the Mockingbird window: setup, connectors, history, profile.
 *
 * Neither renderer ever holds an API key or talks to the network; they hand
 * audio and intentions to main and get status back.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mb', {
  onListen: (cb) => ipcRenderer.on('mb:listen', (e, payload) => cb(payload)),
  onStop: (cb) => ipcRenderer.on('mb:stop', () => cb()),
  onCancel: (cb) => ipcRenderer.on('mb:cancel', () => cb()),
  onStatus: (cb) => ipcRenderer.on('mb:status', (e, payload) => cb(payload)),
  onConfirm: (cb) => ipcRenderer.on('mb:confirm', (e, payload) => cb(payload)),

  recordingStarted: () => ipcRenderer.send('mb:recording-started'),
  sendAudio: (bytes, mode) => ipcRenderer.send('mb:audio', { buffer: bytes, mode }),
  cancelled: () => ipcRenderer.send('mb:cancelled'),
  confirm: (accept) => ipcRenderer.send('mb:confirm-response', { accept })
});

contextBridge.exposeInMainWorld('mbapp', {
  getConfig: () => ipcRenderer.invoke('mb:get-config'),
  saveConfig: (patch) => ipcRenderer.invoke('mb:save-config', patch),
  getHistory: () => ipcRenderer.invoke('mb:get-history'),
  clearHistory: () => ipcRenderer.invoke('mb:clear-history'),
  checkDeployment: (baseUrl) => ipcRenderer.invoke('mb:check-deployment', baseUrl),
  listCommands: () => ipcRenderer.invoke('mb:list-commands'),
  profile: (action) => ipcRenderer.invoke('mb:profile', action),
  openConfigFile: () => ipcRenderer.invoke('mb:open-config-file'),
  dictateNow: () => ipcRenderer.invoke('mb:dictate-now'),
  quit: () => ipcRenderer.invoke('mb:quit'),

  onHistoryChanged: (cb) => ipcRenderer.on('mb:history-changed', () => cb()),
  onOpenTab: (cb) => ipcRenderer.on('mb:open-tab', (e, tab) => cb(tab))
});
