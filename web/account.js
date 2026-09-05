const $ = (id) => document.getElementById(id);
let state,
  config,
  recorder,
  stream,
  chunks = [],
  recordTimer,
  recordBytes = 0,
  busy = false;
let starting = false,
  rewriteSource = "";
function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}
async function api(path, { method = "GET", body, raw = false } = {}) {
  const token = await window.Clerk.session?.getToken();
  const r = await fetch("/api/" + path, {
    method,
    headers: {
      Authorization: "Bearer " + (token || ""),
      ...(raw
        ? { "Content-Type": body.type }
        : { "Content-Type": "application/json" }),
    },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Please try again.");
  return data;
}
function task(id, fn) {
  $(id).addEventListener(
    $(id).tagName === "FORM" ? "submit" : "click",
    async (e) => {
      e.preventDefault();
      const button =
        e.currentTarget.tagName === "FORM"
          ? e.currentTarget.querySelector("button")
          : e.currentTarget;
      button.disabled = true;
      try {
        await fn();
      } catch (err) {
        message(err.message, true);
      } finally {
        button.disabled = false;
      }
    },
  );
}
function tab(name) {
  if (name === "admin" && !state?.admin) return;
  document
    .querySelectorAll("[role=tabpanel]")
    .forEach((el) => (el.hidden = el.id !== name));
  document
    .querySelectorAll("[data-tab]")
    .forEach((el) => el.setAttribute("aria-selected", el.dataset.tab === name));
  history.replaceState(null, "", "#" + name);
}
function date(value) {
  return value
    ? new Date(value).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "";
}
function row(title, detail, action) {
  const el = document.createElement("div");
  el.className = "entry";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const p = document.createElement("p");
  p.textContent = detail;
  el.append(strong, p);
  if (action) {
    const b = document.createElement("button");
    b.className = "secondary small";
    b.textContent = action.label;
    b.onclick = async () => {
      b.disabled = true;
      try {
        await action.run();
      } catch (err) {
        message(err.message, true);
        b.disabled = false;
      }
    };
    el.append(b);
  }
  return el;
}
async function refresh() {
  state = await api("account");
  const a = state.access;
  $("membership").textContent =
    a.source === "gift"
      ? `Pro, courtesy of Thunderbird · through ${date(a.giftUntil)}`
      : a.active
        ? "Your Mockingbird Pro membership is active."
        : "Your bird is ready. Activate Pro with a membership or gift code.";
  $("access-detail").textContent =
    a.source === "gift"
      ? `Thunderbird has covered your access through ${date(a.giftUntil)}. No card is required and this gift will not start billing.`
      : a.active
        ? `Your paid access is active through ${date(a.paidUntil)}. Manage renewal below.`
        : "Activate Pro to dictate and rewrite. You can manage or erase your saved preferences at any time.";
  $("checkout").hidden = a.active;
  $("checkout").disabled = !config.plan.billingReady;
  if (!config.plan.billingReady && !a.active)
    $("checkout").textContent = "Paid sign-up opens at launch";
  $("billing").disabled = !state.billingAvailable;
  $("memory-enabled").checked = state.memory_enabled;
  $("style").value = state.profile.writing_style || "";
  $("vocabulary").value = (state.profile.vocabulary || []).join("\n");
  $("phrases").value = (state.profile.phrases || []).join("\n");
  $("snippet-list").replaceChildren(
    ...state.snippets.map((s, i) =>
      row("“Insert " + s.trigger + "”", s.text, {
        label: "Remove",
        run: async () => {
          await api("account", {
            method: "PATCH",
            body: { snippets: state.snippets.filter((_, j) => j !== i) },
          });
          await refresh();
        },
      }),
    ),
  );
  if (!state.snippets.length)
    $("snippet-list").textContent =
      "No saved responses yet. Add your first one on the left.";
  $("device-list").replaceChildren(
    ...state.devices.map((d) =>
      row(d.name, "Session expires " + date(d.expires_at), {
        label: "Revoke access",
        run: async () => {
          await api("device", { method: "DELETE", body: { id: d.id } });
          await refresh();
        },
      }),
    ),
  );
  if (!state.devices.length)
    $("device-list").textContent = "No connected devices yet.";
  $("usage").textContent =
    `Today: ${state.usage.find((x) => x.bucket === "voice")?.used || 0} / 240 recordings · ${state.usage.find((x) => x.bucket === "text")?.used || 0} / 500 text requests. Limits reset at midnight UTC.`;
  $("admin-tab").hidden = !state.admin;
  if (state.admin) await refreshGifts();
}
async function refreshGifts() {
  const { codes } = await api("gifts");
  $("admin-list").replaceChildren(
    ...codes.map((c) =>
      row(
        c.label,
        `${c.uses}/${c.max_uses} claimed · ${c.duration_days} days of Pro · ${c.revoked_at ? "revoked" : "claim by " + date(c.expires_at)}`,
        c.revoked_at
          ? null
          : {
              label: "Stop new claims",
              run: async () => {
                await api("gifts", { method: "DELETE", body: { id: c.id } });
                await refreshGifts();
              },
            },
      ),
    ),
  );
}
async function copy(value) {
  await navigator.clipboard.writeText(value);
  message("Copied.");
}
function cleanupRecording() {
  clearTimeout(recordTimer);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $("record").dataset.recording = "false";
  $("record").textContent = "Start dictating";
}
async function stopAndTranscribe() {
  cleanupRecording();
  busy = true;
  $("record").disabled = true;
  $("record-status").textContent = " Transcribing…";
  try {
    const audio = new Blob(chunks, { type: recorder.mimeType });
    if (audio.size > 4 * 1024 * 1024)
      throw new Error("Recording too large. Please record a shorter message.");
    const result = await api("transcribe", {
      method: "POST",
      body: audio,
      raw: true,
    });
    let text = result.snippet || result.text || "";
    if (!result.snippet && text) {
      try {
        text = (
          await api("format", {
            method: "POST",
            body: { text, learn: state.memory_enabled },
          })
        ).text;
      } catch {
        message("Cleanup was unavailable. Your raw transcript is preserved.");
      }
    }
    const before = $("draft").value;
    $("draft").value = before + (before && text ? "\n" : "") + text;
    $("record-status").textContent = " Ready to review.";
  } catch (err) {
    message(err.message, true);
    $("record-status").textContent = " Recording could not be transcribed.";
  } finally {
    chunks = [];
    busy = false;
    $("record").disabled = false;
  }
}
$("record").onclick = async () => {
  if (busy || starting) return;
  if (recorder?.state === "recording") {
    recorder.stop();
    return;
  }
  try {
    if (!state.access.active) {
      tab("gift");
      message("Activate Pro to start dictating.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      throw new Error(
        "This browser does not support recording. Try a current Chrome, Edge, Safari, or the desktop app.",
      );
    starting = true;
    $("record").disabled = true;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
      (x) => MediaRecorder.isTypeSupported(x),
    );
    recorder = new MediaRecorder(stream, {
      ...(mime ? { mimeType: mime } : {}),
      audioBitsPerSecond: 32000,
    });
    chunks = [];
    recordBytes = 0;
    recorder.ondataavailable = (e) => {
      if (e.data.size) {
        chunks.push(e.data);
        recordBytes += e.data.size;
        if (recordBytes > 3900000 && recorder.state === "recording")
          recorder.stop();
      }
    };
    recorder.onerror = () => {
      cleanupRecording();
      message("Recording stopped unexpectedly. Please try again.", true);
    };
    recorder.onstop = stopAndTranscribe;
    recorder.start(500);
    recordTimer = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 180000);
    $("record").textContent = "Stop & transcribe";
    $("record").dataset.recording = "true";
    $("record-status").textContent = " Listening…";
  } catch (err) {
    cleanupRecording();
    message(
      err.name === "NotAllowedError"
        ? "Allow microphone access in your browser to dictate."
        : err.message,
      true,
    );
  } finally {
    starting = false;
    $("record").disabled = false;
  }
};
window.addEventListener("pagehide", () => {
  cleanupRecording();
});
document
  .querySelectorAll("[data-tab]")
  .forEach((b) => b.addEventListener("click", () => tab(b.dataset.tab)));
task("copy", () => copy($("draft").value));
task("clear-draft", async () => {
  $("draft").value = "";
  $("rewrite-preview").hidden = true;
});
task("rewrite", async () => {
  const source = $("draft").value;
  const result = await api("rewrite", {
    method: "POST",
    body: { text: source, instruction: $("instruction").value },
  });
  rewriteSource = source;
  $("revised").value = result.text;
  $("rewrite-preview").hidden = false;
});
task("accept-rewrite", async () => {
  if ($("draft").value !== rewriteSource)
    throw new Error(
      "Your draft changed after this rewrite started. Preview a fresh rewrite to keep your latest edits.",
    );
  $("draft").value = $("revised").value;
  $("rewrite-preview").hidden = true;
  message("Rewrite applied to this draft.");
});
task("discard-rewrite", async () => {
  $("rewrite-preview").hidden = true;
});
const lines = (id) =>
  $(id)
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
task("memory-form", async () => {
  await api("account", {
    method: "PATCH",
    body: {
      memory_enabled: $("memory-enabled").checked,
      profile: {
        writing_style: $("style").value,
        vocabulary: lines("vocabulary"),
        phrases: lines("phrases"),
      },
    },
  });
  await refresh();
  message("Your memory is saved. You can change it any time.");
});
task("suggest", async () => {
  const { suggestion } = await api("profile", {
    method: "POST",
    body: { sample: $("sample").value },
  });
  $("style").value = suggestion.writing_style;
  $("vocabulary").value = [
    ...new Set([...lines("vocabulary"), ...suggestion.vocabulary]),
  ].join("\n");
  $("phrases").value = [
    ...new Set([...lines("phrases"), ...suggestion.phrases]),
  ].join("\n");
  $("sample").value = "";
  message(
    "Suggestions are in the form. Review them and press Save if you want to keep them. Nothing has been saved yet.",
  );
});
task("export", async () => {
  const data = await api("account");
  delete data.admin;
  delete data.billingAvailable;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "mockingbird-account.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message(
    "Your account export is ready. Desktop history is kept separately on each device.",
  );
});
task("erase", async () => {
  if (
    !confirm(
      "Erase your saved memory and responses, and turn memory off? This cannot be undone.",
    )
  )
    return;
  await api("account", { method: "DELETE" });
  await refresh();
  message(
    "Memory and saved responses erased. Clear device-local history in desktop settings.",
  );
});
task("snippet-form", async () => {
  await api("account", {
    method: "PATCH",
    body: {
      snippets: [
        ...state.snippets,
        { trigger: $("trigger").value, text: $("snippet-text").value },
      ],
    },
  });
  $("snippet-form").reset();
  await refresh();
  message("Saved. Say “insert” followed by your phrase.");
});
task("pair", async () => {
  const result = await api("device", { method: "POST", body: {} });
  $("pair-code").textContent = result.connectionCode;
  $("pair-result").hidden = false;
  message("Paste this connection code into the desktop app within 10 minutes.");
});
task("copy-pair", () => copy($("pair-code").textContent));
for (const [id, action] of [
  ["checkout", "checkout"],
  ["billing", "portal"],
])
  task(id, async () => {
    const result = await api("billing", { method: "POST", body: { action } });
    const u = new URL(result.url);
    if (
      u.protocol !== "https:" ||
      !["checkout.stripe.com", "billing.stripe.com"].includes(u.hostname)
    )
      throw new Error("Invalid billing link");
    location.assign(u.href);
  });
task("gift-form", async () => {
  const result = await api("gifts", {
    method: "POST",
    body: { action: "redeem", code: $("gift-code").value },
  });
  $("gift-code").value = "";
  await refresh();
  message(result.message);
});
task("admin-form", async () => {
  const result = await api("gifts", {
    method: "POST",
    body: {
      label: $("gift-label").value,
      days: Number($("gift-days").value),
      uses: Number($("gift-uses").value),
    },
  });
  $("new-gift").textContent = result.code + " — " + result.message;
  $("new-gift").hidden = false;
  await refreshGifts();
  message("Gift created. Copy the code before leaving this page.");
});
async function script(src, attributes = {}) {
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.crossOrigin = "anonymous";
    for (const [k, v] of Object.entries(attributes)) s.setAttribute(k, v);
    s.onload = resolve;
    s.onerror = () =>
      reject(new Error("Sign-in could not load. Please try again."));
    document.head.append(s);
  });
}
try {
  const response = await fetch("/api/public");
  if (!response.ok)
    throw new Error("Account setup is temporarily unavailable.");
  config = await response.json();
  if (!config.clerkPublishableKey)
    throw new Error(
      "Account sign-in is being prepared. Please check back at launch.",
    );
  const domain = atob(config.clerkPublishableKey.split("_")[2]).replace(
    /\$$/,
    "",
  );
  if (!/^[a-zA-Z0-9.-]+$/.test(domain))
    throw new Error("Sign-in configuration needs attention.");
  await script(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`);
  await script(
    `https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`,
    { "data-clerk-publishable-key": config.clerkPublishableKey },
  );
  await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  if (!window.Clerk.user) {
    message("Sign in or create your account to connect your bird.");
    window.Clerk.mountSignIn($("sign-in"), {
      forceRedirectUrl: location.origin + "/account" + location.hash,
      signUpForceRedirectUrl: location.origin + "/account",
    });
  } else {
    window.Clerk.mountUserButton($("user-button"));
    await refresh();
    $("app").hidden = false;
    if (config.hubUrl) {
      $("hub-link").href = config.hubUrl;
      $("hub-link").hidden = false;
    }
    const requested = location.hash.slice(1);
    if (document.querySelector(`[data-tab="${CSS.escape(requested)}"]`))
      tab(requested);
    message(
      new URLSearchParams(location.search).get("checkout") === "success"
        ? "Thanks. Your membership will appear after payment confirmation. Refresh this page if it is still processing."
        : "Welcome. Your words are yours.",
    );
  }
} catch (err) {
  message(err.message, true);
}
