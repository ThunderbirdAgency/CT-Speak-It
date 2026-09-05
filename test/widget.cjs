/**
 * Browser tests for the widget — the pipeline a user actually goes through.
 *
 * Runs src/mockingbird.js in a real Chromium with fetch stubbed, so the
 * decisions the widget makes (type it / hand it to the app / ask before
 * touching someone's CRM) are exercised rather than assumed.
 *
 *   npm test        (needs playwright; see package.json)
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const { execSync } = require("child_process");

// Playwright is a test-only dependency and is just as often installed
// globally; find it either way rather than making people npm i twice.
function loadPlaywright() {
  try {
    return require("playwright");
  } catch (e) {
    /* try the global root */
  }
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    return require(path.join(root, "playwright"));
  } catch (e) {
    console.error(
      "These tests need Playwright: npm i -D playwright (or npm i -g playwright).",
    );
    process.exit(1);
  }
}
const { chromium } = loadPlaywright();

const ROOT = path.join(__dirname, "..");

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Mockingbird test page</title>
<body>
  <input id="field" type="text">
  <script>
    window.__calls = [];
    window.__actions = [];
    window.fetch = function (url, init) {
      var body = init && init.body ? JSON.parse(init.body) : null;
      window.__calls.push({ url: url, body: body });
      var reply = function (data) {
        return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(data); } });
      };
      if (url === '/api/actions') return reply(window.__actionsReply);
      if (url === '/api/act') return reply(window.__actReply);
      if (url === '/api/format') return reply({ text: 'Send the disclosures tomorrow.' });
      return reply({});
    };
  </script>
  <script src="${"file://" + path.join(ROOT, "src", "mockingbird.js")}" data-manual="true"></script>
</body>`;

const pageFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "mb-test-")),
  "index.html",
);
fs.writeFileSync(pageFile, PAGE);

let failures = 0;
function check(name, fn) {
  try {
    const result = fn();
    // An async assertion would resolve after we had already printed a tick.
    assert.ok(
      !result || typeof result.then !== "function",
      "assertions must be synchronous",
    );
    console.log("  ✓ " + name);
  } catch (err) {
    failures++;
    console.error("  ✗ " + name + "\n    " + err.message);
  }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("file://" + pageFile);

  await page.evaluate(() => {
    window.__handled = [];
    Mockingbird.init({
      formatEndpoint: "/api/format",
      getToken: async () => "test-session",
      actionsEndpoint: "/api/actions",
      actEndpoint: "/api/act",
      connectors: ["followupboss"],
      actions: [
        {
          name: "pop_dashboard_card",
          description: "Show a card on this app dashboard",
          input_schema: {
            type: "object",
            properties: { title: { type: "string" } },
          },
        },
      ],
      onAction: (name, input) => window.__handled.push({ name, input }),
      liveInsert: false,
    });
  });

  console.log("dictation");
  await page.evaluate(() => {
    window.__actionsReply = {
      kind: "dictation",
      text: "Send the disclosures tomorrow.",
    };
    document.getElementById("field").focus();
    Mockingbird.simulate("um send the disclosures tomorrow");
  });
  await page.waitForFunction(
    () => document.getElementById("field").value.length > 0,
    null,
    { timeout: 4000 },
  );
  const typed = await page.inputValue("#field");
  check("polished text lands in the focused field", () =>
    assert.strictEqual(typed, "Send the disclosures tomorrow."),
  );

  const calls = await page.evaluate(() => window.__calls);
  check("ordinary dictation never routes to CRM actions", () => {
    assert.strictEqual(
      calls.filter((c) => c.url === "/api/actions" || c.url === "/api/act")
        .length,
      0,
    );
  });
  check("no in-app action handler runs during dictation", () => {
    assert.strictEqual(calls.filter((c) => c.url === "/api/format").length, 1);
  });

  await browser.close();
  console.log(failures ? "\nFAILED" : "\nall good");
  process.exit(failures ? 1 : 0);
})();
