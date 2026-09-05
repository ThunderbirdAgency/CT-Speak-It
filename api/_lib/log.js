/** Backend-only PostgREST access. Consumer usage stores counts, never transcripts. */
export function supabaseConfigured() {
  return Boolean(
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

/** Thin PostgREST wrapper — the service key never leaves the server. */
export async function sb(path, init = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error("Supabase is not configured on this deployment.");
  const r = await fetch(
    `${url.replace(/\/$/, "")}/rest/v1/${path}`,
    Object.assign({}, init, {
      signal: AbortSignal.timeout(10000),
      headers: Object.assign(
        {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        init.headers || {},
      ),
    }),
  );
  if (!r.ok)
    throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Record one event. Fire-and-forget by design: callers do not await it, and a
 * failure here is logged to the function's console, never to the user.
 */
export async function logEvent(_event) {
  // No server transcript/action archive. Quotas store counts only.
}
