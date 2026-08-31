/**
 * Mockingbird connector — custom HTTP.
 *
 * Lets any product get voice actions without writing a connector module: the
 * client (desktop Settings, or an app's server) describes its endpoints, and
 * Mockingbird turns spoken commands into those HTTP calls. This is how the
 * Thunderbird CRM / Agent Power Ups builds get "say it and it happens" without
 * embedding the widget in every screen.
 *
 * Client-supplied config:
 *   {
 *     id: 'apu',
 *     label: 'Agent Power Ups',
 *     baseUrl: 'https://apu.thunderbird.com',
 *     headers: { Authorization: 'Bearer ...' },
 *     actions: [{
 *       name: 'create_open_house',
 *       description: 'Schedule an open house. Trigger on "open house", "showing".',
 *       input_schema: { type: 'object', properties: { address: {...} }, required: ['address'] },
 *       method: 'POST',
 *       path: '/api/open-houses',
 *       body: { street: '{{address}}' },     // optional — omit to send the input as-is
 *       summary: 'Open house at {{address}}' // optional — spoken/shown confirmation
 *     }]
 *   }
 *
 * The URL is checked before every call: HTTPS only, no private/loopback hosts,
 * and an optional CONNECTOR_ALLOWED_HOSTS allowlist on the deployment. The
 * server is a relay, not an open proxy.
 */

export const id = 'custom';
export const label = 'Custom HTTP';

export const credentialFields = [
  { key: 'baseUrl', label: 'Base URL', secret: false, required: true },
  { key: 'headers', label: 'Headers (JSON)', secret: true, required: false }
];

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

function assertSafeUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (e) { throw new Error(`Invalid connector URL: ${raw}`); }
  if (url.protocol !== 'https:') throw new Error('Connector URLs must use HTTPS.');
  if (PRIVATE_HOST.test(url.hostname)) throw new Error(`Connector host not allowed: ${url.hostname}`);
  const allow = (process.env.CONNECTOR_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length && !allow.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
    throw new Error(`Connector host not in CONNECTOR_ALLOWED_HOSTS: ${url.hostname}`);
  }
  return url;
}

// "{{field}}" → input.field. Whole-string placeholders keep their JSON type
// (numbers stay numbers); embedded ones interpolate as text.
function fill(template, input) {
  if (typeof template === 'string') {
    const whole = template.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (whole) return input[whole[1]];
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (input[k] == null ? '' : String(input[k])));
  }
  if (Array.isArray(template)) return template.map((t) => fill(t, input));
  if (template && typeof template === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(template)) {
      const filled = fill(v, input);
      if (filled !== undefined && filled !== '') out[k] = filled;
    }
    return out;
  }
  return template;
}

function parseHeaders(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

/** Tool schemas for the actions this client described. */
export function tools(config) {
  const actions = (config && config.actions) || [];
  return actions
    .filter((a) => a && a.name && a.input_schema)
    .map((a) => ({
      name: String(a.name).slice(0, 64),
      description: String(a.description || a.name).slice(0, 1024),
      input_schema: a.input_schema
    }));
}

export async function execute(action, input, creds, config) {
  const spec = ((config && config.actions) || []).find((a) => a && a.name === action);
  if (!spec) throw new Error(`Unknown custom action: ${action}`);

  const base = String((config && config.baseUrl) || (creds && creds.baseUrl) || '').replace(/\/$/, '');
  const path = fill(spec.path || '', input);
  const url = assertSafeUrl(/^https?:/i.test(path) ? path : base + path);

  const method = (spec.method || 'POST').toUpperCase();
  const payload = spec.body ? fill(spec.body, input) : input;
  const headers = Object.assign(
    { 'Content-Type': 'application/json', Accept: 'application/json' },
    parseHeaders(config && config.headers),
    parseHeaders(creds && creds.headers)
  );

  if (method === 'GET' || method === 'DELETE') {
    for (const [k, v] of Object.entries(payload || {})) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  const r = await fetch(url.toString(), {
    method,
    headers,
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(payload)
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 2000) }; }
  if (!r.ok) {
    throw new Error(`${config.label || 'Connector'} ${r.status}: ${text.slice(0, 300)}`);
  }

  return {
    summary: spec.summary ? fill(spec.summary, input) : `${action.replace(/_/g, ' ')} done`,
    url: (data && (data.url || data.link)) || undefined,
    data
  };
}
