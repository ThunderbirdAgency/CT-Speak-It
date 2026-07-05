# CT Speak-It 🎙️

**Drop-in voice dictation for every build you ship.** Hold a hotkey, speak, release — clean, AI-polished text lands exactly where your cursor is. It works like Wispr Flow, but as a tool you embed in your own web apps: one script tag and *every* input, textarea, and rich-text editor on the page gets dictation.

## How it works

```
 hold Ctrl+Space ──▶ 🎤 listen ──▶ transcribe ──▶ ✨ AI cleanup ──▶ insert at cursor
                     (Web Speech API           (Claude removes filler words,
                      or your own               fixes punctuation, applies
                      Whisper endpoint)         "period" / "new line" commands)
```

- **Push-to-talk:** hold `Ctrl+Space` (configurable), speak, release. Or click the floating mic to toggle. `Esc` cancels.
- **Inserts at the cursor** in whatever field was focused — inputs, textareas, and `contenteditable` rich editors. Dispatches native input events, so React / Vue / Svelte state stays in sync.
- **AI "Flow formatting" (optional):** point it at the included Claude-powered endpoint and raw speech like *"um send the invoice tuesday no wait wednesday period"* becomes *"Send the invoice Wednesday."*
- **Zero dependencies, no build step.** One file, ~9 KB. Ships in a Shadow DOM so it can't clash with your app's CSS.
- **Graceful degradation:** if the formatter is down you get the raw transcript; if no field is focused the text is copied to your clipboard.

## Quick start (any app, one line)

```html
<script src="https://your-cdn-or-app.com/speakit.js"></script>
```

That's it — the mic button appears bottom-right and `Ctrl+Space` works everywhere on the page.

### With AI cleanup

Deploy this repo to Vercel once (it includes `api/format.js`), set `ANTHROPIC_API_KEY` in the project's environment variables, then in every build:

```html
<script src="https://ct-speak-it.vercel.app/src/speakit.js"
        data-format-endpoint="https://ct-speak-it.vercel.app/api/format"></script>
```

One deployment serves all of your apps (CORS is open by default; restrict it with the `ALLOWED_ORIGINS` env var).

## Configuration

Via data attributes on the script tag, or `SpeakIt.init({...})`:

| Option | Attribute | Default | Description |
|---|---|---|---|
| `hotkey` | `data-hotkey` | `Ctrl+Space` | Hold-to-talk combo, e.g. `Alt+D`, `Ctrl+Shift+M` |
| `formatEndpoint` | `data-format-endpoint` | — | URL of the AI cleanup endpoint (`api/format.js`) |
| `transcribeEndpoint` | `data-transcribe-endpoint` | — | Server transcription (Whisper/Deepgram proxy); enables Firefox support |
| `engine` | `data-engine` | `auto` | `browser` (Web Speech API), `server`, or `auto` |
| `lang` | `data-lang` | `en-US` | Recognition language |
| `tone` | `data-tone` | `clean` | Cleanup style: `clean`, `formal`, `casual`, `code-comment` |
| `position` | `data-position` | `bottom-right` | Mic button corner |
| `button` | `data-button="false"` | `true` | Hide the floating button (hotkey-only mode) |
| — | `data-manual="true"` | — | Skip auto-init; call `SpeakIt.init()` yourself |

### JavaScript API

```js
SpeakIt.init({
  hotkey: 'Ctrl+Space',
  formatEndpoint: '/api/format',
  tone: 'formal',
  appContext: 'customer support reply',   // extra context for the AI cleanup
  onTranscript: (text) => console.log('inserted:', text),
  onStateChange: (state) => {},           // idle | listening | polishing | error
  onError: (err) => {}
});

SpeakIt.start();    // toggle dictation programmatically
SpeakIt.stop();
SpeakIt.cancel();
SpeakIt.state;      // current state
```

Also usable as a module: `const SpeakIt = require('ct-speak-it')` / bundle `src/speakit.js`.

## Try the demo

```bash
npx serve .
# open http://localhost:3000/demo/
```

Speech recognition requires **HTTPS or localhost** and works out of the box in Chrome, Edge, and Safari. For Firefox (no Web Speech API), set `transcribeEndpoint` to a Whisper-style server.

## Repo layout

```
src/speakit.js    the widget — copy or CDN this into any build
api/format.js     Claude-powered transcript cleanup (Vercel serverless function)
demo/index.html   playground
```

## Notes & limits

- The browser engine uses the platform's speech recognition (Google's on Chrome), which streams audio to that vendor — same as any dictation feature. Use `engine: 'server'` with your own endpoint if you need full control of the audio path.
- Browsers only expose the microphone to the page itself, so the widget covers everything **inside your apps**. System-wide dictation across native apps (the full desktop Wispr Flow experience) would need a desktop wrapper — the natural next step if you want it.
