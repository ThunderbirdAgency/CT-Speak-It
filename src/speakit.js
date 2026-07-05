/*!
 * CT Speak-It — drop-in voice dictation for any web app.
 *
 * Works like Wispr Flow, for the web: hold a hotkey (or tap the floating mic),
 * speak, release — and clean, formatted text is inserted wherever your cursor is.
 *
 * Usage (zero config):
 *   <script src="speakit.js"></script>
 *
 * Usage (configured):
 *   <script src="speakit.js" data-format-endpoint="/api/format" data-lang="en-US"></script>
 *
 * Or programmatically:
 *   SpeakIt.init({ formatEndpoint: '/api/format', hotkey: 'Ctrl+Space' });
 */
(function (global, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    global.SpeakIt = factory();
    // Auto-init when loaded via <script> tag.
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

  var VERSION = '1.0.0';

  var DEFAULTS = {
    // Hold-to-talk hotkey. String form: "Ctrl+Space", "Alt+D", "Ctrl+Shift+M"...
    hotkey: 'Ctrl+Space',
    // 'browser' = Web Speech API (free, Chrome/Edge/Safari).
    // 'server'  = record audio, POST to transcribeEndpoint (e.g. Whisper/Deepgram proxy).
    // 'auto'    = browser if available, otherwise server (if endpoint given).
    engine: 'auto',
    lang: 'en-US',
    // Optional AI cleanup endpoint: POST {text, tone, appContext} -> {text}.
    // See api/format.js for a ready-made Claude-powered implementation.
    formatEndpoint: null,
    // Server transcription endpoint: POST audio/webm body -> {text}.
    transcribeEndpoint: null,
    // Writing style passed to the formatter: 'clean' | 'formal' | 'casual' | 'code-comment'
    tone: 'clean',
    // Extra context string sent to the formatter (e.g. "support ticket reply").
    appContext: '',
    // Show the floating mic button.
    button: true,
    position: 'bottom-right', // bottom-right | bottom-left | top-right | top-left
    zIndex: 2147483000,
    // Insert raw transcript immediately and replace with polished text when ready.
    liveInsert: false,
    // Callbacks
    onTranscript: null,   // (finalText) => void — fired after insertion
    onError: null,        // (err) => void
    onStateChange: null   // (state) => void — idle|listening|polishing|error
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

  function needsLeadingSpace(before, text) {
    if (!before || !text) return false;
    return !/\s$/.test(before) && !/^[\s.,!?;:)\]}]/.test(text);
  }

  // ---------------------------------------------------------------------------
  // Text insertion (inputs, textareas, contenteditable / rich editors)
  // ---------------------------------------------------------------------------

  function insertIntoField(el, text, range) {
    var start = range ? range.start : (el.selectionStart != null ? el.selectionStart : el.value.length);
    var end = range ? range.end : (el.selectionEnd != null ? el.selectionEnd : el.value.length);
    var before = el.value.slice(0, start);
    if (needsLeadingSpace(before, text)) text = ' ' + text;
    var next = before + text + el.value.slice(end);
    setNativeValue(el, next);
    var caret = start + text.length;
    try { el.setSelectionRange(caret, caret); } catch (e) { /* number inputs etc. */ }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { start: start, end: caret };
  }

  function insertIntoContentEditable(el, text, savedRange) {
    el.focus();
    var sel = window.getSelection();
    if (savedRange) {
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    var before = sel.anchorNode && sel.anchorNode.textContent
      ? sel.anchorNode.textContent.slice(0, sel.anchorOffset) : '';
    if (needsLeadingSpace(before, text)) text = ' ' + text;
    // execCommand still has the best editor compatibility (Slate, Quill, ProseMirror all listen).
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
    this.interimTranscript = '';
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
      // Capture the currently focused element at load time too.
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
        '.si-wrap.error .si-btn{background:#8d6e00}' +
        '@keyframes si-pulse{0%{box-shadow:0 0 0 0 rgba(198,40,40,.45)}70%{box-shadow:0 0 0 16px rgba(198,40,40,0)}100%{box-shadow:0 0 0 0 rgba(198,40,40,0)}}' +
        '.si-pill{max-width:320px;background:#101418;color:#e8ecf1;border-radius:14px;padding:9px 14px;' +
        'box-shadow:0 4px 18px rgba(0,0,0,.35),inset 0 0 0 1px rgba(255,255,255,.08);display:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.si-wrap.listening .si-pill,.si-wrap.polishing .si-pill,.si-wrap.error .si-pill{display:block}' +
        '.si-pill .si-hint{opacity:.55;font-weight:400}' +
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
      if (ui) {
        ui.wrap.className = 'si-wrap' + (state !== 'idle' ? ' ' + state : '');
        if (state === 'listening') {
          ui.pill.innerHTML = '<span class="si-bars"><i></i><i></i><i></i><i></i></span>' +
            '<span class="si-text si-hint">Listening… release ' + this.opts.hotkey + ' or click mic to finish</span>';
        } else if (state === 'polishing') {
          ui.pill.innerHTML = '<span class="si-text si-hint">✨ Polishing…</span>';
        } else if (state === 'error') {
          ui.pill.textContent = '⚠ ' + (message || 'Something went wrong');
          var self = this;
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
      this.interimTranscript = '';
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
      if (SR) return 'browser';
      return this.opts.transcribeEndpoint ? 'server' : null;
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
        self.interimTranscript = interim;
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
        var mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        self.chunks = [];
        mr.ondataavailable = function (e) { if (e.data.size) self.chunks.push(e.data); };
        mr.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          if (self._cancelled) return;
          var blob = new Blob(self.chunks, { type: 'audio/webm' });
          self._setState('polishing');
          fetch(self.opts.transcribeEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'audio/webm', 'X-SpeakIt-Lang': self.opts.lang },
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

    // ------------------------------------------------------ finish & insert

    _finish: function (raw) {
      var self = this;
      if (!raw) { this._setState('idle'); return; }
      if (this.opts.formatEndpoint) {
        this._setState('polishing');
        fetch(this.opts.formatEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: raw,
            tone: this.opts.tone,
            appContext: this.opts.appContext || document.title
          })
        })
          .then(function (r) { if (!r.ok) throw new Error('format ' + r.status); return r.json(); })
          .then(function (data) { self._insert((data.text || raw).trim()); })
          .catch(function () { self._insert(raw); }); // graceful degradation: raw transcript
      } else {
        this._insert(raw);
      }
    },

    _insert: function (text) {
      var el = this.target;
      try {
        if (el && document.contains(el) && isEditable(el)) {
          el.focus();
          if (el.isContentEditable) insertIntoContentEditable(el, text, this.savedRange);
          else insertIntoField(el, text, this.savedRange);
          this._captureTarget(el);
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
        if (d.hotkey) opts.hotkey = d.hotkey;
        if (d.lang) opts.lang = d.lang;
        if (d.engine) opts.engine = d.engine;
        if (d.tone) opts.tone = d.tone;
        if (d.position) opts.position = d.position;
        if (d.button === 'false') opts.button = false;
        if (d.manual === 'true') return; // opt out of auto-init
      }
      api.init(opts);
    }
  };

  return api;
});
