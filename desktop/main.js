/**
 * Mockingbird Desktop — main process.
 *
 * System-wide dictation: press the global hotkey in ANY app, speak, press it
 * again (or wait for silence) — the polished text is pasted where your cursor
 * is. Reuses the same Mockingbird deployment (transcribe + format endpoints)
 * as the web widget, so accuracy, dictionary, and logging are shared.
 *
 * First run creates a config file (tray → "Open Settings") where you set your
 * deployment URL. Default hotkey: Ctrl/Cmd+Shift+Space (toggle to talk).
 */
const {
  app, BrowserWindow, Tray, Menu, MenuItem, globalShortcut,
  clipboard, ipcMain, screen, shell, nativeImage, Notification
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const DEFAULT_CONFIG = {
  baseUrl: 'https://YOUR-MOCKINGBIRD.vercel.app',
  hotkey: 'CommandOrControl+Shift+Space',
  tone: 'clean',
  lang: 'en-US',
  userId: ''
};

let overlay = null;
let tray = null;
let listening = false;

// ---------------------------------------------------------------- config

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return Object.assign({}, DEFAULT_CONFIG, cfg);
  } catch (e) {
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify(DEFAULT_CONFIG, null, 2));
    } catch (e2) { /* first run race — ignore */ }
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

// ---------------------------------------------------------------- overlay

function createOverlay() {
  overlay = new BrowserWindow({
    width: 340,
    height: 96,
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
  const { workArea } = screen.getPrimaryDisplay();
  overlay.setPosition(
    Math.round(workArea.x + workArea.width - 356),
    Math.round(workArea.y + workArea.height - 112)
  );
}

// ---------------------------------------------------------------- dictation

function toggleDictation() {
  if (!overlay) return;
  if (!listening) {
    listening = true;
    positionOverlay();
    overlay.showInactive(); // never steal focus from the app being dictated into
    overlay.webContents.send('mb-begin', loadConfig());
  } else {
    overlay.webContents.send('mb-finish');
  }
}

// Paste into whatever app has focus. Text is already on the clipboard;
// simulate the platform paste keystroke — no native modules needed.
function pasteIntoFrontApp() {
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e',
      'tell application "System Events" to keystroke "v" using command down'
    ], (err) => { if (err) notify('Pasted to clipboard', 'Press Cmd+V — enable Mockingbird in System Settings → Privacy → Accessibility for auto-paste.'); });
  } else if (process.platform === 'win32') {
    execFile('powershell', ['-NoProfile', '-Command',
      "$w = New-Object -ComObject wscript.shell; $w.SendKeys('^v')"
    ], (err) => { if (err) notify('Pasted to clipboard', 'Press Ctrl+V to insert.'); });
  } else {
    execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+v'],
      (err) => { if (err) notify('Copied to clipboard', 'Press Ctrl+V to insert (install xdotool for auto-paste).'); });
  }
}

function notify(title, body) {
  try { new Notification({ title: title, body: body }).show(); } catch (e) { /* headless */ }
}

// ---------------------------------------------------------------- ipc

ipcMain.on('mb-insert', (event, text) => {
  listening = false;
  if (text && text.trim()) {
    clipboard.writeText(text.trim());
    pasteIntoFrontApp();
  }
  setTimeout(() => { if (overlay && !listening) overlay.hide(); }, 900);
});

ipcMain.on('mb-state', (event, state) => {
  if (state === 'idle' || state === 'error') {
    listening = false;
    setTimeout(() => { if (overlay && !listening) overlay.hide(); }, 1600);
  }
});

// ---------------------------------------------------------------- tray

// 16x16 placeholder dot; swap for real icon assets before public distribution.
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVR4nGP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';

function createTray() {
  try {
    const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_B64, 'base64'));
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    const cfg = loadConfig();
    tray.setToolTip('Mockingbird — ' + cfg.hotkey.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Start / stop dictation', click: toggleDictation },
      { type: 'separator' },
      { label: 'Open Settings (config.json)', click: () => shell.openPath(configPath()) },
      { label: 'Reload settings', click: () => { registerHotkey(); } },
      { type: 'separator' },
      { label: 'Quit Mockingbird', click: () => app.quit() }
    ]));
  } catch (e) {
    console.error('tray unavailable:', e.message);
  }
}

// ---------------------------------------------------------------- hotkey

function registerHotkey() {
  globalShortcut.unregisterAll();
  const cfg = loadConfig();
  const ok = globalShortcut.register(cfg.hotkey, toggleDictation);
  if (!ok) notify('Mockingbird', 'Hotkey ' + cfg.hotkey + ' is taken — change it in Settings.');
}

// ---------------------------------------------------------------- app

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide(); // tray app, no dock icon
  loadConfig(); // ensures config.json exists for the Settings menu
  createOverlay();
  createTray();
  registerHotkey();

  const cfg = loadConfig();
  if (cfg.baseUrl.indexOf('YOUR-MOCKINGBIRD') !== -1) {
    notify('Mockingbird setup', 'Open Settings from the tray icon and set baseUrl to your deployment.');
    shell.openPath(configPath());
  }
});

app.on('window-all-closed', (e) => { /* tray app — stay alive */ });
app.on('will-quit', () => globalShortcut.unregisterAll());
