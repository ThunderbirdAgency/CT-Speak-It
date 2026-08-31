# Mockingbird 🐦

**Talk instead of type — anywhere on your machine — and tell your systems what
to do.**

```
Ctrl/Cmd+Shift+Space ─▶ 🎤 speak ─▶ polished text lands where your cursor is
                                     (email, Word, Slack, any CRM field, anything)

Ctrl/Cmd+Shift+K ─────▶ 🎤 speak ─▶ "Create person · Maria Lopez · Follow Up Boss"
                                     ⏎ ─▶ done. In the real system.
```

Dictation apps stop at typing. Mockingbird also *acts*: describe what you want
and it creates the contact, logs the call, books the showing, sets the
follow-up — in Follow Up Boss, in our own builds, in anything with an API.
Nothing is written until you see what it's about to do and press Enter.

It ships two ways, on one deployment:

- **Desktop app** (Mac/Windows) — works in every application on the machine.
- **Web widget** — one script tag gives any of our builds dictation *and*
  in-app voice actions.

New here? **[docs/INSTALL.md](docs/INSTALL.md)** — 20 minutes to set up, three
steps for the people who use it.

## What it's like to use

You've just wrapped an open house. Three buyers came through and there's a
follow-up forming in your head. You hold a key and talk:

> "Just wrapped the open house at 123 Main — three people came through: John
> Doe 555-0142, Maria Lopez, maria at gmail dot com, and Sam Chen. Follow up
> with all of them Monday."

Three contacts, the open house, and Monday's tasks — one Enter, before you're
out of the driveway. Say "um" and it disappears. Correct yourself mid-sentence
— "2 o'clock, no wait, 3" — and only the 3 survives. Spell an email out loud
and it assembles it. It learns your neighbourhoods and your clients' names, and
it gets better every week you use it.

## How it fits together

```
                     ┌──────────────────┐
  desktop app  ──┐   │  /api/transcribe │  Whisper-grade speech-to-text
  web widget   ──┼──▶│  /api/format     │  Claude polish, in your voice
  any client   ──┘   │  /api/actions    │  command or dictation? which fields?
                     │  /api/act        │  the only thing that writes anywhere
                     │  /api/profile    │  what it has learned about you
                     └────────┬─────────┘
                              ▼
              Follow Up Boss · your products · your app's own handler
```

`/api/actions` decides, the client shows the card, `/api/act` executes. That
split is the safety model: an agent should never discover that a sentence they
half-said created something in their CRM.

## Setup at a glance

Deploy this repo (Vercel), set two keys, and you're running:

| Env var | Enables |
|---|---|
| `ANTHROPIC_API_KEY` | polish + command understanding — **required** |
| `GROQ_API_KEY` *(or `DEEPGRAM_API_KEY` / `OPENAI_API_KEY`)* | Whisper-grade transcription — **required** |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | event log + the voice profile ([LEARNING.md](docs/LEARNING.md)) |
| `ALLOWED_ORIGINS` | CORS allowlist for the web widget |
| `FOLLOWUPBOSS_API_KEY` | team-wide Follow Up Boss, no keys on laptops |
| `CONNECTOR_ALLOWED_HOSTS` | restrict custom connectors to hosts you name |

Full walkthrough: **[docs/INSTALL.md](docs/INSTALL.md)**.

## Desktop app

```bash
cd desktop && npm install && npm start     # development
cd desktop && npm run dist:mac             # → dist/Mockingbird-1.0.0.dmg
```

Menu bar / system tray, launches at login, two shortcuts, a settings window
with connectors, history, and everything it has learned. Details:
[desktop/README.md](desktop/README.md).

## Web widget

**Dictation only, zero backend:**

```html
<script src="https://your-deployment/src/mockingbird.js"></script>
```

**Everything, one deployment for all your builds:**

```html
<script src="https://your-deployment/src/mockingbird.js"
        data-transcribe-endpoint="https://your-deployment/api/transcribe"
        data-format-endpoint="https://your-deployment/api/format"
        data-actions-endpoint="https://your-deployment/api/actions"
        data-act-endpoint="https://your-deployment/api/act"
        data-connectors="followupboss"></script>
```

Adding it to an app: tell Claude **"add the mockingbird — follow
docs/ADD-MOCKINGBIRD.md in the CT-Speak-It repo"**, or do it by hand from that
file.

### In-app voice actions

Describe what your app can do and hand over a handler. Your actions go straight
to you — you own the UI and the undo — while connector actions are the ones
Mockingbird runs itself:

```js
Mockingbird.registerActions([
  {
    name: 'create_open_house',
    description: 'Schedule an open house. Trigger on "open house", "showing".',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        date:    { type: 'string', description: 'ISO date' },
        time:    { type: 'string', description: 'HH:MM 24h' }
      },
      required: ['address']
    }
  }
], (name, input) => {
  api.createOpenHouse(input);   // your backend
  dashboard.popCard(input);     // your UI
});

Mockingbird.connect('followupboss');   // a name, never a key — pages are public
```

One utterance can produce several actions — "three people came through: John…,
Maria…, Sam…" fires your handler three times. Anything that isn't a command
falls through to ordinary polished dictation, so nobody has to think about
modes.

## Connectors

Follow Up Boss out of the box: contacts, notes, tasks, calls, appointments,
stage changes, lookups. Your own products by describing their endpoints once —
no code. **[docs/CONNECTORS.md](docs/CONNECTORS.md)**.

## What it learns

Mockingbird reads back a person's own dictations to write the way they write
and spell their people's names right. That profile is visible to them in the
app, erasable in one click, and switch-off-able entirely. What's kept, what
isn't, and how to be straight with your team about it:
**[docs/LEARNING.md](docs/LEARNING.md)**.

## Dictation quality

- **Whisper-grade:** `whisper-large-v3-turbo` (Groq), `nova-3` (Deepgram), or
  `whisper-1` (OpenAI) — whichever key is set. Without one, the browser's own
  recognizer is used in web apps.
- **Feels instant:** with `liveInsert`, raw words appear the moment you finish
  and are swapped for the polished version a beat later. Kept typing? The swap
  is skipped — your edits win.
- **Personal dictionary:** `Mockingbird.learn('Poinciana')`, or the words field
  in desktop Settings.
- **Never loses words:** formatter down → raw transcript. Router down → plain
  dictation. No field focused → clipboard. Every failure still ends with your
  words somewhere.

## Configuration

Data attributes on the script tag, or `Mockingbird.init({...})`:

| Option | Attribute | Default | Description |
|---|---|---|---|
| `hotkey` | `data-hotkey` | `Ctrl+Space` | Hold-to-talk combo |
| `transcribeEndpoint` | `data-transcribe-endpoint` | — | Whisper-grade transcription |
| `formatEndpoint` | `data-format-endpoint` | — | Claude cleanup |
| `actionsEndpoint` | `data-actions-endpoint` | — | Command vs dictation routing |
| `actEndpoint` | `data-act-endpoint` | — | Executes connector actions |
| `connectors` | `data-connectors` | `[]` | e.g. `followupboss` (names, never keys) |
| `confirmActions` | `data-confirm-actions="false"` | `true` | Ask before touching a real system |
| `learn` | `data-learn="false"` | `true` | Contribute to the voice profile |
| `tone` | `data-tone` | `clean` | `clean` \| `formal` \| `casual` \| `code-comment` |
| `appContext` | `data-app-context` | page title | Tells the AI what it's typing into |
| `userId` | `data-user-id` | — | Who's speaking (log + profile) |
| `lang` | `data-lang` | `en-US` | Recognition language |
| `dictionary` | — | `[]` | Custom vocabulary |
| `liveInsert` | `data-live-insert="false"` | `true` | Instant raw insert, swap in polish |
| `position` | `data-position` | `bottom-right` | Mic button corner |
| `button` | `data-button="false"` | `true` | Hide the floating button |
| — | `data-manual="true"` | — | Skip auto-init |

### JavaScript API

```js
Mockingbird.init(options)
Mockingbird.registerActions(actions, handler)   // this app's own actions
Mockingbird.connect('followupboss')             // systems Mockingbird acts on
Mockingbird.learn('Poinciana') / forget(word) / dictionary
Mockingbird.simulate('open house at 123 ...')   // run text through the pipeline, no mic
Mockingbird.start() / stop() / cancel() / destroy()
Mockingbird.state                               // idle | listening | polishing | confirm | done | error
```

Callbacks: `onAction(name, input)`, `onTranscript(text)`, `onStateChange(state)`,
`onError(err)`.

## Demos and tests

```bash
npx serve .
# /demo/          dictation into inputs, textareas, rich text
# /demo/crm.html  voice actions: speak, cards pop out

npm test          # connectors + desktop main process + widget in a real browser
```

Mic access needs HTTPS or localhost. For the APIs locally, `vercel dev`.

## Repo layout

```
src/mockingbird.js              the widget — embed in any build
api/transcribe.js               speech → text (Groq/Deepgram/OpenAI)
api/format.js                   transcript → polished text (Claude)
api/actions.js                  command or dictation? which fields?
api/act.js                      executes confirmed actions — the only writer
api/profile.js                  read / rebuild / erase a voice profile
api/tools.js                    what this deployment can connect to
api/_lib/connectors/            followupboss.js · custom.js · registry
api/_lib/profile.js             distills a person's profile from their events
db/schema.sql                   events, profiles, usage view
desktop/                        the Mac/Windows app
demo/                           dictation playground · CRM voice actions
test/                           server + browser tests
docs/INSTALL.md                 set it up, roll it out
docs/CONNECTORS.md              make it do things
docs/LEARNING.md                what it remembers, and the rules
docs/ADD-MOCKINGBIRD.md         paste-to-Claude integration instructions
```
