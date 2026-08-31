/**
 * Shared HTTP helpers for the Mockingbird API functions.
 *
 * CORS is open by default so one deployment can serve every build; lock it
 * down with ALLOWED_ORIGINS="https://crm.you.com,https://apu.you.com".
 * The desktop app sends no Origin header, so it is unaffected either way.
 */
export function corsHeaders(origin, methods) {
  const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const allowOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': methods || 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Mockingbird-Lang, X-Mockingbird-User, X-SpeakIt-Lang'
  };
}

/** Applies CORS + method checks. Returns true when the request is done. */
export function preflight(req, res, methods) {
  const headers = corsHeaders(req.headers.origin || '', methods);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  const allowed = (methods || 'POST, OPTIONS').split(',').map((s) => s.trim());
  if (!allowed.includes(req.method)) { res.status(405).json({ error: `${allowed[0]} only` }); return true; }
  return false;
}
