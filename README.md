# Mockingbird 🐦

**Thunderbird's voice layer — one deployment, voice in every build.** One script tag gives any web app two superpowers:

1. **Dictation** — hold a hotkey, speak, release: clean, AI-polished text lands exactly where your cursor is.
2. **Voice actions** — register your app's actions and spoken commands become structured objects: say *"open house at 123 Main Street this Saturday at 2pm"* and `{name: "create_open_house", input: {address: "123 Main Street", date: "2026-07-11", time: "14:00"}}` is delivered to your handler — the card pops onto the dashboard.

```
 hold Ctrl+Space ─▶ 🎤 speak ─▶ Whisper-grade transcription ─▶ Claude decides:
                                                               ├─ command?  → structured action → your handler
                                                               └─ dictation → polished text → your cursor
```

## Adding it to an app

Tell Claude: **"add the mockingbird — follow docs/ADD-MOCKINGBIRD.md in the CT-Speak-It repo"** and it will wire the script tag, actions, and handler into any project. Manual steps below.

## Quick start

**Dictation only (zero backend):**

```html
<script src="https://your-deployment/src/mockingbird.js"></script>
```

**Full stack (one deployment serves ALL your products):** deploy this repo to Vercel, set the env vars below, then in every build:

```html
<script src="https://mockingbird-thunderbird.vercel.app/src/mockingbird.js"
        data-transcribe-endpoint="https://mockingbird-thunderbird.vercel.app/api/transcribe"
        data-format-endpoint="https://mockingbird-thunderbird.vercel.app/api/format"
        data-actions-endpoint="https://mockingbird-thunderbird.vercel.app/api/actions"></script>
```

| Env var | Enables | Required |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI cleanup + voice actions (Claude) | for `/api/format` and `/api/actions` |
| `GROQ_API_KEY` *(or `DEEPGRAM_API_KEY` / `OPENAI_API_KEY`)* | Whisper-grade transcription | for `/api/transcribe` |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Event log: every dictation & action recorded to `mockingbird_events` (see `db/schema.sql`) | optional |
| `ALLOWED_ORIGINS` | CORS allowlist, e.g. `https://crm.you.com,https://apu.you.com` | optional (default `*`) |

## Voice actions — the CRM/dashboard feature

In your app's JS, describe the things a user can create and hand over a handler:

```js
Mockingbird.registerActions([
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

Claude receives your schemas as tools, resolves relative dates ("this Saturday" → real ISO date), applies self-corrections ("2pm no wait 3" → `15:00`), assembles spoken emails ("maria at gmail dot com"), and puts stray remarks into `notes`. **One utterance can produce several actions** — "three people came through: John…, Maria…, Sam…" fires your handler three times with three contacts. Anything that *isn't* a command falls through to normal polished dictation — users never have to think about modes.

## Dictation quality

- **Whisper-grade accuracy:** set `transcribeEndpoint` and audio is transcribed by `whisper-large-v3-turbo` (Groq), `nova-3` (Deepgram), or `whisper-1` (OpenAI) — whichever key you configure. Without it, the browser's built-in recognizer is used (Chrome/Edge/Safari).
- **Feels instant:** with `liveInsert` (default on), your raw words appear the moment you release the key, then get seamlessly swapped for the Claude-polished version. If you kept typing meanwhile, the swap is skipped — your edits win.
- **Personal dictionary:** `Mockingbird.learn('Poinciana')` teaches it your agents' names, neighborhoods, and jargon (persisted in localStorage, merged with the `dictionary` option, and fed to the AI to fix mishearings).
- **Never loses words:** formatter down → raw transcript inserted; no field focused → text goes to the clipboard.

## Configuration

Data attributes on the script tag, or `Mockingbird.init({...})`:

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
| — | `data-manual="true"` | — | Skip auto-init; call `Mockingbird.init()` yourself |

### JavaScript API

```js
Mockingbird.init(options)                       // (re)initialize
Mockingbird.registerActions(actions, handler)   // voice commands for this app
Mockingbird.learn('Poinciana')                  // teach a word (persisted)
Mockingbird.forget('Poinciana')
Mockingbird.dictionary                          // merged vocabulary
Mockingbird.simulate('open house at 123 ...')   // run text through the full pipeline (testing/demo)
Mockingbird.start() / stop() / cancel() / destroy()
Mockingbird.state                               // idle | listening | polishing | done | error
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
src/mockingbird.js      the widget — embed in any build
api/transcribe.js   Whisper-grade transcription proxy (Groq/Deepgram/OpenAI)
api/actions.js      voice → structured actions (Claude)
api/format.js       transcript cleanup (Claude)
api/_lib/log.js     optional Supabase event logging
db/schema.sql       mockingbird_events table (run once in Supabase)
docs/ADD-MOCKINGBIRD.md  paste-to-Claude integration instructions
demo/index.html     dictation playground
demo/crm.html       CRM voice-actions demo
```

## Data & analytics

Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` on the deployment (and run `db/schema.sql` once) and every dictation and voice action across all apps is logged to `mockingbird_events`: who spoke (`userId`), in which app, the raw transcript, the polished output or matched actions, and processing time. Browsers never touch the table directly — only the API endpoints write, with the service key. Raw audio is deliberately not stored (transcripts give you the analytics without the storage/privacy weight); flip that later by adding a storage upload in `api/transcribe.js` if you ever need voice recordings.

Things you can build on this table for free: per-agent usage dashboards, a "recently dictated" activity feed, mishearing analysis to auto-grow the dictionary, and an audit trail for every voice-created CRM record.

## Notes

- Everything degrades gracefully: actions endpoint down → polished dictation; formatter down → raw transcript; no mic permission → clear error state.
- This covers everything inside your web apps. System-wide dictation into native apps (desktop Wispr Flow's turf) would be a small desktop wrapper (Tauri/Electron global hotkey) reusing these same endpoints — ask if you want it.
