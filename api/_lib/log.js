/**
 * Mockingbird — event log + Supabase access (optional, zero-config off).
 *
 * When SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set on the deployment,
 * every dictation, voice action, and executed connector call is recorded to
 * `mockingbird_events` (see db/schema.sql) — words, actions, app, user,
 * timing. Nothing is logged when the vars are absent, and logging failures
 * never break the user-facing request.
 *
 * Deliberately NOT stored: raw audio. Transcripts + actions give full
 * analytics without the storage cost and privacy weight of voice recordings.
 */

export function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Thin PostgREST wrapper — the service key never leaves the server. */
export async function sb(path, init = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase is not configured on this deployment.');
  const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, Object.assign({}, init, {
    headers: Object.assign({
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    }, init.headers || {})
  }));
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Record one event. Fire-and-forget by design: callers do not await it, and a
 * failure here is logged to the function's console, never to the user.
 */
export async function logEvent(event) {
  if (!supabaseConfigured()) return;
  try {
    await sb('mockingbird_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(event)
    });
  } catch (err) {
    console.error('mockingbird: event log failed', err.message);
  }
}
