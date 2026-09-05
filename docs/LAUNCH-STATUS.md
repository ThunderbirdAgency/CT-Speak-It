# Mockingbird consumer release status — September 5, 2026

Implementation branch: `finish/mockingbird-consumer`, based on `126bff9b16de5d0ee24b2a79531031d0117be824` from `claude/wispr-flow-integration-shi5x5`.

**The implementation and database foundation have been advanced, but the app is not yet a verified live consumer release.** No production site promotion, real payment, domain purchase, or desktop release publication was performed.

## Implemented

- Consumer marketing, setup/download, account, help, privacy and product terms pages.
- Clerk-verified ownership, Pro entitlement checks and daily usage gates before paid provider calls.
- Stripe-hosted subscription checkout and customer portal, strict server-selected $15 monthly USD price, customer ownership, signed raw-body subscription webhooks and duplicate/out-of-order projection handling.
- Gift issuance for allowlisted administrators; random hashed codes, recipient limits, claim expiry, gift duration, idempotent redemption, and revocation of future claims. Paid and gifted users unlock the same functions; gifts never auto-start billing.
- Optional user-approved vocabulary/style/phrases; sample-based suggestions returned for review. Export/erase controls, no automatic profiling and no server transcript archive.
- Exact spoken saved responses, web recording/rewrite workspace and mobile-browser copy workflow.
- Single-use desktop connection codes, protected local tokens and revocable 30-day device sessions.
- Desktop dictation, selected-text rewrite review, clipboard recovery, optional local history, in-session recording retry, separate IPC bridges, renderer/frame checks, HTTPS-only connections, and bounded recording sessions.
- Signed Mac/Windows packaging, macOS notarization, updater manifests and a draft-only release workflow.
- Authenticated widget integration for the Hub. Ordinary dictation does not route CRM actions.

## Verified here

`npm test` passed:

- 19 consumer integration checks with real RSA JWT verification and PostgreSQL via PGlite; external speech, AI and Stripe services were simulated.
- 12 Electron main-process checks with simulated OS interfaces, including credential isolation, HTTP rejection, raw transcript recovery, stale-message rejection, rewrite confirmation/cancellation, overlapping-recording rejection and local-history controls.
- 8 HTML pages and 66 local asset/link references, unique IDs and JavaScript syntax.
- 14 preserved connector request-shape checks for future development. Those connectors are not enabled in the consumer release.

The additive consumer migration was applied to the existing `apu-command-center` Supabase project. Live verification confirmed RLS on all six new tables, no direct `anon` or `authenticated` read access, and service-role access. A transaction that rolled back verified the live quota RPC both allows the first call and rejects a call above the cap, leaving no test account behind.

The Supabase advisor reports informational [RLS without policies](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) notices for intentionally backend-only tables. A pre-existing unrelated Hub function (`handle_updated_at`) has a [mutable search-path warning](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable); this change did not modify that shared function.

## Still required to launch

| Dependency | Evidence / next action |
| --- | --- |
| Existing Vercel project access | The connected Thunderbird team returned no projects; looking up `mockingbird` returned 404. Reconnect/authorize access to the existing project. Do not replace it with a new deployment just to bypass this boundary. |
| Canonical hostname | Confirm the production URL; no domain was bought. `askmockingbird.com` was a previously checked candidate, not a reserved domain. |
| Hub/Clerk production configuration | Configure Mockingbird's frontend domain with the Hub identity tenant, the authorized origins, and Erik's verified Clerk admin ID. Verify actual sign-in and device pairing. |
| Provider configuration and evaluation | Confirm working speech/Anthropic keys; test actual audio, agent vocabulary, accuracy, latency and usage costs. Daily limits are not a promise that every user is profitable at $15. Evaluate costs before broadly issuing sponsored seats. |
| Stripe account and webhook | Configure test keys, the matching $15 Price, webhook, portal and business details. Verify checkout/renewal/failure/cancellation with Stripe, then switch to live configuration. No real checkout was opened or charged here. |
| Desktop signing and real hardware | Add operator-owned Mac/Windows signing credentials and Apple notarization credentials. Build a draft, test on real Macs and Windows PCs, then publish. Clipboard focus, selection behavior, permissions and updater behavior cannot be proven by OS mocks. |
| Downloads and Hub links | Configure URLs only after verified artifacts are published. Hub already contains Mockingbird as Coming Soon; update its public/dashboard links and status after release gates pass. |
| Support and final policy details | Supply a monitored support email and verify operator identity, provider retention and billing disclosures against real account settings. |
| Final logo | The exact selected edit source was unavailable. The UI uses a bird emoji and installers retain the prior icon. Reattach that selected artwork or authorize a separately created final asset. |

## Verification limits and deliberate scope

No browser visual or real end-to-end session was run in this turn. Static checks establish references and syntax, not layout or microphone compatibility. The original browser widget tests were adjusted for the dictation-only behavior and remain a separate, unexecuted browser suite.

Native iPhone/Android keyboards, the sarcastic wake phrase, meeting recording and direct CRM/calendar execution are not finished and are not advertised as released. They should follow a successful desktop/web pilot. Existing CRM execution routes now return unavailable to prevent ordinary speech from changing business records.

The data benefit is the user's improved writing and reusable knowledge. Business insights derived from connected CRM records or aggregate product outcomes are a later opt-in feature, not a hidden dataset collected as a condition of accepting a gift.
