(function () {
  var card = document.getElementById("card");
  var row = document.getElementById("row");
  var line1 = document.getElementById("line1");
  var line2 = document.getElementById("line2");
  var keys = document.getElementById("keys");
  var barsEl = document.getElementById("bars");
  var bars = barsEl.children;
  var actionsEl = document.getElementById("actions");
  var footer = document.getElementById("footer");
  var footerText = document.getElementById("footerText");

  var mode = "dictation";
  var sessionId = null,
    generation = 0,
    maxTimer = null,
    stopRequested = false;
  var recorder = null,
    chunks = [],
    stream = null,
    meter = null,
    autoStopTimer = null;
  var confirming = false;

  function show() {
    requestAnimationFrame(function () {
      card.classList.add("in");
    });
  }

  function paint(state, message, detail, keyHint) {
    card.className =
      "card in " +
      state +
      (mode === "command" && state === "listening" ? " command" : "");
    line1.textContent = message || "";
    line1.className = "line1" + (state === "listening" ? " muted" : "");
    if (detail) {
      line2.textContent = detail;
      line2.classList.remove("hidden");
    } else line2.classList.add("hidden");
    keys.textContent = (keyHint || "").replace(/<\/?kbd>/g, "");
  }

  function clearConfirm() {
    confirming = false;
    actionsEl.classList.add("hidden");
    footer.classList.add("hidden");
    actionsEl.innerHTML = "";
  }

  // --------------------------------------------------------------- capture

  function startMeter(src) {
    try {
      var ctx = new AudioContext();
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      ctx.createMediaStreamSource(src).connect(analyser);
      var data = new Uint8Array(analyser.frequencyBinCount);
      meter = { ctx: ctx, raf: 0, quietSince: Date.now() };
      var tick = function () {
        if (!meter) return;
        analyser.getByteFrequencyData(data);
        var sum = 0;
        for (var i = 2; i < 40; i++) sum += data[i];
        var level = Math.min(1, sum / 38 / 140);
        for (var b = 0; b < bars.length; b++) {
          var weight = 0.55 + 0.45 * Math.sin((b + 1) * 1.7 + Date.now() / 90);
          bars[b].style.height =
            Math.max(4, Math.round(4 + level * weight * 16)) + "px";
        }
        if (level > 0.06) meter.quietSince = Date.now();
        meter.raf = requestAnimationFrame(tick);
      };
      meter.raf = requestAnimationFrame(tick);
    } catch (e) {
      /* the meter is decorative — never block dictation for it */
    }
  }

  function stopMeter() {
    if (!meter) return;
    cancelAnimationFrame(meter.raf);
    try {
      meter.ctx.close();
    } catch (e) {}
    meter = null;
  }

  function begin(payload) {
    var gen = ++generation;
    sessionId = payload.sessionId;
    stopRequested = false;
    mode = (payload && payload.mode) || "dictation";
    clearConfirm();
    show();
    paint(
      "listening",
      mode === "rewrite" ? "How should I rewrite it?" : "Listening…",
      "",
      "<kbd>" + (payload.hotkey || "") + "</kbd> to finish",
    );

    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      .then(function (s) {
        if (gen !== generation) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        chunks = [];
        recorder = new MediaRecorder(
          s,
          MediaRecorder.isTypeSupported("audio/webm")
            ? { mimeType: "audio/webm", audioBitsPerSecond: 32000 }
            : { audioBitsPerSecond: 32000 },
        );
        recorder.ondataavailable = function (e) {
          if (e.data && e.data.size) chunks.push(e.data);
        };
        recorder.onstop = function () {
          deliverAudio();
        };
        recorder.start(500);
        maxTimer = setTimeout(finish, 180000);
        if (stopRequested) finish();
        startMeter(s);
        if (payload.autoStopSeconds > 0) {
          autoStopTimer = setInterval(function () {
            if (
              meter &&
              Date.now() - meter.quietSince > payload.autoStopSeconds * 1000
            )
              finish();
          }, 300);
        }
      })
      .catch(function () {
        if (gen !== generation) return;
        teardown();
        window.mb.recordingError(sessionId);
        paint(
          "error",
          "Microphone access denied",
          "Allow the microphone for Mockingbird in your system privacy settings.",
        );
      });
  }

  function teardown() {
    clearTimeout(maxTimer);
    if (autoStopTimer) {
      clearInterval(autoStopTimer);
      autoStopTimer = null;
    }
    stopMeter();
    if (stream) {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
      stream = null;
    }
  }

  function finish() {
    if (!recorder || recorder.state !== "recording") {
      stopRequested = true;
      return;
    }
    if (autoStopTimer) {
      clearInterval(autoStopTimer);
      autoStopTimer = null;
    }
    recorder.stop();
  }

  function cancel(options) {
    generation++;
    if (recorder && recorder.state === "recording") {
      recorder.onstop = null;
      recorder.stop();
    }
    teardown();
    clearConfirm();
    // A silent cancel comes from main (switching modes) and has already been
    // accounted for there; anything else is the user pressing Escape.
    if (!options || !options.silent) window.mb.cancelled(sessionId);
  }

  function deliverAudio() {
    teardown();
    paint("working", "Transcribing…");
    var audioSession = sessionId,
      audioMode = mode;
    var blob = new Blob(chunks, {
      type: (recorder && recorder.mimeType) || "audio/webm",
    });
    blob.arrayBuffer().then(function (buf) {
      window.mb.sendAudio(new Uint8Array(buf), audioMode, audioSession);
    });
  }

  // --------------------------------------------------------------- confirm

  function renderConfirm(payload) {
    confirming = true;
    paint(
      "working",
      "Review your rewrite",
      "Your original stays unchanged until you accept.",
      "",
    );
    actionsEl.replaceChildren();
    for (var pair of [
      ["Original", payload.original],
      ["Suggested rewrite", payload.text],
    ]) {
      var title = document.createElement("strong");
      title.textContent = pair[0];
      var content = document.createElement("p");
      content.textContent = pair[1];
      content.style.whiteSpace = "pre-wrap";
      actionsEl.append(title, content);
    }
    var accept = document.createElement("button");
    accept.textContent = "Use rewrite";
    accept.onclick = function () {
      clearConfirm();
      window.mb.confirm(true);
    };
    var cancelButton = document.createElement("button");
    cancelButton.textContent = "Keep original";
    cancelButton.onclick = function () {
      clearConfirm();
      window.mb.confirm(false);
    };
    actionsEl.append(accept, cancelButton);
    actionsEl.style.maxHeight = "290px";
    actionsEl.style.overflowY = "auto";
    actionsEl.classList.remove("hidden");
    footer.classList.remove("hidden");
    footerText.textContent = "Enter accepts · Escape keeps original";
    show();
    window.focus();
  }

  document.addEventListener("keydown", function (e) {
    if (confirming) {
      if (e.key === "Enter") {
        e.preventDefault();
        clearConfirm();
        window.mb.confirm(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        clearConfirm();
        window.mb.confirm(false);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });

  // Clicking the pill while it is listening finishes, the way the mic button
  // does in the web widget.
  row.addEventListener("click", function () {
    if (recorder && recorder.state === "recording") finish();
  });

  // ------------------------------------------------------------- main wiring

  window.mb.onListen(begin);
  window.mb.onStop(finish);
  window.mb.onCancel(cancel);
  window.mb.onConfirm(renderConfirm);
  window.mb.onStatus(function (payload) {
    if (confirming && payload.state === "working") clearConfirm();
    if (payload.state === "idle") {
      clearConfirm();
      return;
    }
    paint(payload.state, payload.message, payload.detail, "");
  });
})();
