# Writing memory that the agent controls

The useful advantage of dictation data is better spelling, better matching of writing style, and easy reuse of the user's own responses. It does not require a warehouse of every word they speak.

The consumer release stores only a profile and saved responses the user explicitly saves. Memory is off by default and can be read, edited, exported, disabled or erased. A sample submitted to `/api/profile` is processed transiently to suggest style, generic industry terms and reusable phrases. It is never automatically saved. No client dossiers, relationship scoring, hidden sales intelligence or sensitive-trait inference is implemented.

Dictation and rewrite text go to the configured providers to fulfill the request. Provider retention follows the operator's agreements/settings; local non-retention is not a promise of provider zero retention. `logEvent` no longer stores transcripts, action inputs, or outputs. Quotas contain user ID, day, bucket and count only.

Erasure clears the approved profile, saved responses and memory toggle, and removes legacy events/profiles associated with the verified account ID where those old tables exist. Old manually named identities must be reconciled by the operator; never map one to a logged-in account based only on an unverified client name. Device-local history is independent and must be cleared on each device.

Future useful additions may include **opt-in** personal reports: repeated work that could become a saved response, useful follow-up templates, or user-approved knowledge from connected business systems. Build these around explicit consent, provenance and correction. Keep product analytics to aggregate use/success metrics, and do not expose customers' transcripts to Thunderbird's marketing or sales tools.
