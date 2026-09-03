/**
 * Shared HTTP helpers for the Mockingbird API functions.
 *
 * CORS is open by default so one deployment can serve every build; lock it
 * down with ALLOWED_ORIGINS="https://crm.you.com,https://apu.you.com".
 * The desktop app sends no Origin header, so it is unaffected either way.
 *
 * CORS is not access control, though — it only constrains browsers, and says
 * nothing to curl. Set MOCKINGBIRD_ACCESS_KEY and every endpoint that costs
 * money requires it, so learning the URL is no longer enough to spend your
 * Anthropic credits. See docs/INSTALL.md.
 */
export function corsHeaders(origin, methods) {
  const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const allowOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': methods || 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, X-Mockingbird-Key, X-Mockingbird-Lang, X-Mockingbird-User, X-SpeakIt-Lang'
  };
}

/**
 * Constant-time-ish comparison. The key is short and the endpoint is not a
 * login form, but there is no reason to leak its length or prefix by timing.
 */
function keyMatches(supplied, expected) {
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Applies CORS, the method check, and the access key. Returns true when the
 * request is finished and the handler should stop.
 *
 * Pass { open: true } for endpoints that must answer before a client has been
 * configured — only the health check qualifies, and it returns booleans about
 * which env vars are set, never a value.
 */
export function preflight(req, res, methods, { open = false } = {}) {
  const headers = corsHeaders(req.headers.origin || '', methods);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }

  const allowed = (methods || 'POST, OPTIONS').split(',').map((s) => s.trim());
  if (!allowed.includes(req.method)) { res.status(405).json({ error: `${allowed[0]} only` }); return true; }

  const expected = process.env.MOCKINGBIRD_ACCESS_KEY;
  if (expected && !open) {
    const supplied = req.headers['x-mockingbird-key'] ||
      (req.query && req.query.key) ||
      (req.body && req.body.key) || '';
    if (!keyMatches(String(supplied), expected)) {
      res.status(401).json({ error: 'This Mockingbird deployment requires an access key.' });
      return true;
    }
  }
  return false;
}
