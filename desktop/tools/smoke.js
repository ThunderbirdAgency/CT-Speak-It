// Exercise the real main process with simulated Electron and speech services.
const Module = require("module"),
  fs = require("fs"),
  os = require("os"),
  path = require("path"),
  assert = require("assert/strict");
Object.defineProperty(process, "platform", { value: "darwin" });
let pasteCount = 0;
require("child_process").execFile = (command, args, options, done) => {
  if (args.join(" ").includes('keystroke "c"'))
    text = "The original selection.";
  else pasteCount++;
  done(null);
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mockingbird-desktop-"));
const handlers = {},
  events = {},
  shortcuts = {},
  windows = [],
  sent = [],
  calls = [],
  notices = [];
let text = "clipboard before dictation",
  voice = "hello there",
  formatReject = false,
  heldResolve,
  updates = 0;
let readyResolve;
const ready = new Promise((r) => (readyResolve = r));
class Window {
  constructor() {
    this.webContents = {
      mainFrame: {},
      send: (c, p) => sent.push({ c, p }),
      setWindowOpenHandler() {},
      on() {},
    };
    windows.push(this);
  }
  isDestroyed() {
    return false;
  }
  loadFile() {}
  setVisibleOnAllWorkspaces() {}
  setPosition() {}
  getSize() {
    return [520, 480];
  }
  showInactive() {}
  show() {}
  focus() {}
  blur() {}
  hide() {}
  setMenuBarVisibility() {}
  on() {}
  once(e, cb) {
    cb();
  }
}
const electron = {
  app: {
    isPackaged: false,
    getVersion: () => "1.1.0",
    getPath: () => dir,
    whenReady: () => ready,
    requestSingleInstanceLock: () => true,
    on() {},
    quit() {},
    hide() {},
    setLoginItemSettings() {},
  },
  BrowserWindow: Window,
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
  },
  Menu: { buildFromTemplate: (x) => x },
  globalShortcut: {
    register: (k, f) => ((shortcuts[k] = f), true),
    unregister: (k) => delete shortcuts[k],
    unregisterAll: () => {
      for (const k in shortcuts) delete shortcuts[k];
    },
  },
  session: {
    defaultSession: {
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
    },
  },
  clipboard: {
    readText: () => text,
    writeText: (t) => {
      text = t;
    },
    readHTML: () => "",
    readRTF: () => "",
    readImage: () => null,
    write: (v) => {
      text = v.text;
    },
  },
  ipcMain: {
    handle: (c, f) => (handlers[c] = f),
    on: (c, f) => (events[c] = f),
  },
  screen: {
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1200, height: 900 },
    }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  shell: { openExternal: async () => {} },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
  Notification: class {
    constructor(v) {
      notices.push(v);
    }
    show() {}
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptString: (s) =>
      Buffer.from("ENCRYPTED:" + Buffer.from(s).toString("base64")),
    decryptString: (b) =>
      Buffer.from(b.toString().replace("ENCRYPTED:", ""), "base64").toString(),
  },
  systemPreferences: { askForMediaAccess: async () => true },
};
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return electron;
  if (request === "electron-updater")
    return {
      autoUpdater: {
        on() {},
        checkForUpdates: async () => {
          updates++;
        },
        quitAndInstall() {},
      },
    };
  return originalLoad.apply(this, arguments);
};
// No native paste in this test; explicitly exercise clipboard-only mode.
global.fetch = async (url, init) => {
  calls.push({ url, init });
  const json = (data, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  if (url.endsWith("/api/device"))
    return json({
      token: "mbd_secret-test",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
  if (url.endsWith("/api/transcribe")) {
    if (heldResolve) await new Promise((r) => (heldResolve = r));
    return json({ text: voice });
  }
  if (url.endsWith("/api/rewrite"))
    return json({ text: "The revised selection." });
  if (url.endsWith("/api/format"))
    return formatReject
      ? json({ error: "Formatter unavailable" }, 502)
      : json({ text: "Hello there." });
  throw new Error("Unexpected route " + url);
};
require("../main.js");
readyResolve();
const tick = () => new Promise((r) => setTimeout(r, 10));
awaitMain();
async function awaitMain() {
  try {
    await tick();
    const overlay = windows[0],
      settings = windows[1];
    const from = (w) => ({
      sender: w.webContents,
      senderFrame: w.webContents.mainFrame,
    });
    const se = from(settings),
      oe = from(overlay);
    let count = 0;
    const test = async (name, fn) => {
      await fn();
      count++;
      console.log("✓ " + name);
    };
    await test("settings bridge rejects the recording renderer", async () => {
      await assert.rejects(handlers["mb:get-config"](oe), /Not allowed/);
    });
    await test("consumer defaults never keep transcript history or enable learned memory", async () => {
      const c = await handlers["mb:get-config"](se);
      assert.equal(c.keepHistory, false);
      assert.equal(c.learn, false);
      assert.equal(c.connected, false);
    });
    await test("connection exchange stores protected token outside renderer configuration", async () => {
      await handlers["mb:connect"](se, "https://bird.test#" + "A".repeat(32));
      assert.match(
        fs.readFileSync(path.join(dir, "session.bin"), "utf8"),
        /^ENCRYPTED:/,
      );
      assert.doesNotMatch(
        fs.readFileSync(path.join(dir, "config.json"), "utf8"),
        /mbd_secret/,
      );
      assert.doesNotMatch(
        JSON.stringify(await handlers["mb:get-config"](se)),
        /mbd_secret/,
      );
    });
    await test("HTTP connections are refused", async () => {
      await assert.rejects(
        handlers["mb:connect"](se, "http://bird.test#" + "A".repeat(32)),
        /connection code/,
      );
    });
    await handlers["mb:save-config"](se, { autoPaste: false });
    async function record() {
      await shortcuts["CommandOrControl+Shift+Space"]();
      const listen = sent.filter((x) => x.c === "mb:listen").at(-1).p;
      events["mb:audio"](oe, {
        sessionId: listen.sessionId,
        buffer: Buffer.alloc(500),
      });
      await new Promise((r) => setTimeout(r, 240));
      return listen;
    }
    await test("dictation uses bearer authentication and does not route CRM instructions", async () => {
      voice = "add Jordan to the CRM";
      await record();
      assert.equal(text, "Hello there.");
      assert.ok(
        calls
          .filter((x) => x.url.endsWith("/api/format"))
          .at(-1)
          .init.headers.Authorization.startsWith("Bearer mbd_"),
      );
      assert.equal(
        calls.some((x) => x.url.includes("/api/actions")),
        false,
      );
      assert.equal(fs.existsSync(path.join(dir, "history.json")), false);
    });
    await test("formatter failure preserves raw transcript on clipboard", async () => {
      formatReject = true;
      voice = "These are my raw words";
      await record();
      assert.equal(text, voice);
      formatReject = false;
    });
    await test("stale recording messages cannot start a second transcription", async () => {
      const before = calls.length;
      events["mb:audio"](oe, { sessionId: "stale", buffer: Buffer.alloc(500) });
      await tick();
      assert.equal(calls.length, before);
    });
    await test("history is explicit, bounded local state and can be erased", async () => {
      await handlers["mb:save-config"](se, { keepHistory: true });
      await record();
      assert.equal((await handlers["mb:get-history"](se)).length, 1);
      await handlers["mb:clear-history"](se);
      assert.deepEqual(await handlers["mb:get-history"](se), []);
    });
    async function rewrite() {
      await shortcuts["CommandOrControl+Shift+R"]();
      const listen = sent.filter((x) => x.c === "mb:listen").at(-1).p;
      events["mb:audio"](oe, {
        sessionId: listen.sessionId,
        buffer: Buffer.alloc(500),
      });
      await tick();
    }
    await test("rewrite selection is reviewed before any replacement", async () => {
      await handlers["mb:save-config"](se, { autoPaste: true });
      const before = pasteCount;
      voice = "Make it clearer";
      await rewrite();
      const card = sent.filter((x) => x.c === "mb:confirm").at(-1).p;
      assert.equal(card.original, "The original selection.");
      assert.equal(card.text, "The revised selection.");
      assert.equal(pasteCount, before);
      await events["mb:confirm-response"](oe, { accept: true });
      assert.equal(text, "The revised selection.");
      assert.equal(pasteCount, before + 1);
    });
    await test("declining a rewrite does not send paste", async () => {
      const before = pasteCount;
      await rewrite();
      await events["mb:confirm-response"](oe, { accept: false });
      assert.equal(pasteCount, before);
    });
    await test("hotkeys cannot start overlapping recordings", async () => {
      const before = sent.filter((x) => x.c === "mb:listen").length;
      await shortcuts["CommandOrControl+Shift+Space"]();
      await shortcuts["CommandOrControl+Shift+R"]();
      assert.equal(sent.filter((x) => x.c === "mb:listen").length, before + 1);
      events["mb:cancelled"](oe, {
        sessionId: sent.filter((x) => x.c === "mb:listen").at(-1).p.sessionId,
      });
    });
    await test("held audio can be discarded and sign-out removes credential", async () => {
      assert.equal((await handlers["mb:get-config"](se)).canRetry, true);
      await handlers["mb:forget-recording"](se);
      assert.equal((await handlers["mb:get-config"](se)).canRetry, false);
      await handlers["mb:disconnect"](se);
      assert.equal(fs.existsSync(path.join(dir, "session.bin")), false);
    });
    console.log(
      `\n${count} desktop checks passed (simulated OS; real Mac/Windows validation still required).`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error(err);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
}
