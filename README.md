# Mockingbird 🐦

Voice dictation, reviewed rewrites, and spoken saved responses for real estate agents. A Thunderbird product with paid Pro access and complimentary gift codes.

This branch implements the consumer dictation release. It is **not a declaration that the production service or signed desktop installers have launched**. See [release status](docs/LAUNCH-STATUS.md) for completed checks and external dependencies.

## Product

- Mac / Windows Electron app: activate a shortcut, speak, then press again to insert text.
- Separate selected-text rewrite shortcut, with a review before replacement.
- Web workspace for recording, rewriting, and copying, including compatible mobile browsers.
- Pro: $15 USD/month through Stripe, or the same access covered by a gift code.
- Gift administration: duration, recipient limits, expiry, claim counts, revocation of new claims.
- Clerk identity shared with the Hub; single-use desktop pairing and revocable 30-day sessions.
- Optional, editable writing preferences. User-provided samples generate unsaved suggestions for review.
- Up to 100 exact spoken saved responses; say “insert” followed by a trigger.
- No server transcript archive or automatic background profiling. Desktop history is off by default.

The native iOS/Android keyboard apps, wake phrase, meeting recorder, and direct CRM actions are outside this release. Existing connector modules remain for later development, but consumer action endpoints return unavailable and the dictation widget does not route commands.

## Development and verification

```bash
npm ci
npm test
cd desktop
npm ci
npm start
```

`npm test` exercises real JWT verification and PostgreSQL (PGlite) with simulated speech/Stripe services, a simulated Electron OS, static route/asset checks, and legacy connector request shapes. It does not establish real microphone, native paste, provider accuracy, checkout delivery, visual layout, or signed installer behavior.

`npm run test:widget` is a separate browser suite for an environment with Chromium available.

## Deployment

Keep the existing Vercel project. Apply the additive SQL migration and configure the environment variables in [.env.example](.env.example). Detailed instructions: [INSTALL](docs/INSTALL.md). The backend database is the existing APU Hub project, with backend-only consumer tables.

New accounts have neither paid access nor memory enabled. Add verified Clerk user IDs to `MOCKINGBIRD_ADMIN_USER_IDS` to enable gift management. Do not use a shared deployment key or a name supplied by the client as identity.

Downloads stay in a truthful “preparing for launch” state until signed, tested release URLs are configured. The release workflow requires signing, notarizes macOS artifacts, and creates a draft GitHub release including updater manifests. Publish only after real-device checks.

## Documentation

- [Install and configure](docs/INSTALL.md)
- [Memory and data handling](docs/LEARNING.md)
- [Embed dictation in the Hub](docs/ADD-MOCKINGBIRD.md)
- [Desktop](desktop/README.md)
- [Launch status and remaining gates](docs/LAUNCH-STATUS.md)
