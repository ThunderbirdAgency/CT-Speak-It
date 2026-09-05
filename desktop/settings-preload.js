const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "mbapp",
  Object.fromEntries(
    [
      ["getConfig", "mb:get-config"],
      ["saveConfig", "mb:save-config"],
      ["getHistory", "mb:get-history"],
      ["clearHistory", "mb:clear-history"],
      ["copyHistory", "mb:copy-history"],
      ["connect", "mb:connect"],
      ["disconnect", "mb:disconnect"],
      ["openAccount", "mb:open-account"],
      ["retry", "mb:retry"],
      ["forgetRecording", "mb:forget-recording"],
      ["checkUpdates", "mb:check-updates"],
      ["installUpdate", "mb:install-update"],
      ["microphone", "mb:microphone"],
      ["quit", "mb:quit"],
    ]
      .map(([name, channel]) => [
        name,
        (...args) => ipcRenderer.invoke(channel, ...args),
      ])
      .concat([
        [
          "onHistoryChanged",
          (cb) => ipcRenderer.on("mb:history-changed", () => cb()),
        ],
      ]),
  ),
);
