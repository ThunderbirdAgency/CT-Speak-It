const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("mb", {
  onListen: (cb) => ipcRenderer.on("mb:listen", (_, p) => cb(p)),
  onStop: (cb) => ipcRenderer.on("mb:stop", () => cb()),
  onCancel: (cb) => ipcRenderer.on("mb:cancel", (_, p) => cb(p || {})),
  onStatus: (cb) => ipcRenderer.on("mb:status", (_, p) => cb(p)),
  onConfirm: (cb) => ipcRenderer.on("mb:confirm", (_, p) => cb(p)),
  recordingError: (sessionId) =>
    ipcRenderer.send("mb:recording-error", { sessionId }),
  sendAudio: (bytes, mode, sessionId) =>
    ipcRenderer.send("mb:audio", { buffer: bytes, mode, sessionId }),
  cancelled: (sessionId) => ipcRenderer.send("mb:cancelled", { sessionId }),
  confirm: (accept) => ipcRenderer.send("mb:confirm-response", { accept }),
});
