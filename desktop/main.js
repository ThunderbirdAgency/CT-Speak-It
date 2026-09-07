/** Consumer desktop: verified device sessions, dictation and reviewed rewrites. */
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  session,
  clipboard,
  ipcMain,
  screen,
  shell,
  nativeImage,
  Notification,
  safeStorage,
  systemPreferences,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { randomUUID } = require("crypto");
const { autoUpdater } = require("electron-updater");
const DEFAULT_CONFIG = {
  baseUrl: "",
  dictationHotkey: "CommandOrControl+Shift+Space",
  rewriteHotkey: "CommandOrControl+Shift+R",
  tone: "clean",
  lang: "en-US",
  autoPaste: true,
  learn: false,
  keepHistory: false,
  launchAtLogin: true,
  autoStopSeconds: 0,
  dictionary: [],
};
let overlay,
  settingsWindow,
  tray,
  active = null,
  lastRecording = null,
  hideTimer,
  updateReady = false;
const configPath = () => path.join(app.getPath("userData"), "config.json");
const historyPath = () => path.join(app.getPath("userData"), "history.json");
const authPath = () => path.join(app.getPath("userData"), "session.bin");
function loadConfig() {
  try {
    const s = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...Object.fromEntries(
        Object.keys(DEFAULT_CONFIG)
          .filter((k) => k in s)
          .map((k) => [k, s[k]]),
      ),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function secureAvailable() {
  return (
    safeStorage.isEncryptionAvailable() &&
    safeStorage.getSelectedStorageBackend?.() !== "basic_text"
  );
}
function readAuth() {
  try {
    return secureAvailable()
      ? JSON.parse(safeStorage.decryptString(fs.readFileSync(authPath())))
      : null;
  } catch {
    return null;
  }
}
function writeAuth(value) {
  if (!secureAvailable())
    throw new Error(
      "Secure system credential storage is unavailable. Unlock your system keychain and try again.",
    );
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(
    authPath(),
    safeStorage.encryptString(JSON.stringify(value)),
    { mode: 0o600 },
  );
}
function saveConfig(patch) {
  const next = { ...loadConfig() };
  for (const k of Object.keys(DEFAULT_CONFIG))
    if (k in patch) next[k] = patch[k];
  next.baseUrl = loadConfig().baseUrl; // Only a successfully exchanged connection code can set the server.
  for (const k of ["autoPaste", "learn", "keepHistory", "launchAtLogin"])
    next[k] = Boolean(next[k]);
  for (const k of ["dictationHotkey", "rewriteHotkey"])
    if (typeof next[k] !== "string" || next[k].length > 100)
      throw new Error("Invalid shortcut");
  if (!["clean", "formal", "casual", "code-comment"].includes(next.tone))
    next.tone = "clean";
  next.lang = String(next.lang).slice(0, 20);
  next.autoStopSeconds = Math.min(
    20,
    Math.max(0, Number(next.autoStopSeconds) || 0),
  );
  next.dictionary = Array.isArray(next.dictionary)
    ? next.dictionary
        .filter((x) => typeof x === "string")
        .slice(0, 200)
        .map((x) => x.slice(0, 100))
    : [];
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), {
    mode: 0o600,
  });
  applyConfig(next);
  return publicConfig();
}
function publicConfig() {
  return {
    ...loadConfig(),
    connected: Boolean(readAuth()),
    sessionExpiresAt: readAuth()?.expiresAt || null,
    canRetry: Boolean(lastRecording),
    updateReady,
    version: app.getVersion(),
  };
}
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(historyPath(), "utf8"));
  } catch {
    return [];
  }
}
function pushHistory(entry) {
  if (!loadConfig().keepHistory) return;
  fs.writeFileSync(
    historyPath(),
    JSON.stringify(
      [{ at: new Date().toISOString(), ...entry }, ...loadHistory()].slice(
        0,
        200,
      ),
    ),
    { mode: 0o600 },
  );
  settingsWindow?.webContents.send("mb:history-changed");
}
function notify(title, body) {
  try {
    new Notification({ title, body }).show();
  } catch {}
}
function trustedURL(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search
  )
    throw new Error("Use the connection code from your Mockingbird account.");
  return u.origin;
}
async function api(
  route,
  { body, raw = false, method = "POST", baseUrl, token, signal } = {},
) {
  const cfg = loadConfig();
  const base = trustedURL(baseUrl || cfg.baseUrl);
  const auth = token === undefined ? readAuth()?.token : token;
  const r = await fetch(base + route, {
    method,
    redirect: "error",
    headers: {
      ...(auth ? { Authorization: "Bearer " + auth } : {}),
      "Content-Type": raw ? "audio/webm" : "application/json",
      "X-Mockingbird-Lang": cfg.lang,
    },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
      : AbortSignal.timeout(45000),
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error(
      "The service did not return a valid response. Please try again.",
    );
  }
  if (!r.ok)
    throw new Error(data.error || "The request failed. Please try again.");
  return data;
}
function send(channel, payload) {
  if (overlay && !overlay.isDestroyed())
    overlay.webContents.send(channel, payload);
}
function status(state, message, detail) {
  send("mb:status", { state, message, detail });
}
function hideSoon(ms = 1800) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!active) overlay?.hide();
  }, ms);
}
function positionOverlay() {
  const { workArea } = screen.getDisplayNearestPoint(
    screen.getCursorScreenPoint(),
  );
  const [w, h] = overlay.getSize();
  overlay.setPosition(
    Math.round(workArea.x + workArea.width - w - 16),
    Math.round(workArea.y + workArea.height - h - 16),
  );
}
function lockWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}
function createOverlay() {
  overlay = new BrowserWindow({
    width: 520,
    height: 480,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockWindow(overlay);
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, "overlay.html"));
}
function restoreFocus() {
  if (process.platform === "darwin") app.hide();
  else {
    overlay?.hide();
    settingsWindow?.blur();
  }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function keypress(key) {
  return new Promise((resolve, reject) => {
    const done = (err) =>
      err
        ? reject(
            new Error(
              "Automatic paste/copy is unavailable. Check Accessibility permissions or use the clipboard.",
            ),
          )
        : resolve();
    if (process.platform === "darwin")
      execFile(
        "osascript",
        [
          "-e",
          `tell application "System Events" to keystroke "${key}" using command down`,
        ],
        { timeout: 5000 },
        done,
      );
    else if (process.platform === "win32")
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$w = New-Object -ComObject wscript.shell; $w.SendKeys('^${key}')`,
        ],
        { timeout: 5000 },
        done,
      );
    else done(new Error("Unsupported platform"));
  });
}
function clipboardSnapshot() {
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: clipboard.readImage(),
  };
}
async function selectedText() {
  const previous = clipboardSnapshot();
  const marker = "mockingbird-selection-" + randomUUID();
  clipboard.writeText(marker);
  try {
    await keypress("c");
    await pause(250);
    const text = clipboard.readText();
    return text === marker ? "" : text;
  } finally {
    clipboard.write(previous);
  }
}
async function begin(mode) {
  if (active) {
    if (active.phase === "recording" && active.mode === mode) send("mb:stop");
    return;
  }
  if (!readAuth()) {
    openSettings();
    return;
  }
  clearTimeout(hideTimer);
  const current = {
    id: randomUUID(),
    mode,
    phase: "starting",
    controller: new AbortController(),
    selection: "",
  };
  active = current;
  try {
    if (mode === "rewrite") {
      current.selection = await selectedText();
      if (!current.selection.trim())
        throw new Error("Select the text you want to rewrite first.");
      if (current.selection.length > 20000)
        throw new Error("Select a shorter passage to rewrite.");
    }
    if (active !== current) return;
    current.phase = "recording";
    globalShortcut.register("Escape", cancelActive);
    positionOverlay();
    overlay.showInactive();
    const cfg = loadConfig();
    send("mb:listen", {
      sessionId: current.id,
      mode,
      hotkey: pretty(
        mode === "rewrite" ? cfg.rewriteHotkey : cfg.dictationHotkey,
      ),
      autoStopSeconds: cfg.autoStopSeconds,
    });
  } catch (err) {
    active = null;
    notify("Mockingbird", err.message);
  }
}
function cancelActive() {
  if (!active) return;
  active.controller.abort();
  send("mb:cancel", { silent: true });
  active = null;
  globalShortcut.unregister("Escape");
  restoreFocus();
  overlay?.hide();
}
async function deliverText(text, current, raw) {
  if (active !== current) return;
  const cfg = loadConfig();
  clipboard.writeText(text);
  pushHistory({ kind: current.mode, text, transcript: raw });
  restoreFocus();
  await pause(180);
  let pasted = false;
  if (cfg.autoPaste) {
    try {
      await keypress("v");
      pasted = true;
    } catch {
      notify(
        "Your words are copied",
        "Automatic paste was unavailable. Press Cmd/Ctrl+V to paste.",
      );
    }
  }
  if (active !== current) return;
  status("done", pasted ? "Paste sent" : "Copied to clipboard", text);
  active = null;
  globalShortcut.unregister("Escape");
  hideSoon();
}
async function handleAudio(payload) {
  const current = active;
  if (
    !current ||
    current.id !== payload.sessionId ||
    current.phase !== "recording"
  )
    return;
  current.phase = "working";
  globalShortcut.unregister("Escape");
  const audio = Buffer.from(payload.buffer || []);
  if (audio.length > 4 * 1024 * 1024 || audio.length < 100) {
    status("error", "Recording was empty or too large");
    active = null;
    hideSoon(3500);
    return;
  }
  lastRecording = { audio, mode: current.mode, selection: current.selection };
  settingsWindow?.webContents.send("mb:history-changed");
  await processAudio(current, audio);
}
async function processAudio(current, audio) {
  try {
    status("working", "Transcribing…");
    const result = await api("/api/transcribe", {
      body: audio,
      raw: true,
      signal: current.controller.signal,
    });
    if (active !== current) return;
    const raw = (result.text || "").trim();
    if (!raw) throw new Error("No words heard. Please try again.");
    if (current.mode === "rewrite") {
      status("working", "Rewriting…");
      const revised = await api("/api/rewrite", {
        body: { text: current.selection, instruction: raw },
        signal: current.controller.signal,
      });
      if (active !== current) return;
      current.phase = "review";
      current.revised = revised.text;
      current.instruction = raw;
      send("mb:confirm", { original: current.selection, text: revised.text });
      overlay.show();
      overlay.focus();
      return;
    }
    if (result.snippet) return await deliverText(result.snippet, current, raw);
    let text = raw;
    status("working", "Polishing…", raw);
    try {
      const cfg = loadConfig();
      text =
        (
          await api("/api/format", {
            body: {
              text: raw,
              tone: cfg.tone,
              dictionary: cfg.dictionary,
              learn: cfg.learn,
            },
            signal: current.controller.signal,
          })
        ).text || raw;
    } catch {
      if (active === current)
        notify(
          "Raw transcript preserved",
          "Cleanup was unavailable. Your unpolished words are ready.",
        );
    }
    await deliverText(text, current, raw);
  } catch (err) {
    if (active !== current) return;
    active = null;
    status(
      "error",
      err.message,
      "Retry this recording in Settings, or record again.",
    );
    notify("Mockingbird", err.message);
    hideSoon(5000);
  }
}
function trusted(event, window) {
  return Boolean(
    window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame,
  );
}
function settingHandler(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (!trusted(event, settingsWindow)) throw new Error("Not allowed");
    return fn(...args);
  });
}
ipcMain.on("mb:audio", (e, p) => {
  if (trusted(e, overlay)) handleAudio(p);
});
ipcMain.on("mb:recording-error", (event, payload) => {
  if (!trusted(event, overlay) || payload.sessionId !== active?.id) return;
  active.controller.abort();
  active = null;
  globalShortcut.unregister("Escape");
  notify(
    "Microphone unavailable",
    "Allow microphone access for Mockingbird in your system privacy settings.",
  );
  hideSoon(4500);
});
ipcMain.on("mb:cancelled", (e, p) => {
  if (trusted(e, overlay) && (!p?.sessionId || p.sessionId === active?.id))
    cancelActive();
});
ipcMain.on("mb:confirm-response", async (e, p) => {
  if (!trusted(e, overlay) || active?.phase !== "review") return;
  const current = active;
  if (!p?.accept) {
    cancelActive();
    return;
  }
  current.phase = "working";
  // Always copy the reviewed text. Restore focus before attempting replacement.
  await deliverText(current.revised, current, current.instruction);
});
settingHandler("mb:get-config", publicConfig);
settingHandler("mb:save-config", saveConfig);
settingHandler("mb:get-history", loadHistory);
settingHandler("mb:clear-history", () => {
  fs.writeFileSync(historyPath(), "[]", { mode: 0o600 });
  return [];
});
settingHandler("mb:copy-history", (index) => {
  const item = loadHistory()[Number(index)];
  if (item?.text) clipboard.writeText(item.text);
});
settingHandler("mb:connect", async (value) => {
  const parsed = new URL(String(value).trim());
  const code = parsed.hash.slice(1);
  parsed.hash = "";
  const base = trustedURL(parsed.href);
  if (!/^[a-f0-9]{32}$/i.test(code))
    throw new Error(
      "Paste the full connection code from My devices in your account.",
    );
  const data = await api("/api/device", {
    baseUrl: base,
    token: null,
    body: {
      action: "exchange",
      code,
      name: process.platform === "darwin" ? "Mac" : "Windows PC",
    },
  });
  writeAuth({ token: data.token, expiresAt: data.expiresAt });
  const cfg = loadConfig();
  cfg.baseUrl = base;
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  applyConfig(cfg);
  return publicConfig();
});
settingHandler("mb:disconnect", () => {
  cancelActive();
  lastRecording = null;
  try {
    fs.unlinkSync(authPath());
  } catch {}
  return publicConfig();
});
settingHandler("mb:open-account", () => {
  const base = loadConfig().baseUrl;
  if (!base)
    throw new Error(
      "Open the website you received from Thunderbird to create your account.",
    );
  return shell.openExternal(trustedURL(base) + "/account");
});
settingHandler("mb:retry", async () => {
  if (active || !lastRecording)
    throw new Error("No recording is available to retry.");
  const r = lastRecording;
  const current = {
    id: randomUUID(),
    mode: r.mode,
    selection: r.selection,
    phase: "working",
    controller: new AbortController(),
  };
  active = current;
  positionOverlay();
  overlay.showInactive();
  await processAudio(current, r.audio);
});
settingHandler("mb:forget-recording", () => {
  lastRecording = null;
  return publicConfig();
});
settingHandler("mb:check-updates", async () => {
  if (!app.isPackaged)
    throw new Error("Updates are available in installed releases.");
  await autoUpdater.checkForUpdates();
  return "Update check complete. You will be notified when an update is ready.";
});
settingHandler("mb:install-update", () => {
  if (updateReady) autoUpdater.quitAndInstall();
});
settingHandler("mb:microphone", async () => {
  if (process.platform === "darwin")
    return systemPreferences.askForMediaAccess("microphone");
  return true;
});
settingHandler("mb:quit", () => app.quit());
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 900,
    height: 740,
    minWidth: 700,
    minHeight: 560,
    title: "Mockingbird",
    show: false,
    backgroundColor: "#f5f4ee",
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockWindow(settingsWindow);
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.once("ready-to-show", () => settingsWindow.show());
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}
const pretty = (value) =>
  String(value || "").replace(
    "CommandOrControl",
    process.platform === "darwin" ? "Cmd" : "Ctrl",
  );
function menu() {
  const c = loadConfig();
  return Menu.buildFromTemplate([
    {
      label: `Dictate (${pretty(c.dictationHotkey)})`,
      click: () => begin("dictation"),
    },
    {
      label: `Rewrite selection (${pretty(c.rewriteHotkey)})`,
      click: () => begin("rewrite"),
    },
    { type: "separator" },
    { label: "Settings & history", click: openSettings },
    { label: "Quit Mockingbird", click: () => app.quit() },
  ]);
}
function applyConfig(cfg) {
  globalShortcut.unregisterAll();
  for (const [hotkey, mode] of [
    [cfg.dictationHotkey, "dictation"],
    [cfg.rewriteHotkey, "rewrite"],
  ]) {
    try {
      if (!globalShortcut.register(hotkey, () => begin(mode)))
        notify(
          "Shortcut unavailable",
          "Choose a different shortcut in Settings.",
        );
    } catch {
      notify("Invalid shortcut", "Choose a valid shortcut in Settings.");
    }
  }
  tray?.setContextMenu(menu());
  app.setLoginItemSettings({ openAtLogin: cfg.launchAtLogin });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(() => {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    // Remove legacy shared credentials from config instead of exposing them to renderers.
    const cfg = loadConfig();
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), {
      mode: 0o600,
    });
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) =>
        callback(
          contents === overlay?.webContents &&
            permission === "media" &&
            (!details.mediaTypes ||
              details.mediaTypes.every((x) => x === "audio")),
        ),
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission) =>
        contents === overlay?.webContents && permission === "media",
    );
    createOverlay();
    const icon = nativeImage.createFromPath(
      path.join(
        __dirname,
        "assets",
        process.platform === "darwin" ? "trayTemplate.png" : "tray.png",
      ),
    );
    if (process.platform === "darwin") icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("Mockingbird");
    tray.setContextMenu(menu());
    tray.on("click", () => begin("dictation"));
    applyConfig(cfg);
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("error", () =>
      notify("Update unavailable", "Try again later from Settings."),
    );
    autoUpdater.on("update-downloaded", () => {
      updateReady = true;
      notify("Mockingbird update ready", "Restart the app to finish updating.");
      settingsWindow?.webContents.send("mb:history-changed");
    });
    if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
    if (!readAuth()) openSettings();
  });
  app.on("second-instance", openSettings);
  app.on("activate", openSettings);
  app.on("window-all-closed", () => {});
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    lastRecording = null;
    active?.controller.abort();
  });
}
