> Historical/experimental connector reference. Consumer action endpoints are disabled in the dictation release. This document is not a list of released capabilities.

# Connectors — making Mockingbird *do* things

Dictation is half of Mockingbird. The other half is that anything you can
describe as an API call becomes something you can just say:

> "Add Maria Lopez, 555-0142, from the open house at 123 Main, and remind me to
> call her Monday morning."

Two records, one sentence, one press of Enter.

## How a spoken sentence becomes an API call

```
speech ─▶ /api/transcribe ─▶ /api/actions ─┬─ dictation? → polished text at your cursor
                                            └─ command?  → a card showing exactly
                                                           what will happen
                                                              │ you press ⏎
                                                              ▼
                                                        /api/act ─▶ Follow Up Boss
                                                                    your product
                                                                    …
```

`/api/actions` only *decides*. `/api/act` is the only thing that writes, and
the client shows the card and waits for a keypress in between. That split is
deliberate: an agent should never discover that something was created in their
CRM because a sentence was misheard.

## Follow Up Boss

**Desktop:** Settings → Connectors → paste an API key (Follow Up Boss → Admin →
API) → Connect.

**A deployment serving one team:** set `FOLLOWUPBOSS_API_KEY` in the
environment and clients just name the connector — no key ever reaches a
browser or a laptop:

```js
Mockingbird.connect('followupboss');
```

What you can say once it's connected:

| Say something like | What happens |
|---|---|
| "Just met John Doe, 555-0142, john@x.com, came through the open house" | contact created (deduplicated against existing ones) |
| "Note on Maria Lopez — she's pre-approved to 550" | note logged on her record |
| "Remind me to call the Chens Monday at 9" | task, due Monday 09:00, linked to their contact |
| "Just got off the phone with Maria, left a voicemail" | call logged with the outcome |
| "Showing at 123 Main Saturday at 2 with the Chens" | appointment on the calendar |
| "Move Maria to active client" | stage changed |
| "What's Maria Lopez's number?" | the answer is typed where your cursor is |

Optional credentials: `system` and `systemKey` (`X-System` / `X-System-Key`) if
Follow Up Boss has issued your integration a system key, or the env vars
`FOLLOWUPBOSS_SYSTEM` / `FOLLOWUPBOSS_SYSTEM_KEY`.

## Your own product

Describe the endpoints once, and they become things people can say. This is how
our own builds get voice actions without embedding anything in every screen.

Desktop: Settings → Connectors → *Your own product*. Server-side: pass the same
object in the `connectors` array.

```json
{
  "type": "custom",
  "id": "apu",
  "label": "Agent Power Ups",
  "config": {
    "baseUrl": "https://apu.thunderbird.com",
    "headers": { "Authorization": "Bearer ..." },
    "actions": [
      {
        "name": "create_open_house",
        "description": "Schedule an open house. Trigger on \"open house\", \"showing\", \"hosting buyers\".",
        "input_schema": {
          "type": "object",
          "properties": {
            "address": { "type": "string" },
            "date":    { "type": "string", "description": "ISO date YYYY-MM-DD" },
            "time":    { "type": "string", "description": "HH:MM 24h" }
          },
          "required": ["address"]
        },
        "method": "POST",
        "path": "/api/open-houses",
        "body": { "street": "{{address}}", "startsOn": "{{date}}" },
        "summary": "Open house at {{address}}"
      }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `name` | Tool name. Keep it verb-first: `create_open_house`, `log_showing`. |
| `description` | **Says when to trigger**, not just what it is. This is the whole recognition rule — write it the way you'd brief a new assistant. |
| `input_schema` | JSON Schema. Field `description`s are instructions to the extractor: say "ISO date YYYY-MM-DD" and you get one. |
| `method` / `path` | `POST` by default. `{{placeholders}}` work in the path too. |
| `body` | Optional template. Omit it and the extracted input is sent as-is. |
| `summary` | What the confirmation card and the event log say. |

Placeholders: `{{field}}` alone keeps the value's type (a number stays a
number); embedded in a longer string it interpolates as text. Empty fields are
dropped rather than sent as `""`.

Relative dates are resolved before your endpoint sees them — "this Saturday"
arrives as `2026-09-05`. Self-corrections are applied ("2pm no wait 3" → `15:00`).

### Writing descriptions that actually trigger

The difference between a connector people love and one they give up on is
almost entirely in the `description` fields.

- Say **when**: "Trigger on 'remind me to', 'add a task', 'follow up with'."
- Say **what it is not**: "Not for notes about a person — use log_note."
- Mention the plural case: "Several people mentioned = one action per person."

## Guardrails

- **HTTPS only**, and the server refuses to call loopback or private-range
  hosts — it relays for your users, it is not an open proxy.
- Set `CONNECTOR_ALLOWED_HOSTS=thunderbird.com,followupboss.com` on the
  deployment to narrow it to hosts you name.
- Credentials travel with each request and are used for that call only. The
  deployment stores nothing; the desktop app keeps them in its own config file
  on the user's machine.
- **Never put a credential in browser code.** Anything a page can read, a user
  can read. In web apps, either put the key in the deployment's environment and
  send just `Mockingbird.connect('followupboss')`, or proxy through your own
  server.
- Ambiguity resolves to dictation, always. Words in the wrong email are a
  nuisance; a record created by accident is worse.

## Adding a first-class connector

`api/_lib/connectors/` — one file per system, exporting `id`, `label`,
`credentialFields`, `tools()`, and `execute(action, input, credentials, config)`.
Register it in `index.js` and it appears in the desktop Settings screen and in
`GET /api/tools` automatically. `followupboss.js` is about 300 lines and is the
one to copy.
