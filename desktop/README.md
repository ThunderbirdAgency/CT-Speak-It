# Mockingbird Desktop 1.1

Mac and Windows client for the consumer API. Use an account connection code from the website, not a deployment key.

- `Cmd/Ctrl+Shift+Space`: toggle dictation. No CRM action routing.
- `Cmd/Ctrl+Shift+R`: capture selected text, dictate a rewrite instruction, review and accept/cancel.
- Clipboard-only mode is available. Output intentionally stays on the clipboard for recovery.
- Optional local history holds 200 results; default off.
- The latest recording remains in memory for retry until replaced, discarded or the app closes.
- Device tokens use Electron safeStorage and never cross either renderer's IPC bridge. Pairing code is single-use; device sessions expire after 30 days and are revocable from the account.
- Separate settings/recording preloads and IPC sender/frame checks restrict each window's access.
- Three-minute recording limit, session IDs, busy-state gating and cancellation prevent overlapping results.
- Signed release updates use electron-updater and GitHub release manifests.

`npm ci && npm start` launches locally on a supported OS. `npm test` uses a simulated OS and does not verify actual microphone, clipboard automation, Accessibility, signing or update behavior. Follow the real-device release checks in `../docs/INSTALL.md`.

The current icon is inherited from the previous app. Final selected bird artwork was unavailable in the build workspace.
