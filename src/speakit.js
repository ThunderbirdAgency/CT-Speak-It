/*!
 * CT Speak-It v2 — drop-in voice dictation + voice actions for any web app.
 *
 * Dictation: hold a hotkey (or tap the floating mic), speak, release — clean,
 * AI-polished text is inserted wherever your cursor is.
 *
 * Voice actions: register your app's actions (create_open_house, add_task, ...)
 * and spoken commands become structured objects delivered to your handler.
 *
 * Usage (zero config):
 *   <script src="speakit.js"></script>
 *
 * Usage (configured):
 *   <script src="speakit.js"
 *           data-format-endpoint="/api/format"
 *           data-transcribe-endpoint="/api/transcribe"
 *           data-actions-endpoint="/api/actions"></script>
 *
 * Voice actions (in your app code):
 *   SpeakIt.registerActions([
 *     { name: 'create_open_house',
 *       description: 'Schedule an open house for a property',
 *       input_schema: { type: 'object', properties: {
 *         address: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' }
 *       }, required: ['address'] } }
 *   ], (name, input) => addCardToDashboard(name, input));
 */
(function (global, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    global.SpeakIt = factory();
    if (typeof document !== 'undefined') {
      var boot = function () { global.SpeakIt._autoInit(); };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
      } else {
        boot();
      }
    }
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var VERSION = '2.0.0';
  var DICT_STORAGE_KEY = 'speakit.dictionary';

  var DEFAULTS = {
    // Hold-to-talk hotkey. String form: "Ctrl+Space", "Alt+D", "Ctrl+Shift+M"...
    hotkey: 'Ctrl+Space',
    // 'browser' = Web Speech API. 'server' = record audio -> transcribeEndpoint
    // (Whisper-grade; see api/transcribe.js). 'auto' = server if endpoint given,
    // else browser.
    engine: 'auto',
    lang: 'en-US',
    // AI cleanup endpoint: POST {text, tone, appContext, dictionary} -> {text}.
    formatEndpoint: null,
    // Server transcription endpoint: POST audio/webm body -> {text}.
    transcribeEndpoint: null,
    // Voice-actions endpoint: POST {text, actions, appContext, dictionary}
    //   -> {kind:'action', name, input} | {kind:'dictation', text}.
    actionsEndpoint: null,
    // Registered actions: [{name, description, input_schema}]. Usually set via
    // SpeakIt.registerActions(actions, handler).
    actions: [],
    onAction: null,        // (name, input) => void — a spoken command matched
    // Writing style for the formatter: 'clean' | 'formal' | 'casual' | 'code-comment'
    tone: 'clean',
    // Extra context sent to the AI (e.g. "real-estate CRM, open-house scheduling").
    appContext: '',
    // Personal dictionary: names, neighborhoods, jargon the recognizer gets wrong.
    // Merged with words learned via SpeakIt.learn(), persisted in localStorage.
    dictionary: [],
    // Insert the raw transcript instantly, then swap in the polished version
    // when the AI responds (inputs/textareas only — feels instant, like Wispr).
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
      var raw = localStorage.getItem(DICT_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function saveStoredDictionary(words) {
    try { localStorage.setItem(DICT_STORAGE_KEY, JSON.stringify(words)); } catch (e) { /* private mode */ }
  }

  // ---------------------------------------------------------------------------
  // The widget
  // ---------------------------------------------------------------------------

  function SpeakItInstance(options) {
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

  SpeakItInstance.prototype = {

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
      host.setAttribute('data-speakit', '');
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
        '.si-wrap{position:fixed;' + pos + 'z-index:' + this.opts.zIndex + ';display:flex;align-items:center;gap:10px;' +
        'font:500 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;flex-direction:row-reverse;}' +
        '.si-btn{width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
        'background:#101418;color:#e8ecf1;box-shadow:0 4px 18px rgba(0,0,0,.35),inset 0 0 0 1px rgba(255,255,255,.08);transition:transform .15s ease,background .2s ease;}' +
        '.si-btn:hover{transform:scale(1.06)}' +
        '.si-btn svg{width:22px;height:22px;display:block}' +
        '.si-wrap.listening .si-btn{background:#c62828;animation:si-pulse 1.4s ease infinite}' +
        '.si-wrap.polishing .si-btn{background:#7b5cd6}' +
        '.si-wrap.done .si-btn{background:#1d7a46}' +
        '.si-wrap.error .si-btn{background:#8d6e00}' +
        '@keyframes si-pulse{0%{box-shadow:0 0 0 0 rgba(198,40,40,.45)}70%{box-shadow:0 0 0 16px rgba(198,40,40,0)}100%{box-shadow:0 0 0 0 rgba(198,40,40,0)}}' +
        '.si-pill{max-width:340px;background:#101418;color:#e8ecf1;border-radius:14px;padding:9px 14px;' +
        'box-shadow:0 4px 18px rgba(0,0,0,.35),inset 0 0 0 1px rgba(255,255,255,.08);display:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.si-wrap.listening .si-pill,.si-wrap.polishing .si-pill,.si-wrap.done .si-pill,.si-wrap.error .si-pill{display:block}' +
        '.si-pill .si-hint{opacity:.55;font-weight:400}' +
        '.si-pill .si-ok{color:#7ee2a8}' +
        '.si-bars{display:inline-flex;gap:2px;align-items:flex-end;height:12px;margin-right:8px;vertical-align:-1px}' +
        '.si-bars i{width:3px;background:#ff8a80;border-radius:2px;animation:si-bar .9s ease-in-out infinite}' +
        '.si-bars i:nth-child(2){animation-delay:.15s}.si-bars i:nth-child(3){animation-delay:.3s}.si-bars i:nth-child(4){animation-delay:.45s}' +
        '@keyframes si-bar{0%,100%{height:4px}50%{height:12px}}';

      var wrap = document.createElement('div');
      wrap.className = 'si-wrap';

      var btn = document.createElement('button');
      btn.className = 'si-btn';
      btn.type = 'button';
      btn.title = 'Dictate (' + this.opts.hotkey + ' to hold-and-talk, Esc to cancel)';
      btn.setAttribute('aria-label', 'Start dictation');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>' +
        '<path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';
      if (!this.opts.button) btn.style.display = 'none';

      var pill = document.createElement('div');
      pill.className = 'si-pill';

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
      this.state = state;
      var ui = this.ui;
      var self = this;
      if (ui) {
        ui.wrap.className = 'si-wrap' + (state !== 'idle' ? ' ' + state : '');
        if (state === 'listening') {
          ui.pill.innerHTML = '<span class="si-bars"><i></i><i></i><i></i><i></i></span>' +
            '<span class="si-text si-hint">Listening… release ' + this.opts.hotkey + ' or click mic to finish</span>';
        } else if (state === 'polishing') {
          ui.pill.innerHTML = '<span class="si-text si-hint">✨ ' + (message || 'Polishing…') + '</span>';
        } else if (state === 'done') {
          ui.pill.innerHTML = '<span class="si-ok">✓ ' + (message || 'Done') + '</span>';
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
      var span = this.ui.pill.querySelector('.si-text');
      if (span && text) {
        span.className = 'si-text';
        span.textContent = text;
      }
    },

    // ------------------------------------------------------------ recording

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
            headers: { 'Content-Type': blob.type, 'X-SpeakIt-Lang': self.opts.lang },
            body: blob
          })
            .then(function (r) { if (!r.ok) throw new Error('Transcription failed (' + r.status + ')'); return r.json(); })
            .then(function (data) { self._finish((data.text || '').trim()); })
            .catch(function (err) { self._fail(err.message); });
        };
        self.mediaRecorder = mr;
        mr.start();
      }).catch(function () { self._fail('Microphone access denied'); });
    },

    // ------------------------------------------------------ finish pipeline

    // Entry point after transcription (also used by SpeakIt.simulate()).
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

    // Voice actions: ask the endpoint whether this is a command or dictation.
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
          dictionary: this._dictionary()
        })
      })
        .then(function (r) { if (!r.ok) throw new Error('actions ' + r.status); return r.json(); })
        .then(function (data) {
          if (data && data.kind === 'action' && data.name) {
            var label = data.label || data.name.replace(/_/g, ' ');
            if (typeof self.opts.onAction === 'function') self.opts.onAction(data.name, data.input || {});
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

    // AI cleanup. With liveInsert, raw words land instantly and get swapped
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
          dictionary: this._dictionary()
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
      instance = new SpeakItInstance(options);
      return api;
    },

    /** Register voice actions and the handler that receives matched commands. */
    registerActions: function (actions, handler) {
      if (!instance) api.init({});
      instance.opts.actions = (instance.opts.actions || []).concat(actions || []);
      if (handler) instance.opts.onAction = handler;
      return api;
    },

    /** Teach the recognizer/AI a word: agent names, neighborhoods, jargon. */
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
        if (d.liveInsert === 'false') opts.liveInsert = false;
        if (d.button === 'false') opts.button = false;
        if (d.manual === 'true') return; // opt out of auto-init
      }
      api.init(opts);
    }
  };

  return api;
});
