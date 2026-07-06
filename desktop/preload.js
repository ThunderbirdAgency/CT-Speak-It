const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mb', {
  onBegin: (cb) => ipcRenderer.on('mb-begin', (event, config) => cb(config)),
  onFinish: (cb) => ipcRenderer.on('mb-finish', () => cb()),
  insert: (text) => ipcRenderer.send('mb-insert', text),
  state: (state) => ipcRenderer.send('mb-state', state)
});
