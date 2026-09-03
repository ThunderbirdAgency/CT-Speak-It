# Mockingbird Desktop 🐦

Talk instead of type — **anywhere on your machine** — and tell your systems what
to do.

```
Ctrl/Cmd+Shift+Space   speak → polished text pasted where your cursor is
                       (Outlook, Word, Gmail, Slack, any CRM field, anything)

Ctrl/Cmd+Shift+K       speak an instruction → Mockingbird shows what it will do
                       → press ⏎ → it happens in Follow Up Boss / your CRM
```

Same deployment, same accuracy, same personal dictionary as the web widget —
this is just the copy that follows you into every other application.

## Install

**From an installer** (what agents get):

1. Download `Mockingbird-1.0.0.dmg` (Mac) or `Mockingbird Setup 1.0.0.exe` (Windows).
2. Open it, drag to Applications / click through the installer.
3. Mockingbird opens its setup window. Paste the deployment URL your team gave
   you, type your name, hit **Save**. That's the whole setup.
4. Press **Ctrl/Cmd+Shift+Space** in any app and talk.

First dictation asks for the microphone. On a Mac, also switch Mockingbird on
under **System Settings → Privacy & Security → Accessibility** so text pastes
itself — until you do, it waits on the clipboard and you press Cmd+V.

**From source** (development):

```bash
cd desktop
npm install
npm start
```

## Using it

**Dictating.** Put your cursor where the words should go, press the shortcut,
talk, press it again. The pill in the corner shows the level while you speak
and the text lands a moment later — filler words gone, self-corrections
applied, spoken punctuation turned into real punctuation. Escape cancels.
Whatever was on your clipboard is put back afterwards.

**Commanding.** Press the command shortcut and say what you want done:

> "Add Maria Lopez, 555-0142, from the open house at 123 Main, and remind me to
> call her Monday morning."

Mockingbird shows a card with exactly what it is about to do — the action, the
system, every field it filled in — and waits. **Enter** runs it, **Escape**
throws it away. Two things in one sentence become two cards and one Enter.

Questions work too: *"what's Maria Lopez's number"* pastes the answer where
your cursor is.

With **Notice commands while dictating** on (the default), you don't have to
remember which shortcut you pressed: say something that is plainly an
instruction and Mockingbird offers to run it instead of typing it. Anything
ambiguous is treated as dictation — words in the wrong email are a nuisance, a
record created by accident is worse.

## Connecting your systems

Settings → **Connectors**.

- **Follow Up Boss** — paste an API key (FUB → Admin → API). You get contacts,
  notes, tasks, calls, appointments, stage changes and lookups by voice.
- **Your own product** — describe its endpoints once and they become things you
  can say. See `docs/CONNECTORS.md` in this repo.

Keys are stored in the app's own config file on your machine and travel with
each request to your deployment. Mockingbird's server never stores them.

## What it learns

Settings → **What it's learned** shows the profile Mockingbird has built from
your own dictations: how you write, the phrases you use, the names it now
spells correctly, how you work. That is what makes the text come out sounding
like you rather than like an AI. It is readable and erasable on that page, and
the whole thing can be switched off. Details: `docs/LEARNING.md`.

## Building installers

Push a tag and GitHub builds both for you — no need for a Mac *and* a PC:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

The workflow attaches `Mockingbird-mac.dmg` (universal — one file for Apple
silicon and Intel) and `Mockingbird-win.exe` to the release. Those filenames are
fixed, so the deployment's install page can link to them permanently.

Locally, if you have the right machine:

```bash
cd desktop
npm install
npm run icons      # only after editing tools/make-icons.js
npm run dist:mac   # → dist/Mockingbird-mac.dmg  (run on a Mac)
npm run dist:win   # → dist/Mockingbird-win.exe  (run on Windows)
```

Unsigned builds are fine internally: Mac users right-click → Open the first
time, Windows users click through SmartScreen. Before handing this to a wider
group of agents, add code signing (Apple Developer ID / Windows cert) — an
unsigned app that asks for Accessibility permission is a hard sell.

## Testing without a screen

```bash
npm test
```

Stubs Electron and a deployment, then drives the real main process through the
paths that matter: hotkey → speak → confirmation card → Enter → action → history,
plus the ones that must never lose words (router down, formatter down).

## Notes

- The hotkeys are **toggles** (press to start, press to finish). Global
  hold-to-talk isn't reliably detectable across applications, and toggle is what
  desktop dictation tools ship.
- Mockingbird sits in the menu bar / system tray with no dock or taskbar entry.
  Click the icon to dictate; right-click for the menu.
- **Auto-finish on silence** is off by default — set it in the config file
  (`autoStopSeconds`) if you'd rather it end the recording for you.
- Web apps that embed the widget get the same actions plus their own in-app ones;
  the desktop app only runs connector actions, since there is no app here to
  hand an in-app action to.
