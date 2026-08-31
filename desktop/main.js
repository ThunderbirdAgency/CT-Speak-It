/**
 * Mockingbird Desktop — main process.
 *
 * Voice everywhere on your machine, in two shapes:
 *
 *   Dictation hotkey (Ctrl/Cmd+Shift+Space) — speak into any app, press again,
 *   polished text is pasted where your cursor is. Email, Word, Slack, a CRM
 *   text box, anything.
 *
 *   Command hotkey (Ctrl/Cmd+Shift+K) — speak an instruction instead. "Add
 *   Maria Lopez, 555-0142, from the open house, and remind me to call her
 *   Monday." Mockingbird shows exactly what it is about to do; press Enter and
 *   it happens in Follow Up Boss / your CRM. Escape cancels.
 *
 * Everything that touches the network or a credential happens here in the main
 * process. The overlay window only records audio and draws the pill — it never
 * sees an API key.
 */
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, session,
  clipboard, ipcMain, screen, shell, nativeImage, Notification
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const DEFAULT_CONFIG = {
  baseUrl: '',                                    // your Mockingbird deployment
  userId: '',                                     // who is speaking (for the event log + profile)
  dictationHotkey: 'CommandOrControl+Shift+Space',
  commandHotkey: 'CommandOrControl+Shift+K',
  tone: 'clean',
  lang: 'en-US',
  autoPaste: true,        // simulate the paste keystroke (off = clipboard only)
  confirmActions: true,   // show what will happen and wait for Enter
  smartCommands: true,    // notice commands spoken with the dictation hotkey too
  learn: true,            // let Mockingbird build a voice profile (see docs/LEARNING.md)
  launchAtLogin: true,
  autoStopSeconds: 0,     // finish automatically after N seconds of silence (0 = off)
  dictionary: [],
  connectors: []          // [{ id, type, label, enabled, credentials, config }]
};

const HISTORY_LIMIT = 200;

let overlay = null;
let settingsWindow = null;
let tray = null;
let listening = false;
let currentMode = 'dictation';
let pendingConfirm = null;   // { actions, transcript } awaiting Enter

// ---------------------------------------------------------------- storage

const configPath = () => path.join(app.getPath('userData'), 'config.json');
const historyPath = () => path.join(app.getPath('userData'), 'history.json');

function loadConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return Object.assign({}, DEFAULT_CONFIG, stored);
  } catch (e) {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

function saveConfig(patch) {
  const next = Object.assign(loadConfig(), patch || {});
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.error('mockingbird: could not save config', err.message);
  }
  applyConfig(next);
  return next;
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(historyPath(), 'utf8')); } catch (e) { return []; }
}

/** Local, on this machine only — the "what did I just say?" list in the app. */
function pushHistory(entry) {
  const history = loadHistory();
  history.unshift(Object.assign({ at: new Date().toISOString() }, entry));
  try {
    fs.writeFileSync(historyPath(), JSON.stringify(history.slice(0, HISTORY_LIMIT), null, 2));
  } catch (err) {
    console.error('mockingbird: could not save history', err.message);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('mb:history-changed');
}

function setupComplete(cfg) {
  return Boolean(cfg.baseUrl && /^https?:\/\//.test(cfg.baseUrl));
}

function enabledConnectors(cfg) {
  return (cfg.connectors || [])
    .filter((c) => c && c.enabled !== false && c.type)
    .map((c) => ({
      type: c.type,
      id: c.id || c.type,
      label: c.label,
      credentials: c.credentials || {},
      config: c.config || {}
    }));
}

// -------------------------------------------------------------------- api

async function api(pathname, { method = 'POST', body, headers = {}, timeoutMs = 45000 } = {}) {
  const cfg = loadConfig();
  if (!setupComplete(cfg)) throw new Error('Mockingbird is not set up yet — open Settings and add your deployment URL.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(cfg.baseUrl.replace(/\/$/, '') + pathname, {
      method,
      headers: Object.assign(
        body instanceof Buffer ? {} : { 'Content-Type': 'application/json' },
        headers
      ),
      body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (!r.ok) throw new Error((data && data.error) || `${pathname} failed (${r.status})`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Mockingbird timed out — check your connection.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- overlay

function createOverlay() {
  overlay = new BrowserWindow({
    width: 460,
    height: 260,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    focusable: true,        // needed for Enter-to-confirm; we only focus on demand
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  positionOverlay();
}

function positionOverlay() {
  if (!overlay) return;
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const [w, h] = overlay.getSize();
  overlay.setPosition(
    Math.round(workArea.x + workArea.width - w - 16),
    Math.round(workArea.y + workArea.height - h - 16)
  );
}

function send(channel, payload) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
}

function status(state, message, detail) {
  send('mb:status', { state, message, detail });
}

function hideOverlaySoon(ms) {
  setTimeout(() => {
    if (overlay && !listening && !pendingConfirm) overlay.hide();
  }, ms);
}

// ------------------------------------------------------------- dictation

// Escape cancels a dictation from wherever the user is typing. It is only
// grabbed while the overlay is actually listening, and released the moment it
// stops, so it never interferes with anything else.
function grabEscape(on) {
  try {
    if (on) globalShortcut.register('Escape', () => { if (listening) send('mb:cancel'); });
    else globalShortcut.unregister('Escape');
  } catch (e) { /* some desktops refuse to share Escape — not worth failing over */ }
}

function beginListening(mode) {
  const cfg = loadConfig();
  if (!setupComplete(cfg)) { openSettings('setup'); return; }
  currentMode = mode;
  listening = true;
  pendingConfirm = null;
  grabEscape(true);
  positionOverlay();
  overlay.showInactive();   // never steal focus from the app being dictated into
  send('mb:listen', {
    mode,
    hotkey: prettyHotkey(mode === 'command' ? cfg.commandHotkey : cfg.dictationHotkey),
    autoStopSeconds: cfg.autoStopSeconds
  });
}

function toggle(mode) {
  if (pendingConfirm) return;              // the hotkey shouldn't fight the confirm card
  if (listening && mode === currentMode) send('mb:stop');
  else if (listening) {
    // Switching modes mid-listen: tear the recording down without the overlay
    // reporting back, or its acknowledgement would arrive after the new
    // session had already started and hide the window again.
    send('mb:cancel', { silent: true });
    listening = false;
    beginListening(mode);
  } else beginListening(mode);
}

/** Audio has arrived from the overlay: transcribe, decide, act. */
async function handleAudio(buffer, mode) {
  const cfg = loadConfig();
  listening = false;
  grabEscape(false);
  try {
    status('working', 'Transcribing…');
    const transcription = await api('/api/transcribe', {
      body: Buffer.from(buffer),
      headers: {
        'Content-Type': 'audio/webm',
        'X-Mockingbird-Lang': cfg.lang || 'en-US',
        'X-Mockingbird-User': cfg.userId || ''
      }
    });
    const raw = (transcription.text || '').trim();
    if (!raw) { status('error', 'Heard nothing'); hideOverlaySoon(1800); return; }

    const connectors = enabledConnectors(cfg);
    const wantsActions = connectors.length && (mode === 'command' || cfg.smartCommands);

    if (wantsActions) {
      status('working', mode === 'command' ? 'Working out what to do…' : 'Polishing…', raw);
      let decision;
      try {
        decision = await api('/api/actions', {
          body: {
            text: raw,
            mode: mode === 'command' ? 'command' : 'auto',
            connectors,
            appContext: 'desktop — the speaker is working in another application',
            dictionary: cfg.dictionary || [],
            user: cfg.userId || null,
            learn: cfg.learn !== false
          }
        });
      } catch (err) {
        // Action routing unavailable — never lose the words.
        return finishDictation(raw, cfg);
      }
      if (decision && decision.kind === 'actions' && decision.actions && decision.actions.length) {
        return proposeActions(decision.actions, raw, cfg);
      }
      const cleaned = (decision && decision.text) || raw;
      return deliverText(cleaned, raw, cfg, 'dictation');
    }

    return finishDictation(raw, cfg);
  } catch (err) {
    console.error('mockingbird:', err.message);
    status('error', err.message);
    notify('Mockingbird', err.message);
    hideOverlaySoon(3500);
  }
}

async function finishDictation(raw, cfg) {
  try {
    status('working', 'Polishing…', raw);
    const formatted = await api('/api/format', {
      body: {
        text: raw,
        tone: cfg.tone || 'clean',
        appContext: 'desktop dictation into another application',
        dictionary: cfg.dictionary || [],
        user: cfg.userId || null,
        learn: cfg.learn !== false
      }
    });
    return deliverText((formatted.text || raw).trim(), raw, cfg, 'dictation');
  } catch (err) {
    // Formatter down → the raw transcript still goes in. Words are never lost.
    return deliverText(raw, raw, cfg, 'dictation (raw)');
  }
}

function deliverText(text, raw, cfg, kind) {
  if (!text) { status('error', 'Nothing to insert'); hideOverlaySoon(1800); return; }
  clipboard.writeText(text);
  if (cfg.autoPaste !== false) pasteIntoFrontApp();
  status('done', 'Inserted', text);
  pushHistory({ kind, transcript: raw, text });
  hideOverlaySoon(1200);
}

// --------------------------------------------------------------- actions

function describeAction(action) {
  const label = action.name.replace(/^fub_/, '').replace(/_/g, ' ');
  const fields = Object.entries(action.input || {})
    .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => ({ key: k, value: Array.isArray(v) ? v.join(', ') : String(v) }));
  return { name: action.name, label, connector: action.connectorLabel || action.connector, fields };
}

function proposeActions(actions, transcript, cfg) {
  // App-owned actions can't run from the desktop (there is no app here to
  // handle them); connector actions can.
  const runnable = actions.filter((a) => a.execute);
  // Nothing here the desktop can run (an app-owned action with no app in
  // front of it) — treat what they said as dictation rather than dropping it.
  if (!runnable.length) return finishDictation(transcript, cfg);

  if (cfg.confirmActions === false) return runActions(runnable, transcript, cfg);

  pendingConfirm = { actions: runnable, transcript };
  send('mb:confirm', { actions: runnable.map(describeAction), transcript });
  // The confirm card is the one moment we take focus — the user is deciding,
  // not typing. Focus returns to their app as soon as it resolves.
  overlay.show();
  overlay.focus();
}

async function runActions(actions, transcript, cfg) {
  pendingConfirm = null;
  status('working', actions.length > 1 ? `Doing ${actions.length} things…` : 'Doing it…');
  try {
    const response = await api('/api/act', {
      body: {
        actions: actions.map((a) => ({ name: a.name, input: a.input })),
        connectors: enabledConnectors(cfg),
        user: cfg.userId || null,
        appContext: 'desktop command',
        transcript
      }
    });
    const results = (response && response.results) || [];
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const summary = (ok.length ? ok : results).map((r) => r.summary || r.error).filter(Boolean).join(' · ');

    // A lookup ("what's Maria's number") answers by pasting the answer.
    const answer = ok.map((r) => r.text).filter(Boolean).join('\n');
    if (answer) {
      clipboard.writeText(answer);
      if (cfg.autoPaste !== false) pasteIntoFrontApp();
    }

    pushHistory({
      kind: 'command',
      transcript,
      text: summary,
      actions: actions.map((a) => ({ name: a.name, input: a.input })),
      ok: failed.length === 0
    });

    if (failed.length && !ok.length) {
      status('error', failed[0].error || 'That did not go through');
      notify('Mockingbird', failed[0].error || 'Action failed');
      hideOverlaySoon(4000);
    } else {
      status('done', summary || 'Done');
      hideOverlaySoon(failed.length ? 4000 : 2200);
    }
  } catch (err) {
    console.error('mockingbird act:', err.message);
    status('error', err.message);
    pushHistory({ kind: 'command', transcript, text: err.message, ok: false });
    hideOverlaySoon(4000);
  } finally {
    restoreFocus();
  }
}

/** Give focus back to whatever the user was working in. */
function restoreFocus() {
  if (process.platform === 'darwin' && app.hide) {
    try { app.hide(); } catch (e) { /* no-op when nothing was focused */ }
  } else if (overlay && !overlay.isDestroyed()) {
    overlay.blur();
  }
}

// ----------------------------------------------------------------- paste

// Remembered the moment recording starts, restored after the paste lands, so
// dictating never silently eats what the user had copied.
let savedClipboard = null;

/**
 * Paste into whatever app has focus. The text is already on the clipboard;
 * we simulate the platform paste keystroke — no native modules to build or
 * sign. Whatever the user had on the clipboard is put back afterwards.
 */
function pasteIntoFrontApp() {
  const restoreClipboard = savedClipboard;
  const done = (err) => {
    if (err) {
      notify('Copied to clipboard',
        process.platform === 'darwin'
          ? 'Press Cmd+V to insert. For automatic pasting, allow Mockingbird under System Settings → Privacy & Security → Accessibility.'
          : 'Press Ctrl+V to insert.');
    }
    if (restoreClipboard != null) {
      // Put their clipboard back once the paste has landed.
      setTimeout(() => { try { clipboard.writeText(restoreClipboard); } catch (e) {} }, 1500);
    }
  };
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e',
      'tell application "System Events" to keystroke "v" using command down'], done);
  } else if (process.platform === 'win32') {
    execFile('powershell', ['-NoProfile', '-Command',
      "$w = New-Object -ComObject wscript.shell; $w.SendKeys('^v')"], done);
  } else {
    execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], done);
  }
}

function rememberClipboard() {
  try { savedClipboard = clipboard.readText(); } catch (e) { savedClipboard = null; }
}

function notify(title, body) {
  try { new Notification({ title, body }).show(); } catch (e) { /* headless */ }
}

// ------------------------------------------------------------------- ipc

ipcMain.on('mb:audio', (event, payload) => {
  handleAudio(payload.buffer, payload.mode || currentMode);
});

ipcMain.on('mb:cancelled', () => {
  listening = false;
  grabEscape(false);
  pendingConfirm = null;
  if (overlay) overlay.hide();
});

ipcMain.on('mb:confirm-response', (event, payload) => {
  const cfg = loadConfig();
  const pending = pendingConfirm;
  if (!pending) return;
  if (payload && payload.accept) {
    runActions(pending.actions, pending.transcript, cfg);
  } else {
    pendingConfirm = null;
    status('idle', 'Cancelled');
    pushHistory({ kind: 'command (cancelled)', transcript: pending.transcript, text: '', ok: false });
    restoreFocus();
    hideOverlaySoon(400);
  }
});

ipcMain.on('mb:recording-started', () => { rememberClipboard(); });

ipcMain.handle('mb:get-config', () => loadConfig());
ipcMain.handle('mb:save-config', (event, patch) => saveConfig(patch));
ipcMain.handle('mb:get-history', () => loadHistory());
ipcMain.handle('mb:clear-history', () => {
  try { fs.writeFileSync(historyPath(), '[]'); } catch (e) {}
  return [];
});
ipcMain.handle('mb:open-config-file', () => shell.openPath(configPath()));
ipcMain.handle('mb:quit', () => app.quit());
ipcMain.handle('mb:dictate-now', () => { toggle('dictation'); });

/** Settings uses these to reach the deployment without holding any secrets. */
ipcMain.handle('mb:check-deployment', async (event, baseUrl) => {
  const url = String(baseUrl || '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(url)) return { ok: false, error: 'Enter a full https:// URL' };
  try {
    const r = await fetch(url + '/api/tools', { method: 'GET' });
    if (!r.ok) return { ok: false, error: `Deployment answered ${r.status}` };
    const data = await r.json();
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mb:list-commands', async () => {
  const cfg = loadConfig();
  const connectors = enabledConnectors(cfg);
  if (!connectors.length || !setupComplete(cfg)) return { tools: [] };
  try { return await api('/api/tools', { body: { connectors } }); }
  catch (err) { return { tools: [], error: err.message }; }
});

ipcMain.handle('mb:profile', async (event, action) => {
  const cfg = loadConfig();
  if (!cfg.userId) return { enabled: false, error: 'Set your name in Settings first.' };
  const query = `?user=${encodeURIComponent(cfg.userId)}`;
  try {
    if (action === 'refresh') return await api('/api/profile', { body: { user: cfg.userId, refresh: true } });
    if (action === 'forget') return await api('/api/profile' + query, { method: 'DELETE' });
    return await api('/api/profile' + query, { method: 'GET' });
  } catch (err) {
    return { enabled: false, error: err.message };
  }
});

// -------------------------------------------------------------- settings

function openSettings(tab) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    if (tab) settingsWindow.webContents.send('mb:open-tab', tab);
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 860,
    height: 700,
    minWidth: 720,
    minHeight: 560,
    title: 'Mockingbird',
    show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.once('ready-to-show', () => {
    if (process.platform === 'darwin' && app.dock) app.dock.show();
    settingsWindow.show();
    if (tab) settingsWindow.webContents.send('mb:open-tab', tab);
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  });
  // Links in the settings window open in the real browser.
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ------------------------------------------------------------------ tray

function trayImage() {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const image = nativeImage.createFromPath(path.join(__dirname, 'assets', file));
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

function prettyHotkey(hotkey) {
  return String(hotkey || '').replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl');
}

function buildTrayMenu() {
  const cfg = loadConfig();
  const connectors = enabledConnectors(cfg);
  return Menu.buildFromTemplate([
    { label: `Dictate  (${prettyHotkey(cfg.dictationHotkey)})`, click: () => toggle('dictation') },
    {
      label: `Command  (${prettyHotkey(cfg.commandHotkey)})`,
      enabled: connectors.length > 0,
      click: () => toggle('command')
    },
    { type: 'separator' },
    {
      label: connectors.length
        ? `Connected: ${connectors.map((c) => c.label || c.type).join(', ')}`
        : 'No connectors yet',
      enabled: false
    },
    { label: 'Settings…', click: () => openSettings() },
    { label: 'History…', click: () => openSettings('history') },
    { type: 'separator' },
    { label: 'Quit Mockingbird', click: () => app.quit() }
  ]);
}

function createTray() {
  try {
    tray = new Tray(trayImage());
    const cfg = loadConfig();
    tray.setToolTip(`Mockingbird — ${prettyHotkey(cfg.dictationHotkey)} to dictate`);
    tray.setContextMenu(buildTrayMenu());
    // Clicking the icon starts dictation; the menu is on right-click.
    tray.on('click', () => toggle('dictation'));
  } catch (err) {
    console.error('mockingbird: tray unavailable', err.message);
  }
}

// --------------------------------------------------------------- hotkeys

function registerHotkeys(cfg) {
  globalShortcut.unregisterAll();
  const failures = [];
  if (cfg.dictationHotkey && !globalShortcut.register(cfg.dictationHotkey, () => toggle('dictation'))) {
    failures.push(prettyHotkey(cfg.dictationHotkey));
  }
  if (cfg.commandHotkey && !globalShortcut.register(cfg.commandHotkey, () => toggle('command'))) {
    failures.push(prettyHotkey(cfg.commandHotkey));
  }
  if (failures.length) {
    notify('Mockingbird', `${failures.join(' and ')} ${failures.length > 1 ? 'are' : 'is'} already taken by another app — pick a different shortcut in Settings.`);
  }
}

function applyConfig(cfg) {
  registerHotkeys(cfg);
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip(`Mockingbird — ${prettyHotkey(cfg.dictationHotkey)} to dictate`);
  }
  try {
    app.setLoginItemSettings({ openAtLogin: cfg.launchAtLogin !== false, openAsHidden: true });
  } catch (e) { /* unsupported platform */ }
}

// ------------------------------------------------------------------- app

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettings());

  app.whenReady().then(() => {
    const cfg = loadConfig();
    // Our own windows are the only thing running here; the microphone is the
    // whole point of the app, so grant it and deny everything else.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(permission === 'media');
    });
    // Tray app: no dock icon until a window is open.
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    createOverlay();
    createTray();
    applyConfig(cfg);

    if (!setupComplete(cfg)) openSettings('setup');
  });

  app.on('activate', () => openSettings());
  app.on('window-all-closed', () => { /* tray app — stay alive */ });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}

// Surface anything unexpected instead of dying silently in the tray.
process.on('unhandledRejection', (err) => {
  console.error('mockingbird: unhandled rejection', err);
});
