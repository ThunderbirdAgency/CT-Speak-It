const $ = (id) => document.getElementById(id);
let cfg;
function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}
function task(id, fn) {
  $(id).addEventListener(
    $(id).tagName === "FORM" ? "submit" : "click",
    async (e) => {
      e.preventDefault();
      const b =
        e.currentTarget.tagName === "FORM"
          ? e.currentTarget.querySelector("button")
          : e.currentTarget;
      b.disabled = true;
      try {
        await fn();
      } catch (err) {
        message(
          err.message.replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          ),
          true,
        );
      } finally {
        b.disabled = false;
      }
    },
  );
}
async function refresh() {
  cfg = await window.mbapp.getConfig();
  $("connection").textContent = cfg.connected
    ? "Connected. Your device session expires " +
      new Date(cfg.sessionExpiresAt).toLocaleDateString() +
      "."
    : "Open the website you received from Thunderbird. Sign in, then create a connection code in My devices.";
  $("version").textContent = "Version " + cfg.version;
  $("install-update").hidden = !cfg.updateReady;
  $("retry").disabled = !cfg.canRetry;
  $("disconnect").disabled = !cfg.connected;
  for (const k of [
    "dictationHotkey",
    "rewriteHotkey",
    "tone",
    "lang",
    "autoStopSeconds",
  ])
    $(k).value = cfg[k];
  for (const k of ["autoPaste", "learn", "keepHistory", "launchAtLogin"])
    $(k).checked = cfg[k];
  $("dictionary").value = cfg.dictionary.join("\n");
  await history();
}
async function history() {
  const entries = await window.mbapp.getHistory();
  $("history-list").replaceChildren();
  if (!entries.length) {
    $("history-list").textContent = "No saved history on this device.";
    return;
  }
  entries.forEach((e, i) => {
    const div = document.createElement("div");
    div.className = "entry";
    const date = document.createElement("strong");
    date.textContent = new Date(e.at).toLocaleString() + " · " + e.kind;
    const text = document.createElement("p");
    text.textContent = e.text;
    const copy = document.createElement("button");
    copy.className = "secondary small";
    copy.textContent = "Copy";
    copy.onclick = async () => {
      try {
        await window.mbapp.copyHistory(i);
        message("Copied.");
      } catch (err) {
        message(err.message, true);
      }
    };
    div.append(date, text, copy);
    $("history-list").append(div);
  });
}
document.querySelectorAll("[data-tab]").forEach(
  (b) =>
    (b.onclick = () => {
      document
        .querySelectorAll("[role=tabpanel]")
        .forEach((s) => (s.hidden = s.id !== b.dataset.tab));
      document
        .querySelectorAll("[data-tab]")
        .forEach((t) => t.setAttribute("aria-selected", t === b));
    }),
);
task("connect-form", async () => {
  await window.mbapp.connect($("connection-code").value);
  $("connection-code").value = "";
  await refresh();
  message(
    "Connected. Click a text field in another app and try your dictation shortcut.",
  );
});
task("preferences-form", async () => {
  const p = {};
  for (const k of [
    "dictationHotkey",
    "rewriteHotkey",
    "tone",
    "lang",
    "autoStopSeconds",
  ])
    p[k] = $(k).value;
  for (const k of ["autoPaste", "learn", "keepHistory", "launchAtLogin"])
    p[k] = $(k).checked;
  p.dictionary = $("dictionary")
    .value.split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  await window.mbapp.saveConfig(p);
  await refresh();
  message("Preferences saved.");
});
task("disconnect", async () => {
  await window.mbapp.disconnect();
  await refresh();
  message(
    "Signed out of this device. Revoke its session in My devices if needed.",
  );
});
task("account", () => window.mbapp.openAccount());
task("microphone", async () =>
  message(
    (await window.mbapp.microphone())
      ? "Microphone access is available."
      : "Allow microphone access in your system privacy settings.",
    false,
  ),
);
task("retry", async () => {
  await window.mbapp.retry();
  await refresh();
});
task("forget-recording", async () => {
  await window.mbapp.forgetRecording();
  await refresh();
  message("Recording discarded.");
});
task("clear-history", async () => {
  if (!confirm("Erase all saved dictation history on this device?")) return;
  await window.mbapp.clearHistory();
  await history();
  message("Local history cleared.");
});
task("updates", async () => message(await window.mbapp.checkUpdates()));
task("install-update", () => window.mbapp.installUpdate());
window.mbapp.onHistoryChanged(() =>
  refresh().catch((e) => message(e.message, true)),
);
refresh()
  .then(() => message("Your bird only listens when you activate it."))
  .catch((e) => message(e.message, true));
