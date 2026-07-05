# CT Speak-It 🎙️

**Voice for every build you ship.** One script tag gives any web app two superpowers:

1. **Dictation** — hold a hotkey, speak, release: clean, AI-polished text lands exactly where your cursor is.
2. **Voice actions** — register your app's actions and spoken commands become structured objects: say *"open house at 123 Main Street this Saturday at 2pm"* and `{name: "create_open_house", input: {address: "123 Main Street", date: "2026-07-11", time: "14:00"}}` is delivered to your handler — the card pops onto the dashboard.

```
 hold Ctrl+Space ─▶ 🎤 speak ─▶ Whisper-grade transcription ─▶ Claude decides:
                                                               ├─ command?  → structured action → your handler
                                                               └─ dictation → polished text → your cursor
```

## Quick start

**Dictation only (zero backend):**

```html
<script src="https://your-deployment/src/speakit.js"></script>
```

**Full stack (one deployment serves ALL your products):** deploy this repo to Vercel, set the env vars below, then in every build:

```html
<script src="https://ct-speak-it.vercel.app/src/speakit.js"
        data-transcribe-endpoint="https://ct-speak-it.vercel.app/api/transcribe"
        data-format-endpoint="https://ct-speak-it.vercel.app/api/format"
        data-actions-endpoint="https://ct-speak-it.vercel.app/api/actions"></script>
```

| Env var | Enables | Required |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI cleanup + voice actions (Claude) | for `/api/format` and `/api/actions` |
| `GROQ_API_KEY` *(or `DEEPGRAM_API_KEY` / `OPENAI_API_KEY`)* | Whisper-grade transcription | for `/api/transcribe` |
| `ALLOWED_ORIGINS` | CORS allowlist, e.g. `https://crm.you.com,https://apu.you.com` | optional (default `*`) |

## Voice actions — the CRM/dashboard feature

In your app's JS, describe the things a user can create and hand over a handler:

```js
SpeakIt.registerActions([
  {
    name: 'create_open_house',
    description: 'Schedule an open house for a property',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        date:    { type: 'string', description: 'ISO date' },
        time:    { type: 'string', description: 'HH:MM 24h' },
        host:    { type: 'string' },
        notes:   { type: 'string' }
      },
      required: ['address']
    }
  }
], (name, input) => {
  // name === 'create_open_house', input is schema-shaped and date-resolved
  api.createOpenHouse(input);      // your backend
  dashboard.popCard(input);        // your UI
});
```

Claude receives your schemas as tools, resolves relative dates ("this Saturday" → real ISO date), applies self-corrections ("2pm no wait 3" → `15:00`), and puts stray remarks into `notes`. Anything that *isn't* a command falls through to normal polished dictation — users never have to think about modes.

## Dictation quality

- **Whisper-grade accuracy:** set `transcribeEndpoint` and audio is transcribed by `whisper-large-v3-turbo` (Groq), `nova-3` (Deepgram), or `whisper-1` (OpenAI) — whichever key you configure. Without it, the browser's built-in recognizer is used (Chrome/Edge/Safari).
- **Feels instant:** with `liveInsert` (default on), your raw words appear the moment you release the key, then get seamlessly swapped for the Claude-polished version. If you kept typing meanwhile, the swap is skipped — your edits win.
- **Personal dictionary:** `SpeakIt.learn('Poinciana')` teaches it your agents' names, neighborhoods, and jargon (persisted in localStorage, merged with the `dictionary` option, and fed to the AI to fix mishearings).
- **Never loses words:** formatter down → raw transcript inserted; no field focused → text goes to the clipboard.

## Configuration

Data attributes on the script tag, or `SpeakIt.init({...})`:

| Option | Attribute | Default | Description |
|---|---|---|---|
| `hotkey` | `data-hotkey` | `Ctrl+Space` | Hold-to-talk combo (`Alt+D`, `Ctrl+Shift+M`, …) |
| `transcribeEndpoint` | `data-transcribe-endpoint` | — | Whisper-grade transcription (`api/transcribe.js`) |
| `formatEndpoint` | `data-format-endpoint` | — | AI cleanup (`api/format.js`) |
| `actionsEndpoint` | `data-actions-endpoint` | — | Voice actions (`api/actions.js`) |
| `engine` | `data-engine` | `auto` | `auto` prefers the server engine when configured |
| `lang` | `data-lang` | `en-US` | Recognition language |
| `tone` | `data-tone` | `clean` | `clean` \| `formal` \| `casual` \| `code-comment` |
| `appContext` | `data-app-context` | page title | Tells the AI what app it's typing into |
| `dictionary` | — | `[]` | Custom vocabulary (merged with learned words) |
| `liveInsert` | `data-live-insert="false"` | `true` | Instant raw insert, swap in polish when ready |
| `position` | `data-position` | `bottom-right` | Mic button corner |
| `button` | `data-button="false"` | `true` | Hide the floating button (hotkey-only) |
| — | `data-manual="true"` | — | Skip auto-init; call `SpeakIt.init()` yourself |

### JavaScript API

```js
SpeakIt.init(options)                       // (re)initialize
SpeakIt.registerActions(actions, handler)   // voice commands for this app
SpeakIt.learn('Poinciana')                  // teach a word (persisted)
SpeakIt.forget('Poinciana')
SpeakIt.dictionary                          // merged vocabulary
SpeakIt.simulate('open house at 123 ...')   // run text through the full pipeline (testing/demo)
SpeakIt.start() / stop() / cancel() / destroy()
SpeakIt.state                               // idle | listening | polishing | done | error
```

Callbacks: `onAction(name, input)`, `onTranscript(text)`, `onStateChange(state)`, `onError(err)`.

## Demos

```bash
npx serve .
# http://localhost:3000/demo/        — dictation into inputs/textareas/rich text
# http://localhost:3000/demo/crm.html — CRM voice actions: speak, cards pop out
```

The CRM demo includes an offline mock parser so cards pop even before the API is deployed; deploy `/api/actions` for the real Claude-powered extraction. Mic access requires HTTPS or localhost. For end-to-end local testing with the APIs, use `vercel dev`.

## Repo layout

```
src/speakit.js      the widget — embed in any build
api/transcribe.js   Whisper-grade transcription proxy (Groq/Deepgram/OpenAI)
api/actions.js      voice → structured actions (Claude)
api/format.js       transcript cleanup (Claude)
demo/index.html     dictation playground
demo/crm.html       CRM voice-actions demo
```

## Notes

- Everything degrades gracefully: actions endpoint down → polished dictation; formatter down → raw transcript; no mic permission → clear error state.
- This covers everything inside your web apps. System-wide dictation into native apps (desktop Wispr Flow's turf) would be a small desktop wrapper (Tauri/Electron global hotkey) reusing these same endpoints — ask if you want it.
