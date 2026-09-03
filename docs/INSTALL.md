# Getting Mockingbird running

Two audiences here: whoever sets it up once for the team, and the agents who
just want to talk instead of type. Their part is three steps at the bottom.

---

# For whoever sets it up (about 20 minutes, once)

## 1. Deploy this repo

Vercel is the path of least resistance — the `/api` folder is already
serverless functions.

```bash
npm i -g vercel
vercel --prod
```

Then set the environment variables on the project:

| Variable | What it turns on | Needed? |
|---|---|---|
| `ANTHROPIC_API_KEY` | The polish and the command understanding | **yes** |
| `GROQ_API_KEY` | Whisper-grade transcription (fastest, cheapest) | **yes** — or one of the two below |
| `DEEPGRAM_API_KEY` | `nova-3` instead | alternative |
| `OPENAI_API_KEY` | `whisper-1` instead | alternative |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Event log + the voice profile that makes it sound like each person | recommended |
| `ALLOWED_ORIGINS` | Lock the web widget to your own domains | recommended |
| `MOCKINGBIRD_ACCESS_KEY` | Require a key on every endpoint that costs money | **read the note below** |
| `FOLLOWUPBOSS_API_KEY` | Team-wide Follow Up Boss, so no key ever reaches a laptop | optional |
| `CONNECTOR_ALLOWED_HOSTS` | Restrict custom connectors to hosts you name | optional |
| `MOCKINGBIRD_LEARNING=off` | Kill the profile layer entirely | optional |

Check it:

```bash
curl https://your-deployment.vercel.app/api/tools
# {"connectors":[...],"requiresKey":false,"configured":{"transcription":true,"ai":true,"log":true,...}}
```

Anything `false` in `configured` is a missing environment variable. The
deployment's own front page says the same thing in plain language — open it in
a browser and it checks itself.

### A word about who can reach your deployment

A Vercel production URL is public. With keys configured and nothing else set,
anyone who learns the URL can POST to `/api/format` and spend your Anthropic
credits. `ALLOWED_ORIGINS` does not prevent this — CORS only constrains
browsers and says nothing to `curl`.

Set **`MOCKINGBIRD_ACCESS_KEY`** to any long random string and every endpoint
that costs money requires it. Clients send it as `X-Mockingbird-Key`:

- **Desktop:** Settings → Access key. Give agents the key with the URL.
- **Web apps:** `Mockingbird.init({ accessKey: '...' })`. Be clear-eyed about
  this one — anything a page holds, its users can read. It stops passers-by,
  it is not a secret. For a genuinely public page, proxy through your own
  server instead.

The `GET /api/tools` health check stays open either way, so a client can ask
whether a deployment is set up before it has been handed a key. It reports
which variables are set, never their values.

## 2. Create the tables (if you want it to remember)

Supabase → SQL editor → paste `db/schema.sql` → run. It is idempotent, so it
also upgrades an older install. Skip this and everything still works; it just
starts fresh every time. See [LEARNING.md](LEARNING.md).

## 3. Build the desktop app

```bash
cd desktop
npm install
npm run dist:mac    # on a Mac  → dist/Mockingbird-1.0.0.dmg
npm run dist:win    # on Windows → dist/"Mockingbird Setup 1.0.0.exe"
```

Put the two files wherever your team gets things (shared drive, intranet page,
a release on this repo).

**Sign them before a wide rollout.** An unsigned app that asks for Accessibility
permission is a hard sell to a room of agents. Apple Developer ID for the DMG,
a code-signing cert for the EXE, both configured in the `build` block of
`desktop/package.json`.

## 4. Connect your systems

- **Follow Up Boss for everyone:** set `FOLLOWUPBOSS_API_KEY` on the deployment.
  Nobody has to paste a key, and no key sits on a laptop.
- **Per agent instead:** they paste their own key in Settings → Connectors.
- **Your own products:** describe their endpoints once — [CONNECTORS.md](CONNECTORS.md).

## 5. Put it in the web apps

One script tag per build, or hand [ADD-MOCKINGBIRD.md](ADD-MOCKINGBIRD.md) to
Claude Code in that repo and let it do the wiring.

## 6. Verify end to end

```bash
npm test    # 58 assertions: connectors, the API as Vercel invokes it,
            # the desktop main process, and the widget in a real browser
```

A successful Vercel build should report **six** serverless functions — one per
endpoint (`act`, `actions`, `format`, `profile`, `tools`, `transcribe`). Files
under `api/_lib/` are shared code, and Vercel skips underscore-prefixed
directories; if you ever see more than six, something in `_lib` has been
renamed out of that protection.

Then, by hand, once:

1. Dictate into an email. Text lands, filler words gone.
2. Say a command. A card appears; **nothing happens until you press Enter**.
3. Press Enter. Check the record actually appeared in Follow Up Boss.
4. `select * from mockingbird_events order by created_at desc limit 5;`
5. Turn off wifi and dictate: you should get the raw transcript, not an error.

---

# For agents (three steps)

1. **Install it.** Open the file you were sent, drag Mockingbird to
   Applications (Mac) or click through the installer (Windows).
2. **Two boxes.** It opens asking for a deployment URL and your name. Paste,
   type, Save.
3. **Talk.** Put your cursor anywhere — an email, a text box, a CRM field —
   press **Ctrl/Cmd+Shift+Space**, say it, press it again.

To tell it to *do* something instead of typing it, press
**Ctrl/Cmd+Shift+K**: *"add Maria Lopez, 555-0142, from the open house, and
remind me to call her Monday."* It shows you what it's about to do; press
**Enter** and it's done.

Two permissions on a Mac, both one-time: the microphone (it asks), and
Accessibility so the text pastes itself (**System Settings → Privacy &
Security → Accessibility → switch on Mockingbird**). Until you do that second
one, your words wait on the clipboard and you press Cmd+V.

Nothing else. It sits in the menu bar and stays out of the way.
