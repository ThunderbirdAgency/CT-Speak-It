/**
 * Mockingbird connector registry.
 *
 * A "connector spec" is what a client (desktop app, or one of our web builds)
 * sends to say which systems this user can act on:
 *
 *   { type: 'followupboss', credentials: { apiKey } }
 *   { type: 'custom', id: 'apu', label: 'Agent Power Ups',
 *     config: { baseUrl, headers, actions: [...] } }
 *
 * Credentials travel with the request and are never persisted here; the
 * deployment only ever holds the optional env fallbacks (FOLLOWUPBOSS_API_KEY),
 * so one Mockingbird deployment can serve every agent without becoming a
 * secret store.
 */
import * as followupboss from './followupboss.js';
import * as custom from './custom.js';

const MODULES = { followupboss, custom };

/** Connector types this deployment can talk to (for Settings UIs). */
export function availableConnectors() {
  return Object.values(MODULES).map((m) => ({
    type: m.id,
    label: m.label,
    credentialFields: m.credentialFields || []
  }));
}

/** Accepts strings ("followupboss") or full spec objects; drops anything unknown. */
export function normalizeSpecs(specs) {
  if (!Array.isArray(specs)) return [];
  return specs
    .map((s) => (typeof s === 'string' ? { type: s } : s))
    .filter((s) => s && MODULES[s.type])
    .slice(0, 10)
    .map((s) => ({
      type: s.type,
      id: s.id || s.type,
      label: s.label || MODULES[s.type].label,
      credentials: s.credentials || {},
      config: s.config || s
    }));
}

/**
 * Tool schemas for the given specs, plus the routing table that maps each tool
 * name back to the connector that owns it. Later specs never clobber an
 * earlier tool name — first registration wins, so an app's own actions keep
 * priority over connector actions.
 */
export function toolsFor(specs) {
  const tools = [];
  const routes = {};
  for (const spec of normalizeSpecs(specs)) {
    const mod = MODULES[spec.type];
    let list = [];
    try { list = mod.tools(spec.config) || []; } catch (e) { list = []; }
    for (const tool of list) {
      if (routes[tool.name]) continue;
      routes[tool.name] = spec;
      tools.push(tool);
    }
  }
  return { tools, routes };
}

/** True when this action name belongs to one of the given connector specs. */
export function ownerOf(name, specs) {
  return toolsFor(specs).routes[name] || null;
}

/**
 * Run one action. Returns { ok, connector, summary, url?, text?, data? } — the
 * summary is what the overlay shows and what the event log records, so keep it
 * short and human ("Task for Maria Lopez: call Monday").
 */
export async function executeAction(name, input, specs) {
  const spec = ownerOf(name, specs);
  if (!spec) throw new Error(`No connector is registered for "${name}".`);
  const mod = MODULES[spec.type];
  const result = await mod.execute(name, input || {}, spec.credentials, spec.config);
  return Object.assign({ ok: true, connector: spec.id, connectorLabel: spec.label }, result);
}
