/**
 * Headless smoke test for the desktop main process.
 *
 * Electron needs a display, so this stubs the `electron` module and a `fetch`
 * that answers like a Mockingbird deployment, then drives the real main.js
 * through the paths a person actually takes: press the hotkey, speak, get a
 * confirmation card, press Enter, see the action run and land in history.
 *
 *   npm test
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mockingbird-smoke-'));

// ------------------------------------------------------------ electron stub

const sent = [];            // everything main sent to the overlay
const hides = [];           // every time main hid the overlay
const ipcOn = {};
const ipcHandle = {};
const shortcuts = {};
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
const notifications = [];
let clipboardText = 'something the user had copied';
const openedSettingsTabs = [];

const overlayStub = {
  isDestroyed: () => false,
  webContents: { send: (channel, payload) => sent.push({ channel, payload }), setWindowOpenHandler() {} },
  setVisibleOnAllWorkspaces() {}, setAlwaysOnTop() {}, loadFile() {}, setPosition() {},
  getSize: () => [460, 260], showInactive() {}, show() {}, focus() {}, blur() {},
  hide() { hides.push(Date.now()); },
  once(event, cb) { if (event === 'ready-to-show') cb(); }, on() {}, setMenuBarVisibility() {}
};

const electron = {
  app: {
    getPath: () => userData,
    whenReady: () => ready,
    on() {}, quit() {}, hide() {},
    requestSingleInstanceLock: () => true,
    setLoginItemSettings() {},
    dock: { hide() {}, show() {} }
  },
  BrowserWindow: function () { return overlayStub; },
  Tray: function () {
    return { setToolTip() {}, setContextMenu() {}, on() {}, isDestroyed: () => false };
  },
  Menu: { buildFromTemplate: (t) => t },
  globalShortcut: {
    register: (accelerator, cb) => { shortcuts[accelerator] = cb; return true; },
    unregister: (accelerator) => { delete shortcuts[accelerator]; },
    unregisterAll: () => { for (const k of Object.keys(shortcuts)) delete shortcuts[k]; }
  },
  clipboard: {
    writeText: (t) => { clipboardText = t; },
    readText: () => clipboardText
  },
  ipcMain: {
    on: (channel, cb) => { ipcOn[channel] = cb; },
    handle: (channel, cb) => { ipcHandle[channel] = cb; }
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  },
  shell: { openPath() {}, openExternal() {} },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
  Notification: function (opts) { notifications.push(opts); return { show() {} }; },
  session: { defaultSession: { setPermissionRequestHandler() {} } }
};

const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electron;
  return load.apply(this, arguments);
};

// Paste simulation shells out; there is no front app here.
const childProcess = require('child_process');
childProcess.execFile = (cmd, args, cb) => { if (cb) cb(null); };

// --------------------------------------------------------------- http stub

const calls = [];
let actShouldFail = false;

global.fetch = async (url, init = {}) => {
  const route = String(url).replace('https://deploy.test', '');
  calls.push({ route, body: init.body, headers: init.headers || {} });
  const json = (status, data) => ({
    ok: status < 400, status,
    text: async () => JSON.stringify(data)
  });
  if (route === '/api/transcribe') return json(200, { text: 'add maria lopez 555 0142 from the open house' });
  if (route === '/api/actions') {
    return json(200, {
      kind: 'actions',
      actions: [{
        name: 'fub_create_person',
        input: { name: 'Maria Lopez', phone: '555-0142', source: 'open house' },
        connector: 'followupboss', connectorLabel: 'Follow Up Boss', execute: true
      }]
    });
  }
  if (route === '/api/act') {
    if (actShouldFail) return json(502, { error: 'Follow Up Boss 401: bad key' });
    return json(200, { results: [{ name: 'fub_create_person', ok: true, connector: 'followupboss', summary: 'Added Maria Lopez to Follow Up Boss' }] });
  }
  if (route === '/api/format') return json(200, { text: 'Add Maria Lopez, 555-0142, from the open house.' });
  if (route === '/api/tools') return json(200, { connectors: [], configured: { ai: true, transcription: true } });
  return json(404, { error: 'unexpected route ' + route });
};

// ------------------------------------------------------------------- setup

fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  baseUrl: 'https://deploy.test',
  accessKey: 'desktop-key',
  userId: 'smoke',
  connectors: [{ id: 'followupboss', type: 'followupboss', label: 'Follow Up Boss', enabled: true, credentials: { apiKey: 'k' } }]
}));

require(path.join(__dirname, '..', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastSent = (channel) => [...sent].reverse().find((s) => s.channel === channel);
const history = () => JSON.parse(fs.readFileSync(path.join(userData, 'history.json'), 'utf8'));

function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (err) { console.error('  ✗ ' + name + '\n    ' + err.message); process.exitCode = 1; }
}

(async () => {
  readyResolve();
  await wait(20);

  console.log('startup');
  check('registers both hotkeys', () => {
    assert.ok(shortcuts['CommandOrControl+Shift+Space'], 'dictation hotkey missing');
    assert.ok(shortcuts['CommandOrControl+Shift+K'], 'command hotkey missing');
  });

  console.log('command: hotkey → speak → confirm → run');
  shortcuts['CommandOrControl+Shift+K']();
  check('overlay is told to listen in command mode', () => {
    assert.strictEqual(lastSent('mb:listen').payload.mode, 'command');
  });
  check('escape is grabbed while listening', () => assert.ok(shortcuts.Escape));

  ipcOn['mb:recording-started']();
  ipcOn['mb:audio'](null, { buffer: new Uint8Array([1, 2, 3, 4]), mode: 'command' });
  await wait(60);

  check('audio was transcribed then routed', () => {
    assert.ok(calls.some((c) => c.route === '/api/transcribe'), 'no transcribe call');
    assert.ok(calls.some((c) => c.route === '/api/actions'), 'no actions call');
  });
  check('escape released once listening ended', () => assert.ok(!shortcuts.Escape));
  check('nothing ran before the user confirmed', () => {
    assert.ok(!calls.some((c) => c.route === '/api/act'), 'action ran without confirmation');
  });
  check('confirmation card describes the action in words', () => {
    const card = lastSent('mb:confirm').payload;
    assert.strictEqual(card.actions[0].label, 'create person');
    assert.strictEqual(card.actions[0].connector, 'Follow Up Boss');
    const name = card.actions[0].fields.find((f) => f.key === 'name');
    assert.strictEqual(name.value, 'Maria Lopez');
  });

  ipcOn['mb:confirm-response'](null, { accept: true });
  await wait(60);
  check('Enter runs it', () => assert.ok(calls.some((c) => c.route === '/api/act')));
  check('the deployment access key is sent', () => {
    const call = calls.find((c) => c.route === '/api/act');
    assert.strictEqual(call.headers['X-Mockingbird-Key'], 'desktop-key');
  });
  check('credentials go with the request', () => {
    const body = JSON.parse(calls.find((c) => c.route === '/api/act').body);
    assert.strictEqual(body.connectors[0].credentials.apiKey, 'k');
  });
  check('the result is shown', () => {
    assert.strictEqual(lastSent('mb:status').payload.state, 'done');
    assert.match(lastSent('mb:status').payload.message, /Added Maria Lopez/);
  });
  check('it is in history', () => {
    assert.strictEqual(history()[0].kind, 'command');
    assert.strictEqual(history()[0].ok, true);
  });

  console.log('command: Escape declines');
  shortcuts['CommandOrControl+Shift+K']();
  ipcOn['mb:audio'](null, { buffer: new Uint8Array([1]), mode: 'command' });
  await wait(60);
  const actsBefore = calls.filter((c) => c.route === '/api/act').length;
  ipcOn['mb:confirm-response'](null, { accept: false });
  await wait(20);
  check('declining runs nothing', () => {
    assert.strictEqual(calls.filter((c) => c.route === '/api/act').length, actsBefore);
    assert.strictEqual(history()[0].kind, 'command (cancelled)');
  });

  console.log('switching modes mid-sentence');
  hides.length = 0;
  shortcuts['CommandOrControl+Shift+Space']();
  shortcuts['CommandOrControl+Shift+K']();
  check('the running recording is cancelled silently', () => {
    assert.strictEqual(lastSent('mb:cancel').payload.silent, true);
  });
  check('and the new session starts in the mode asked for', () => {
    assert.strictEqual(lastSent('mb:listen').payload.mode, 'command');
  });
  // The overlay's own acknowledgement would arrive here in the real app; it
  // must not tear down the session that just started.
  check('a late acknowledgement does not hide the new session', () => {
    assert.strictEqual(hides.length, 0);
  });
  ipcOn['mb:audio'](null, { buffer: new Uint8Array([1]), mode: 'command' });
  await wait(60);
  ipcOn['mb:confirm-response'](null, { accept: false });
  await wait(20);

  console.log('dictation: plain text goes to the clipboard');
  clipboardText = 'user clipboard';
  shortcuts['CommandOrControl+Shift+Space']();
  ipcOn['mb:recording-started']();
  global.fetch = (url, init) => {
    const route = String(url).replace('https://deploy.test', '');
    calls.push({ route, body: init && init.body });
    if (route === '/api/transcribe') {
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ text: 'um send me the disclosures tomorrow' }) });
    }
    // No command in this one — the router hands back cleaned dictation.
    return Promise.resolve({
      ok: true, status: 200,
      text: async () => JSON.stringify({ kind: 'dictation', text: 'Send me the disclosures tomorrow.' })
    });
  };
  ipcOn['mb:audio'](null, { buffer: new Uint8Array([1]), mode: 'dictation' });
  await wait(60);
  check('polished text is on the clipboard', () => {
    assert.strictEqual(clipboardText, 'Send me the disclosures tomorrow.');
    assert.strictEqual(history()[0].kind, 'dictation');
  });
  await wait(1700); // the restore is scheduled shortly after the paste lands
  check('the previous clipboard is put back afterwards', () => {
    assert.strictEqual(clipboardText, 'user clipboard');
  });

  console.log('failure: words are never lost when the router is down');
  global.fetch = (url) => {
    const route = String(url).replace('https://deploy.test', '');
    calls.push({ route });
    if (route === '/api/transcribe') {
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ text: 'raw words' }) });
    }
    return Promise.resolve({ ok: false, status: 502, text: async () => JSON.stringify({ error: 'down' }) });
  };
  shortcuts['CommandOrControl+Shift+Space']();
  ipcOn['mb:audio'](null, { buffer: new Uint8Array([1]), mode: 'dictation' });
  await wait(80);
  check('falls back to the raw transcript', () => {
    assert.strictEqual(clipboardText, 'raw words');
  });

  await wait(1700); // let the last clipboard restore fire before we exit
  fs.rmSync(userData, { recursive: true, force: true });
  console.log(process.exitCode ? '\nFAILED' : '\nall good');
})();
