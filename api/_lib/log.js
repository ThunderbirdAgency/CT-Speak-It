/**
 * Mockingbird — event logging (optional, zero-config off).
 *
 * When SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set on the deployment,
 * every dictation and voice action is recorded to the `mockingbird_events`
 * table (see db/schema.sql) — words, actions, app, user, timing. Nothing is
 * logged when the vars are absent, and logging failures never break the
 * user-facing request.
 *
 * Deliberately NOT stored: raw audio. Transcripts + actions give you full
 * analytics/replay without the storage cost and privacy weight of voice
 * recordings.
 */
export async function logEvent(event) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url.replace(/\/$/, '')}/rest/v1/mockingbird_events`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(event)
    });
  } catch (err) {
    console.error('mockingbird: event log failed', err);
  }
}
