# Consumer deployment

Use the existing ThunderbirdAgency/CT-Speak-It Vercel project. Do not create a replacement Hub or authentication tenant.

## Database

Apply `db/migrations/20260905_consumer.sql` to the Hub database. This additive migration creates accounts, gifts/redemptions, pairing/devices and quotas. It does not change Hub profiles, power-up entitlements or legacy event rows. In this work session it was applied successfully to `apu-command-center` on September 5, 2026, and live grants were verified.

All new tables use RLS and deny `anon`/`authenticated` direct access. The verified server uses the service role. All RPCs use invoker security, fixed search paths and explicit service-role-only grants. Supabase's informational “RLS Enabled No Policy” notice is expected for these deliberately backend-only tables; do not add public policies to silence it.

The older `db/schema.sql` is historical logging infrastructure and is not needed for a new consumer deployment. Do not run it to enable transcript collection.

## Clerk and Hub

Use the Hub's Clerk instance. Configure Mockingbird's production hostname and frontend/satellite domain according to the Clerk instance's domain settings. Set `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_AUTHORIZED_PARTIES` (explicit full frontend origins), and optionally `CLERK_JWT_KEY` for networkless verification. Verify real sign-in from the Hub and the Mockingbird site before rollout; sharing a key does not by itself configure multi-domain SSO.

Set `MOCKINGBIRD_PUBLIC_URL` to the canonical HTTPS origin, `MOCKINGBIRD_HUB_URL` to the actual Hub URL, and `ALLOWED_ORIGINS` to the permitted browser origins. Add Erik's **verified Clerk user ID** to `MOCKINGBIRD_ADMIN_USER_IDS`. Do not use an email or a guess for this ID.

The Hub already has a `power_ups` row with ID `mockingbird`, currently `coming-soon`. After the live site and installers pass release gates, set its dashboard URL to `/account` on the canonical site, sales page URL to `/`, and CTA to Open Mockingbird. Preserve the Hub's existing `agent_power_ups` access model; catalog visibility is not a substitute for Pro entitlement. Users redeem gifts inside Mockingbird.

## Providers

Set `ANTHROPIC_API_KEY` and a transcription provider key. The speech provider selection order is Groq, Deepgram, OpenAI. There is no automatic cross-provider retry. Set `MOCKINGBIRD_MODEL` explicitly if choosing another supported Anthropic model; default is `claude-sonnet-4-6`. Test accuracy, numbers, proper names and latency with actual agent recordings before selecting a cheaper model.

The speech and formatting endpoints require an active Pro entitlement and reserve a per-user daily request quota before invoking providers. Audio bodies stop at 4 MiB, below the Vercel body limit. App recordings stop at three minutes. Quotas count attempted requests, including failures; they do not record transcript text.

## Stripe

Start with test-mode keys. Create one active recurring monthly USD Price for **$15.00**. Set its ID as `STRIPE_PRICE_ID`, plus `STRIPE_SECRET_KEY` and the webhook signing secret `STRIPE_WEBHOOK_SECRET`.

Register `https://<canonical-host>/api/webhook` for `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. The route requires raw-body signatures, retrieves current subscription state, checks customer ownership and recognized Price, and projects access into the database. Checkout success redirects do not grant access.

Enable Stripe Customer Portal subscription cancellation and payment-method management. Configure operator identity, support details and tax settings in Stripe. Verify the displayed checkout amount and recurring disclosure. Run a successful subscription, payment failure, cancellation, renewal, duplicate-event replay and out-of-order event test before changing to live keys. Live keys and live Price/webhook IDs must belong to the same Stripe account/environment.

Gifted users never enter checkout to redeem. A gift does not cancel an existing paid subscription; the account UI tells them to cancel renewal in the portal if desired. Default gift creation gives one year to one recipient, claimed within 90 days. Codes are random, hashed in storage and displayed only once to the administrator.

## Desktop release

The workflow requires `CSC_LINK`, `CSC_KEY_PASSWORD`, `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` as GitHub Actions secrets. Signing certificates must belong to the operator. `forceCodeSigning` prevents an unsigned consumer installer from being mistaken for a signed release.

Set matching desktop package/lock versions, then push a matching version tag to build a **draft** release. Manual workflow dispatch builds artifacts without publishing a release. Both platform jobs must pass before the draft is created. The macOS DMG and ZIP, Windows EXE, blockmaps and update manifests are retained.

Test installation, microphone permissions, dictation, selection capture, rewrite review, paste into representative apps, retry, revocation, uninstall and updating on actual Mac and Windows machines. Publish the release after those checks. Then set `MOCKINGBIRD_MAC_DOWNLOAD_URL` and `MOCKINGBIRD_WINDOWS_DOWNLOAD_URL` to the signed release assets.

## Support, domain and privacy

Set a monitored `MOCKINGBIRD_SUPPORT_EMAIL`. The pages describe implemented data practices, but provider retention, operator contact information and payment disclosures must be checked against the actual production configuration. The web UI loads fonts from Google Fonts; Clerk and Stripe load their own external services.

No domain was purchased. Previously checked candidate: `askmockingbird.com`; availability must be checked again before buying. The selected image-edit source was missing, so this branch uses a bird emoji in the interface and keeps the previous installer icon. Final bird artwork still needs the selected source reattached or a separately approved new asset.
