# Mockingbird consumer release status — September 6, 2026

Implementation branch: `finish/mockingbird-consumer`, based on `126bff9b16de5d0ee24b2a79531031d0117be824` from `claude/wispr-flow-integration-shi5x5`.

**The implementation and database foundation have been advanced, but the app is not yet a verified live consumer release.** No production site promotion, real payment, domain purchase, or desktop release publication was performed.

## September 6 continuation

- Preserved PR #1 and `finish/mockingbird-consumer` at implementation commit `4b1e1dcca98919fd71af653304c23778738bf731`; no application code was replaced.
- Re-ran `npm test`: all 19 consumer integration checks, 12 simulated-OS desktop checks, 8-page/66-reference web checks and 14 preserved connector checks passed. Providers and Stripe remain simulated in this suite.
- Confirmed signed-in dashboard access to the existing Vercel project `mockingbird`, ID `prj_3yb0jFGuWdOb1mLJ7Cdy2kZ2dclF`. The connected Vercel API still returns 404, so use the authenticated dashboard rather than creating a replacement project.
- Existing production remains `https://mockingbird-rho.vercel.app`, on `claude/wispr-flow-integration-shi5x5` at `126bff9`. The consumer preview is `https://mockingbird-git-finish-mockingbird-consumer-thunderbird-agency.vercel.app`.
- Existing `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present for Production and Preview. Presence is not live provider/database verification; secret values were not revealed.
- Confirmed the user-specified Clerk application `app_3IwLaU6FAETeJ1qBE1rpbmuIBkA`, development instance `ins_3IwLaYK4Cx3tSqH3K6ijcc6Rd9s`, frontend `wise-hamster-4112.clerk.accounts.dev`. Email verification is enabled. It has no production environment. This is the specified Mockingbird application; shared Hub SSO remains unverified.
- Saved `CLERK_PUBLISHABLE_KEY` and `MOCKINGBIRD_PUBLIC_URL` as Config values scoped only to Preview branch `finish/mockingbird-consumer`. Existing-source preview redeploy `9PhF26X6xPkw4hv22dQrQuPWJyJg` reached Ready. The account page now renders the Mockingbird Clerk sign-in form with Google and email options in development mode. This verifies frontend wiring, not a completed authenticated account session.
- `CLERK_SECRET_KEY`, `CLERK_AUTHORIZED_PARTIES`, the verified admin allowlist, Stripe configuration, support/Hub URLs and download URLs are still missing. Approval was requested to transfer the existing Clerk secret directly into encrypted Vercel Preview settings, without pasting it into chat.
- The connected Stripe account is ThunderBird Agency (`acct_1MGGhdBk08Px6wM1`) in test mode. Account selection was requested before account-specific setup; no Stripe product, subscription or payment was created.
- GitHub Releases has no releases. The repository's Actions settings show no repository or environment secrets, so the required Apple/Windows signing and notarization credentials are not configured.
- External HTTP checks of the preview encounter Vercel Deployment Protection (401) before reaching the app. These responses do not prove application authorization. Plan authenticated browser checks and a deliberately configured Stripe webhook delivery path; do not silently disable protection.

Next: complete preview Clerk configuration, redeploy and verify actual sign-in; verify Erik's Clerk ID before allowing gift administration; exercise gift issuance/redemption, actual dictation and device pairing; configure the selected Stripe test account and verify the billing lifecycle; obtain operator-owned signing credentials and perform real Mac/Windows acceptance. Confirm the production domain and monitored support address before production configuration and promotion.

## Implemented

- Consumer marketing, setup/download, account, help, privacy and product terms pages.
- Clerk-verified ownership, Pro entitlement checks and daily usage gates before paid provider calls.
- Stripe-hosted subscription checkout and customer portal, strict server-selected $25 monthly USD price, customer ownership, signed raw-body subscription webhooks and duplicate/out-of-order projection handling.
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
| Existing Vercel project access | Resolved through the signed-in dashboard on September 6; connected API still returns 404. Use the existing project and preview branch. |
| Canonical hostname | Confirm the production URL; no domain was bought. `askmockingbird.com` was a previously checked candidate, not a reserved domain. |
| Hub/Clerk production configuration | The specified Mockingbird Clerk development app is accessible; its public key is saved for the consumer preview. Complete secret/origin/admin configuration, establish production identity/domain settings, and verify actual sign-in, Hub SSO and device pairing. |
| Provider configuration and evaluation | Confirm working speech/Anthropic keys; test actual audio, agent vocabulary, accuracy, latency and usage costs. Daily limits are not a promise that every user is profitable at $25. Evaluate costs before broadly issuing sponsored seats. |
| Stripe account and webhook | Configure test keys, the matching $25 Price, webhook, portal and business details. Verify checkout/renewal/failure/cancellation with Stripe, then switch to live configuration. No real checkout was opened or charged here. |
| Desktop signing and real hardware | Add operator-owned Mac/Windows signing credentials and Apple notarization credentials. Build a draft, test on real Macs and Windows PCs, then publish. Clipboard focus, selection behavior, permissions and updater behavior cannot be proven by OS mocks. |
| Downloads and Hub links | Configure URLs only after verified artifacts are published. Hub already contains Mockingbird as Coming Soon; update its public/dashboard links and status after release gates pass. |
| Support and final policy details | Supply a monitored support email and verify operator identity, provider retention and billing disclosures against real account settings. |
| Final logo | The exact selected edit source was unavailable. The UI uses a bird emoji and installers retain the prior icon. Reattach that selected artwork or authorize a separately created final asset. |

## Verification limits and deliberate scope

No browser visual or real end-to-end session was run in this turn. Static checks establish references and syntax, not layout or microphone compatibility. The original browser widget tests were adjusted for the dictation-only behavior and remain a separate, unexecuted browser suite.

Native iPhone/Android keyboards, the sarcastic wake phrase, meeting recording and direct CRM/calendar execution are not finished and are not advertised as released. They should follow a successful desktop/web pilot. Existing CRM execution routes now return unavailable to prevent ordinary speech from changing business records.

The data benefit is the user's improved writing and reusable knowledge. Business insights derived from connected CRM records or aggregate product outcomes are a later opt-in feature, not a hidden dataset collected as a condition of accepting a gift.
