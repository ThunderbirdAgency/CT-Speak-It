# Add the Mockingbird 🐦

> **Instructions for an AI coding agent (Claude Code etc.).** When the user says
> "add the mockingbird" in any project, follow this file top to bottom. A human
> can follow it too — it's ~10 minutes of work.

Mockingbird is Thunderbird's shared voice layer. One central deployment serves
every app; adding it to a new app is a script tag plus (optionally) a list of
voice actions.

## 0. Find the deployment URL

Ask the user for the Mockingbird deployment URL if it isn't already in the
project's env/config (look for `MOCKINGBIRD_URL`, or a script tag referencing
`mockingbird.js` in a sibling project). Referred to as `{BASE}` below, e.g.
`https://mockingbird-thunderbird.vercel.app`.

## 1. Add the script tag

In the app's root HTML template (or layout component), before `</body>`:

```html
<script src="{BASE}/src/mockingbird.js"
        data-transcribe-endpoint="{BASE}/api/transcribe"
        data-format-endpoint="{BASE}/api/format"
        data-actions-endpoint="{BASE}/api/actions"
        data-app-context="DESCRIBE THIS APP, e.g. 'Real-estate CRM: contacts, open houses, tasks'"
        data-manual="true"></script>
```

For React/Next.js, load it with `<Script strategy="afterInteractive" ...>` or an
effect that appends the script tag once.

**Result so far:** nothing visible — `data-manual="true"` defers init to step 2.
If the app only needs plain dictation (no voice actions), drop `data-manual`
and `data-actions-endpoint`, and you are DONE after this step.

## 2. Register the app's voice actions

Where the app initializes (after the script loads), call:

```js
Mockingbird.init({
  transcribeEndpoint: '{BASE}/api/transcribe',
  formatEndpoint: '{BASE}/api/format',
  actionsEndpoint: '{BASE}/api/actions',
  appContext: 'SAME DESCRIPTION AS ABOVE',
  userId: currentUser.id,               // however this app identifies users
  actions: ACTIONS,                     // see step 3
  onAction: handleVoiceAction           // see step 4
});
```

## 3. Define ACTIONS from what this app can create

Inspect the app for its create/log operations (API routes, forms, store
mutations) and write one entry per operation the user should be able to speak.
Follow this shape — `description` should say WHEN to trigger, not just what it is:

```js
const ACTIONS = [
  {
    name: 'create_contact',
    description: "Save a new contact or lead. Trigger whenever the speaker gives a person's name with contact details, or says they met someone. Several people mentioned = one action per person.",
    input_schema: {
      type: 'object',
      properties: {
        name:   { type: 'string' },
        phone:  { type: 'string' },
        email:  { type: 'string' },
        source: { type: 'string', description: 'How we met them, e.g. "open house at 123 Main St"' },
        notes:  { type: 'string' }
      },
      required: ['name']
    }
  },
  {
    name: 'create_open_house',
    description: 'Schedule an open house/showing. Trigger on "open house", "showing", "hosting buyers".',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        date:    { type: 'string', description: 'ISO date YYYY-MM-DD' },
        time:    { type: 'string', description: 'HH:MM 24h' },
        host:    { type: 'string' },
        notes:   { type: 'string' }
      },
      required: ['address']
    }
  },
  {
    name: 'create_task',
    description: 'Add a to-do/reminder. Trigger on "remind me to", "add a task", "I need to", "follow up".',
    input_schema: {
      type: 'object',
      properties: {
        title:    { type: 'string' },
        due:      { type: 'string', description: 'ISO date if a deadline was mentioned' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] }
      },
      required: ['title']
    }
  },
  {
    name: 'log_note',
    description: 'Log a note about a contact/lead/deal. Trigger on "note on X", "log that", "make a note".',
    input_schema: {
      type: 'object',
      properties: {
        about: { type: 'string' },
        note:  { type: 'string' }
      },
      required: ['note']
    }
  }
];
```

Trim/extend to match THIS app. Relative dates are resolved server-side —
schemas should just say ISO format.

## 4. Wire the handler to the app's real backend

```js
function handleVoiceAction(name, input) {
  switch (name) {
    case 'create_contact':    return api.contacts.create(input);     // this app's real calls
    case 'create_open_house': return api.openHouses.create(input);
    case 'create_task':       return api.tasks.create(input);
    case 'log_note':          return api.notes.create(input);
  }
}
```

Use the app's existing data layer (REST call, Supabase insert, store action).
Add optimistic UI (toast/card animation) if the app has a pattern for it —
Mockingbird already shows a green "✓ …" pill on the mic.

## 5. Verify

1. Run the app over HTTPS or localhost (mic requires it).
2. Console: `Mockingbird.version` → should print the version.
3. `Mockingbird.simulate('just met John Doe, 555-0142, john@test.com at the open house')`
   → the handler should fire with a `create_contact` payload (no mic needed).
4. Click a text field, `Mockingbird.simulate('um testing one two three period')`
   → polished text appears at the cursor.
5. Real mic test: hold **Ctrl+Space**, speak, release.

## Notes

- **Hotkey conflicts:** if the app already uses Ctrl+Space, pass `hotkey: 'Alt+M'` (or similar) to `init`.
- **Dictionary:** seed app-specific vocabulary via `dictionary: ['APU', 'Poinciana', ...]`; users add their own with `Mockingbird.learn(word)`.
- **Analytics:** if the deployment has `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set, every dictation/action is logged to the `mockingbird_events` table automatically — pass `userId` so events are attributable.
- **Never** call the Anthropic/Groq APIs directly from the app — always go through the `{BASE}` endpoints so keys stay server-side.
