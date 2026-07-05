/*!
 * Mockingbird 🐦 — voice for every Thunderbird build.
 *
 * Dictation: hold a hotkey (or tap the floating mic), speak, release — clean,
 * Claude-polished text is inserted wherever your cursor is.
 *
 * Voice actions: register your app's actions (create_contact, create_open_house,
 * add_task, ...) and spoken input becomes structured objects delivered to your
 * handler — one utterance can produce several ("three people came through:
 * John..., Maria..., Sam..." → three create_contact actions).
 *
 * Usage (zero config):
 *   <script src="mockingbird.js"></script>
 *
 * Usage (configured):
 *   <script src="mockingbird.js"
 *           data-format-endpoint="/api/format"
 *           data-transcribe-endpoint="/api/transcribe"
 *           data-actions-endpoint="/api/actions"></script>
 *
 * Voice actions (in your app code):
 *   Mockingbird.registerActions([
 *     { name: 'create_contact',
 *       description: 'Save a new contact/lead',
 *       input_schema: { type: 'object', properties: {
 *         name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }
 *       }, required: ['name'] } }
 *   ], (name, input) => crm.handle(name, input));
 */
(function (global, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    global.Mockingbird = factory();
    global.SpeakIt = global.Mockingbird; // back-compat alias
    if (typeof document !== 'undefined') {
      var boot = function () { global.Mockingbird._autoInit(); };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
      } else {
        boot();
      }
    }
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var VERSION = '3.1.0';
  var DICT_STORAGE_KEY = 'mockingbird.dictionary';
  var LEGACY_DICT_KEY = 'speakit.dictionary';

  var DEFAULTS = {
    // Hold-to-talk hotkey. String form: "Ctrl+Space", "Alt+D", "Ctrl+Shift+M"...
    hotkey: 'Ctrl+Space',
    // 'browser' = Web Speech API. 'server' = record audio -> transcribeEndpoint
    // (Whisper-grade; see api/transcribe.js). 'auto' = server if endpoint given,
    // else browser.
    engine: 'auto',
    lang: 'en-US',
    // Claude cleanup endpoint: POST {text, tone, appContext, dictionary, user} -> {text}.
    formatEndpoint: null,
    // Server transcription endpoint: POST audio/webm body -> {text}.
    transcribeEndpoint: null,
    // Voice-actions endpoint: POST {text, actions, appContext, dictionary, user}
    //   -> {kind:'actions', actions:[{name, input}, ...]} | {kind:'dictation', text}.
    actionsEndpoint: null,
    // Registered actions: [{name, description, input_schema}]. Usually set via
    // Mockingbird.registerActions(actions, handler).
    actions: [],
    onAction: null,        // (name, input) => void — called once per matched action
    // Writing style for the formatter: 'clean' | 'formal' | 'casual' | 'code-comment'
    tone: 'clean',
    // Extra context sent to Claude (e.g. "real-estate CRM, open-house scheduling").
    appContext: '',
    // Who is speaking — flows through to the event log (Supabase) for analytics.
    userId: null,
    // Personal dictionary: names, neighborhoods, jargon the recognizer gets wrong.
    // Merged with words learned via Mockingbird.learn(), persisted in localStorage.
    dictionary: [],
    // Insert the raw transcript instantly, then swap in the polished version
    // when Claude responds (inputs/textareas only — feels instant).
    liveInsert: true,
    button: true,
    position: 'bottom-right', // bottom-right | bottom-left | top-right | top-left
    zIndex: 2147483000,
    onTranscript: null,    // (finalText) => void — fired after insertion
    onError: null,         // (err) => void
    onStateChange: null    // (state) => void — idle|listening|polishing|done|error
  };

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function parseHotkey(str) {
    var parts = String(str).split('+').map(function (p) { return p.trim().toLowerCase(); });
    var spec = { ctrl: false, alt: false, shift: false, meta: false, key: null };
    parts.forEach(function (p) {
      if (p === 'ctrl' || p === 'control') spec.ctrl = true;
      else if (p === 'alt' || p === 'option') spec.alt = true;
      else if (p === 'shift') spec.shift = true;
      else if (p === 'cmd' || p === 'meta' || p === 'win') spec.meta = true;
      else spec.key = p === 'space' ? ' ' : p;
    });
    return spec;
  }

  function matchesHotkey(e, spec) {
    if (!spec.key) return false;
    var key = (e.key || '').toLowerCase();
    return key === spec.key &&
      e.ctrlKey === spec.ctrl &&
      e.altKey === spec.alt &&
      e.shiftKey === spec.shift &&
      e.metaKey === spec.meta;
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (tag === 'INPUT') {
      var ok = ['text', 'search', 'url', 'tel', 'email', 'password'];
      return ok.indexOf(el.type) !== -1 && !el.disabled && !el.readOnly;
    }
    return false;
  }

  // Set value through the native setter so React/Vue/Svelte state stays in sync.
  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fireInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function needsLeadingSpace(before, text) {
    if (!before || !text) return false;
    return !/\s$/.test(before) && !/^[\s.,!?;:)\]}]/.test(text);
  }

  function loadStoredDictionary() {
    try {
      var raw = localStorage.getItem(DICT_STORAGE_KEY) || localStorage.getItem(LEGACY_DICT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function saveStoredDictionary(words) {
    try { localStorage.setItem(DICT_STORAGE_KEY, JSON.stringify(words)); } catch (e) { /* private mode */ }
  }

  // ---------------------------------------------------------------------------
  // The widget
  // ---------------------------------------------------------------------------

  function MockingbirdInstance(options) {
    this.opts = Object.assign({}, DEFAULTS, options || {});
    this.hotkeySpec = parseHotkey(this.opts.hotkey);
    this.state = 'idle';
    this.target = null;        // last focused editable element
    this.savedRange = null;    // caret position in that element
    this.recognition = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.finalTranscript = '';
    this.holding = false;
    this.toggled = false;
    this._bound = {};
    this._buildUI();
    this._bindEvents();
  }

  MockingbirdInstance.prototype = {

    // ------------------------------------------------------------- lifecycle

    _bindEvents: function () {
      var self = this;
      this._bound.focusin = function (e) {
        if (isEditable(e.target)) self._captureTarget(e.target);
      };
      this._bound.selectionchange = function () {
        if (self.target && document.activeElement === self.target) self._captureTarget(self.target);
      };
      this._bound.keydown = function (e) {
        if (e.key === 'Escape' && self.state === 'listening') { self.cancel(); return; }
        if (matchesHotkey(e, self.hotkeySpec)) {
          e.preventDefault();
          if (!e.repeat && !self.holding) {
            self.holding = true;
            self.start();
          }
        }
      };
      this._bound.keyup = function (e) {
        var key = (e.key || '').toLowerCase();
        var spec = self.hotkeySpec;
        var released = key === spec.key ||
          (spec.ctrl && key === 'control') || (spec.alt && key === 'alt') ||
          (spec.shift && key === 'shift') || (spec.meta && key === 'meta');
        if (self.holding && released) {
          self.holding = false;
          if (!self.toggled) self.stop();
        }
      };
      document.addEventListener('focusin', this._bound.focusin, true);
      document.addEventListener('selectionchange', this._bound.selectionchange);
      document.addEventListener('keydown', this._bound.keydown, true);
      document.addEventListener('keyup', this._bound.keyup, true);
      if (isEditable(document.activeElement)) this._captureTarget(document.activeElement);
    },

    destroy: function () {
      this.cancel();
      document.removeEventListener('focusin', this._bound.focusin, true);
      document.removeEventListener('selectionchange', this._bound.selectionchange);
      document.removeEventListener('keydown', this._bound.keydown, true);
      document.removeEventListener('keyup', this._bound.keyup, true);
      if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
    },

    _captureTarget: function (el) {
      this.target = el;
      if (el.isContentEditable) {
        var sel = window.getSelection();
        this.savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      } else {
        this.savedRange = { start: el.selectionStart, end: el.selectionEnd };
      }
    },

    _dictionary: function () {
      var merged = (this.opts.dictionary || []).concat(loadStoredDictionary());
      var seen = {};
      return merged.filter(function (w) {
        w = String(w).trim();
        if (!w || seen[w.toLowerCase()]) return false;
        seen[w.toLowerCase()] = true;
        return true;
      });
    },

    // ------------------------------------------------------------------- UI

    _buildUI: function () {
      if (typeof document === 'undefined') return;
      var host = document.createElement('div');
      host.setAttribute('data-mockingbird', '');
      var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
      var pos = {
        'bottom-right': 'bottom:24px;right:24px;',
        'bottom-left': 'bottom:24px;left:24px;',
        'top-right': 'top:24px;right:24px;',
        'top-left': 'top:24px;left:24px;'
      }[this.opts.position] || 'bottom:24px;right:24px;';

      var style = document.createElement('style');
      style.textContent =
        ':host{all:initial}' +
        '.mb-wrap{position:fixed;' + pos + 'z-index:' + this.opts.zIndex + ';display:flex;align-items:center;gap:10px;' +
        'font:500 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;flex-direction:row-reverse;}' +
        '.mb-btn{width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
        'background:linear-gradient(180deg,#1a2027,#0c1014);color:#e8ecf1;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.09),inset 0 0 0 1px rgba(255,255,255,.06);' +
        'transition:transform .25s cubic-bezier(.2,1.6,.4,1),background .3s ease,box-shadow .3s ease;}' +
        '.mb-btn:hover{transform:scale(1.08)}' +
        '.mb-btn:active{transform:scale(.94)}' +
        '.mb-btn svg{width:22px;height:22px;display:block;transition:transform .25s cubic-bezier(.2,1.6,.4,1)}' +
        '.mb-wrap.listening .mb-btn{background:linear-gradient(180deg,#e04545,#a81f1f);animation:mb-pulse 1.6s ease infinite}' +
        '.mb-wrap.listening .mb-btn svg{transform:scale(1.12)}' +
        '.mb-wrap.polishing .mb-btn{background:linear-gradient(180deg,#8d6ee8,#6a48c8)}' +
        '.mb-wrap.done .mb-btn{background:linear-gradient(180deg,#2a9d5e,#177a42)}' +
        '.mb-wrap.error .mb-btn{background:linear-gradient(180deg,#b08b12,#7a5f00)}' +
        '@keyframes mb-pulse{0%{box-shadow:0 6px 24px rgba(0,0,0,.4),0 0 0 0 rgba(224,69,69,.4)}70%{box-shadow:0 6px 24px rgba(0,0,0,.4),0 0 0 18px rgba(224,69,69,0)}100%{box-shadow:0 6px 24px rgba(0,0,0,.4),0 0 0 0 rgba(224,69,69,0)}}' +
        '.mb-pill{max-width:360px;background:rgba(13,17,23,.82);-webkit-backdrop-filter:blur(14px) saturate(1.4);backdrop-filter:blur(14px) saturate(1.4);' +
        'color:#e8ecf1;border-radius:16px;padding:10px 15px;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px rgba(255,255,255,.06);' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
        'opacity:0;transform:translateX(12px) scale(.95);pointer-events:none;' +
        'transition:opacity .28s ease,transform .34s cubic-bezier(.2,1.5,.4,1);}' +
        '.mb-wrap.listening .mb-pill,.mb-wrap.polishing .mb-pill,.mb-wrap.done .mb-pill,.mb-wrap.error .mb-pill{opacity:1;transform:translateX(0) scale(1)}' +
        '.mb-pill .mb-hint{opacity:.55;font-weight:400}' +
        '.mb-pill .mb-ok{color:#7ee2a8}' +
        '.mb-bars{display:inline-flex;gap:2.5px;align-items:center;height:16px;margin-right:9px;vertical-align:-3px}' +
        '.mb-bars i{width:3px;height:4px;background:#ff9d94;border-radius:2px;transition:height .08s ease}' +
        '.mb-bars:not(.mb-live) i{animation:mb-bar 1s ease-in-out infinite}' +
        '.mb-bars:not(.mb-live) i:nth-child(2){animation-delay:.12s}.mb-bars:not(.mb-live) i:nth-child(3){animation-delay:.24s}' +
        '.mb-bars:not(.mb-live) i:nth-child(4){animation-delay:.36s}.mb-bars:not(.mb-live) i:nth-child(5){animation-delay:.48s}' +
        '@keyframes mb-bar{0%,100%{height:4px}50%{height:13px}}';

      var wrap = document.createElement('div');
      wrap.className = 'mb-wrap';

      var btn = document.createElement('button');
      btn.className = 'mb-btn';
      btn.type = 'button';
      btn.title = 'Dictate (' + this.opts.hotkey + ' to hold-and-talk, Esc to cancel)';
      btn.setAttribute('aria-label', 'Start dictation');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>' +
        '<path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';
      if (!this.opts.button) btn.style.display = 'none';

      var pill = document.createElement('div');
      pill.className = 'mb-pill';

      var self = this;
      // mousedown preventDefault keeps focus in the user's input while clicking the mic.
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
      btn.addEventListener('click', function () { self.toggle(); });

      wrap.appendChild(btn);
      wrap.appendChild(pill);
      shadow.appendChild(style);
      shadow.appendChild(wrap);
      document.body ? document.body.appendChild(host)
        : document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(host); });

      this.host = host;
      this.ui = { wrap: wrap, btn: btn, pill: pill };
    },

    _setState: function (state, message) {
      if (state !== 'listening') this._stopMeter();
      this.state = state;
      var ui = this.ui;
      var self = this;
      if (ui) {
        ui.wrap.className = 'mb-wrap' + (state !== 'idle' ? ' ' + state : '');
        if (state === 'listening') {
          ui.pill.innerHTML = '<span class="mb-bars"><i></i><i></i><i></i><i></i><i></i></span>' +
            '<span class="mb-text mb-hint">Listening… release ' + this.opts.hotkey + ' or click mic to finish</span>';
        } else if (state === 'polishing') {
          ui.pill.innerHTML = '<span class="mb-text mb-hint">✨ ' + (message || 'Polishing…') + '</span>';
        } else if (state === 'done') {
          ui.pill.innerHTML = '<span class="mb-ok">✓ ' + (message || 'Done') + '</span>';
          setTimeout(function () { if (self.state === 'done') self._setState('idle'); }, 2200);
        } else if (state === 'error') {
          ui.pill.textContent = '⚠ ' + (message || 'Something went wrong');
          setTimeout(function () { if (self.state === 'error') self._setState('idle'); }, 3500);
        }
      }
      if (typeof this.opts.onStateChange === 'function') this.opts.onStateChange(state);
    },

    _showInterim: function (text) {
      if (this.state !== 'listening' || !this.ui) return;
      var span = this.ui.pill.querySelector('.mb-text');
      if (span && text) {
        span.className = 'mb-text';
        span.textContent = text;
      }
    },

    // ------------------------------------------------------------ recording

    // Real voice-level waveform: five bars driven by mic amplitude.
    _startMeter: function (stream) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !this.ui) return;
      try {
        var ctx = new AC();
        var analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.75;
        ctx.createMediaStreamSource(stream).connect(analyser);
        var data = new Uint8Array(analyser.frequencyBinCount);
        var self = this;
        this._meter = { ctx: ctx, raf: 0, ownStream: null };
        var tick = function () {
          if (!self._meter) return;
          var barsEl = self.ui.pill.querySelector('.mb-bars');
          if (barsEl) {
            barsEl.classList.add('mb-live');
            analyser.getByteFrequencyData(data);
            var sum = 0;
            for (var i = 2; i < 40; i++) sum += data[i];
            var level = Math.min(1, (sum / 38) / 140);
            var bars = barsEl.children;
            for (var b = 0; b < bars.length; b++) {
              var weight = 0.55 + 0.45 * Math.sin((b + 1) * 1.7 + Date.now() / 90);
              bars[b].style.height = Math.max(3, Math.round(3 + level * weight * 14)) + 'px';
            }
          }
          self._meter.raf = requestAnimationFrame(tick);
        };
        this._meter.raf = requestAnimationFrame(tick);
      } catch (e) { /* meter is decorative — never block dictation */ }
    },

    _stopMeter: function () {
      if (!this._meter) return;
      cancelAnimationFrame(this._meter.raf);
      try { this._meter.ctx.close(); } catch (e) {}
      if (this._meter.ownStream) {
        this._meter.ownStream.getTracks().forEach(function (t) { t.stop(); });
      }
      this._meter = null;
    },


    start: function () {
      if (this.state === 'listening') return;
      this.finalTranscript = '';
      var engine = this._resolveEngine();
      if (!engine) {
        this._fail('No speech engine available. Use Chrome/Edge/Safari, or set transcribeEndpoint.');
        return;
      }
      this._setState('listening');
      if (engine === 'browser') this._startBrowser();
      else this._startServer();
    },

    stop: function () {
      this.toggled = false;
      if (this.state !== 'listening') return;
      if (this.recognition) {
        try { this.recognition.stop(); } catch (e) { /* already stopped */ }
      }
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop();
      }
    },

    cancel: function () {
      this.toggled = false;
      this._cancelled = true;
      if (this.recognition) { try { this.recognition.abort(); } catch (e) {} }
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') this.mediaRecorder.stop();
      this._setState('idle');
      var self = this;
      setTimeout(function () { self._cancelled = false; }, 300);
    },

    toggle: function () {
      if (this.state === 'listening') { this.stop(); }
      else { this.toggled = true; this.start(); }
    },

    _resolveEngine: function () {
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (this.opts.engine === 'browser') return SR ? 'browser' : null;
      if (this.opts.engine === 'server') return this.opts.transcribeEndpoint ? 'server' : null;
      // auto: prefer the Whisper-grade server engine when an endpoint is configured.
      if (this.opts.transcribeEndpoint) return 'server';
      return SR ? 'browser' : null;
    },

    _startBrowser: function () {
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      var rec = new SR();
      var self = this;
      rec.lang = this.opts.lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = function (e) {
        var interim = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var t = e.results[i][0].transcript;
          if (e.results[i].isFinal) self.finalTranscript += t;
          else interim += t;
        }
        self._showInterim((self.finalTranscript + ' ' + interim).trim());
      };
      rec.onerror = function (e) {
        if (e.error === 'aborted' || self._cancelled) return;
        if (e.error === 'no-speech') { self._setState('idle'); return; }
        self._fail(
          e.error === 'not-allowed' ? 'Microphone access denied' : 'Speech error: ' + e.error
        );
      };
      rec.onend = function () {
        self.recognition = null;
        if (self._cancelled || self.state === 'error') return;
        // If the user is still holding the key, Chrome sometimes auto-ends; restart.
        if (self.state === 'listening' && (self.holding || self.toggled)) {
          try { self._startBrowser(); return; } catch (e) { /* fall through */ }
        }
        self._finish(self.finalTranscript.trim());
      };
      this.recognition = rec;
      rec.start();
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
          if (self.state !== 'listening') { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
          self._startMeter(stream);
          if (self._meter) self._meter.ownStream = stream;
        }).catch(function () { /* keep the idle animation */ });
      }
    },

    _startServer: function () {
      var self = this;
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var mime = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm' : '';
        var mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        self.chunks = [];
        mr.ondataavailable = function (e) { if (e.data.size) self.chunks.push(e.data); };
        mr.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          if (self._cancelled) return;
          var blob = new Blob(self.chunks, { type: mr.mimeType || 'audio/webm' });
          self._setState('polishing', 'Transcribing…');
          fetch(self.opts.transcribeEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': blob.type,
              'X-Mockingbird-Lang': self.opts.lang,
              'X-Mockingbird-User': self.opts.userId || ''
            },
            body: blob
          })
            .then(function (r) { if (!r.ok) throw new Error('Transcription failed (' + r.status + ')'); return r.json(); })
            .then(function (data) { self._finish((data.text || '').trim()); })
            .catch(function (err) { self._fail(err.message); });
        };
        self.mediaRecorder = mr;
        mr.start();
        self._startMeter(stream);
      }).catch(function () { self._fail('Microphone access denied'); });
    },

    // ------------------------------------------------------ finish pipeline

    // Entry point after transcription (also used by Mockingbird.simulate()).
    _finish: function (raw) {
      raw = (raw || '').trim();
      if (!raw) { this._setState('idle'); return; }
      if (this.opts.actionsEndpoint && this.opts.actions.length) {
        this._resolveAction(raw);
      } else if (this.opts.formatEndpoint) {
        this._polish(raw);
      } else {
        this._insert(raw);
      }
    },

    // Voice actions: ask Claude whether this is command(s) or dictation.
    // One utterance can yield several actions (e.g. multiple contacts).
    _resolveAction: function (raw) {
      var self = this;
      this._setState('polishing', 'Understanding…');
      fetch(this.opts.actionsEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: raw,
          actions: this.opts.actions,
          appContext: this.opts.appContext || document.title,
          dictionary: this._dictionary(),
          user: this.opts.userId
        })
      })
        .then(function (r) { if (!r.ok) throw new Error('actions ' + r.status); return r.json(); })
        .then(function (data) {
          var list = null;
          if (data && data.kind === 'actions' && Array.isArray(data.actions)) list = data.actions;
          else if (data && data.kind === 'action' && data.name) list = [{ name: data.name, input: data.input }];
          if (list && list.length) {
            list.forEach(function (a) {
              if (a && a.name && typeof self.opts.onAction === 'function') {
                self.opts.onAction(a.name, a.input || {});
              }
            });
            var label = list.length === 1
              ? list[0].name.replace(/_/g, ' ')
              : list.length + ' items added';
            self._setState('done', label);
          } else if (data && data.kind === 'dictation' && data.text) {
            self._insert(String(data.text).trim());
          } else {
            self._insert(raw);
          }
        })
        .catch(function () {
          // Endpoint down — degrade to plain dictation so nothing is lost.
          if (self.opts.formatEndpoint) self._polish(raw);
          else self._insert(raw);
        });
    },

    // Claude cleanup. With liveInsert, raw words land instantly and get swapped
    // for the polished version when it arrives (inputs/textareas only —
    // contenteditable editors get the polished text once, to stay framework-safe).
    _polish: function (raw) {
      var self = this;
      var pending = null;
      var el = this.target;
      var canLive = this.opts.liveInsert && el && document.contains(el) &&
        isEditable(el) && !el.isContentEditable;
      if (canLive) pending = this._insertField(el, raw);
      this._setState('polishing');
      fetch(this.opts.formatEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: raw,
          tone: this.opts.tone,
          appContext: this.opts.appContext || document.title,
          dictionary: this._dictionary(),
          user: this.opts.userId
        })
      })
        .then(function (r) { if (!r.ok) throw new Error('format ' + r.status); return r.json(); })
        .then(function (data) {
          var polished = (data.text || raw).trim();
          if (pending) self._replaceField(pending, polished);
          else self._insert(polished);
          if (pending) {
            self._setState('idle');
            if (typeof self.opts.onTranscript === 'function') self.opts.onTranscript(polished);
          }
        })
        .catch(function () {
          // Formatter down: the raw text is already in (live) or goes in now.
          if (!pending) self._insert(raw);
          else {
            self._setState('idle');
            if (typeof self.opts.onTranscript === 'function') self.opts.onTranscript(raw);
          }
        });
    },

    // ---------------------------------------------------------- insertion

    _insertField: function (el, text) {
      var r = this.savedRange && this.savedRange.start != null
        ? this.savedRange
        : { start: el.value.length, end: el.value.length };
      var start = Math.min(r.start, el.value.length);
      var end = Math.min(r.end != null ? r.end : start, el.value.length);
      var before = el.value.slice(0, start);
      var inserted = (needsLeadingSpace(before, text) ? ' ' : '') + text;
      setNativeValue(el, before + inserted + el.value.slice(end));
      var caret = start + inserted.length;
      try { el.setSelectionRange(caret, caret); } catch (e) { /* non-text inputs */ }
      fireInput(el);
      this._captureTarget(el);
      return { el: el, start: start, inserted: inserted, text: text };
    },

    _replaceField: function (pending, polished) {
      var el = pending.el;
      if (!document.contains(el)) return;
      var val = el.value;
      var end = pending.start + pending.inserted.length;
      // Only swap if the raw insert is still untouched (user may have kept typing after it).
      if (val.slice(pending.start, end) !== pending.inserted) return;
      var before = val.slice(0, pending.start);
      var replacement = (needsLeadingSpace(before, polished) ? ' ' : '') + polished;
      setNativeValue(el, before + replacement + val.slice(end));
      var hadFocus = document.activeElement === el;
      if (hadFocus) {
        var caret = pending.start + replacement.length;
        try { el.setSelectionRange(caret, caret); } catch (e) {}
      }
      fireInput(el);
      this._captureTarget(el);
    },

    _insertContentEditable: function (el, text) {
      el.focus();
      var sel = window.getSelection();
      if (this.savedRange && this.savedRange.cloneRange) {
        sel.removeAllRanges();
        sel.addRange(this.savedRange);
      }
      var before = sel.anchorNode && sel.anchorNode.textContent
        ? sel.anchorNode.textContent.slice(0, sel.anchorOffset) : '';
      if (needsLeadingSpace(before, text)) text = ' ' + text;
      // execCommand still has the best rich-editor compatibility (Quill, Slate, ProseMirror).
      var ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok) {
        if (sel.rangeCount) {
          var r = sel.getRangeAt(0);
          r.deleteContents();
          r.insertNode(document.createTextNode(text));
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
        } else {
          el.appendChild(document.createTextNode(text));
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    },

    _insert: function (text) {
      var el = this.target;
      try {
        if (el && document.contains(el) && isEditable(el)) {
          el.focus();
          if (el.isContentEditable) this._insertContentEditable(el, text);
          else this._insertField(el, text);
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          // No target field — fall back to the clipboard so the words aren't lost.
          navigator.clipboard.writeText(text);
          this._setState('error', 'No text field focused — copied to clipboard');
          if (typeof this.opts.onTranscript === 'function') this.opts.onTranscript(text);
          return;
        }
        this._setState('idle');
        if (typeof this.opts.onTranscript === 'function') this.opts.onTranscript(text);
      } catch (err) {
        this._fail(err.message);
      }
    },

    _fail: function (message) {
      this._setState('error', message);
      if (typeof this.opts.onError === 'function') this.opts.onError(new Error(message));
    }
  };

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var instance = null;

  var api = {
    version: VERSION,

    init: function (options) {
      if (instance) instance.destroy();
      instance = new MockingbirdInstance(options);
      return api;
    },

    /** Register voice actions and the handler that receives matched commands. */
    registerActions: function (actions, handler) {
      if (!instance) api.init({});
      instance.opts.actions = (instance.opts.actions || []).concat(actions || []);
      if (handler) instance.opts.onAction = handler;
      return api;
    },

    /** Teach Mockingbird a word: agent names, neighborhoods, jargon. */
    learn: function (word) {
      word = String(word || '').trim();
      if (!word) return api;
      var words = loadStoredDictionary();
      if (!words.some(function (w) { return w.toLowerCase() === word.toLowerCase(); })) {
        words.push(word);
        saveStoredDictionary(words);
      }
      return api;
    },

    forget: function (word) {
      var words = loadStoredDictionary().filter(function (w) {
        return w.toLowerCase() !== String(word || '').trim().toLowerCase();
      });
      saveStoredDictionary(words);
      return api;
    },

    get dictionary() {
      return instance ? instance._dictionary() : loadStoredDictionary();
    },

    /** Run text through the full pipeline as if it had been spoken (testing/demos). */
    simulate: function (text) {
      if (!instance) api.init({});
      instance._finish(text);
      return api;
    },

    start: function () { if (instance) instance.toggle(); return api; },
    stop: function () { if (instance) instance.stop(); return api; },
    cancel: function () { if (instance) instance.cancel(); return api; },
    destroy: function () { if (instance) { instance.destroy(); instance = null; } return api; },
    get state() { return instance ? instance.state : 'uninitialized'; },

    _autoInit: function () {
      if (instance) return;
      var script = document.currentScript ||
        document.querySelector('script[src*="mockingbird"]') ||
        document.querySelector('script[src*="speakit"]');
      var opts = {};
      if (script) {
        var d = script.dataset;
        if (d.formatEndpoint) opts.formatEndpoint = d.formatEndpoint;
        if (d.transcribeEndpoint) opts.transcribeEndpoint = d.transcribeEndpoint;
        if (d.actionsEndpoint) opts.actionsEndpoint = d.actionsEndpoint;
        if (d.hotkey) opts.hotkey = d.hotkey;
        if (d.lang) opts.lang = d.lang;
        if (d.engine) opts.engine = d.engine;
        if (d.tone) opts.tone = d.tone;
        if (d.position) opts.position = d.position;
        if (d.appContext) opts.appContext = d.appContext;
        if (d.userId) opts.userId = d.userId;
        if (d.liveInsert === 'false') opts.liveInsert = false;
        if (d.button === 'false') opts.button = false;
        if (d.manual === 'true') return; // opt out of auto-init
      }
      api.init(opts);
    }
  };

  return api;
});
