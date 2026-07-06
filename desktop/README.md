# Mockingbird Desktop 🐦 (beta)

System-wide dictation for **Mac and Windows**: press the hotkey in *any*
application — Outlook, Word, a browser, anything — speak, press it again, and
the Claude-polished text is pasted at your cursor. Uses the same Mockingbird
deployment (and the same Whisper-grade transcription, formatting, and event
log) as the web widget.

> **Status: beta scaffold.** Built and syntax-verified, but global hotkeys and
> paste simulation can only be truly tested on a real Mac/PC — expect to run it
> once, grant two permissions, and report anything odd.
> Any Claude Code session can iterate on it: "fix X in desktop/".

## How it works

```
hotkey (Ctrl/Cmd+Shift+Space) ─▶ overlay pill appears (never steals focus)
   ─▶ speak ─▶ hotkey again ─▶ /api/transcribe ─▶ /api/format
   ─▶ text placed on clipboard ─▶ paste keystroke simulated into the front app
```

No native modules: paste is simulated with `osascript` (Mac) / PowerShell
`SendKeys` (Windows) / `xdotool` (Linux, if installed). If simulation is
blocked, the text is on the clipboard and a notification says to press paste.

## Run it (development)

```bash
cd desktop
npm install
npm start
```

First launch opens `config.json` — set your deployment:

```json
{
  "baseUrl": "https://your-mockingbird.vercel.app",
  "hotkey": "CommandOrControl+Shift+Space",
  "tone": "clean",
  "lang": "en-US",
  "userId": "erik"
}
```

Tray icon → "Reload settings" after editing.

## Permissions

- **Mac:** first dictation prompts for **Microphone**; auto-paste needs
  **System Settings → Privacy & Security → Accessibility → allow Mockingbird**
  (until granted, text lands on the clipboard and you press Cmd+V).
- **Windows:** microphone prompt only.

## Build installers

```bash
cd desktop
npm install
npm run dist:mac   # → dist/Mockingbird-x.y.z.dmg   (run on a Mac)
npm run dist:win   # → dist/Mockingbird Setup x.y.z.exe   (run on Windows, or a Mac with wine)
```

Unsigned builds are fine for internal use: Mac users right-click → Open the
first time; Windows users click through SmartScreen. For public distribution
add code signing (Apple Developer ID / Windows cert) to the `build` section —
worth doing before the agent giveaway.

## Notes

- The hotkey is a **toggle** (press to start, press to finish) — global
  hold-to-talk isn't reliably detectable across apps, and toggle is what
  desktop dictation tools ship.
- Voice **actions** are a web-app feature (they need a dashboard to act on);
  desktop is pure dictation by design.
- Replace the placeholder tray icon (`TRAY_ICON_B64` in `main.js`) with real
  icon assets before giving this to agents.
