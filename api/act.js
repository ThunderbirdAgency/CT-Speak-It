/**
 * Mockingbird — action execution.
 *
 * /api/actions decides WHAT the speaker wants; this endpoint DOES it. Split in
 * two on purpose: the client gets to show the user exactly what is about to
 * happen and require a keypress before anything is written to their CRM.
 *
 * Credentials arrive with the request (from the desktop app's local settings or
 * an app's server) and are used for that call only — Mockingbird is a relay,
 * not a vault. A deployment serving a single team can instead set
 * FOLLOWUPBOSS_API_KEY and send connectors: ['followupboss'].
 *
 * Request:  POST { actions: [{name, input}] | {name, input}, connectors: [...],
 *                  user?, appContext?, transcript? }
 * Response: { results: [{ name, ok, summary, url?, text?, error? }] }
 */
import { logEvent } from './_lib/log.js';
import { preflight } from './_lib/http.js';
import { executeAction } from './_lib/connectors/index.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  const { connectors = [], user = null, appContext = '', transcript = '' } = req.body || {};
  let { actions } = req.body || {};
  if (actions && !Array.isArray(actions)) actions = [actions];
  if (!Array.isArray(actions) || !actions.length) {
    return res.status(400).json({ error: 'Missing "actions"' });
  }
  if (actions.length > 10) return res.status(400).json({ error: 'Too many actions in one request' });

  const startedAt = Date.now();
  const results = [];

  // Sequential on purpose: a spoken batch ("add John, then a task to call him")
  // often depends on the record created a moment earlier.
  for (const action of actions) {
    if (!action || !action.name) {
      results.push({ name: null, ok: false, error: 'Action is missing a name' });
      continue;
    }
    try {
      const result = await executeAction(action.name, action.input, connectors);
      results.push({
        name: action.name,
        ok: true,
        connector: result.connector,
        summary: result.summary,
        url: result.url,
        text: result.text,
        data: result.data
      });
    } catch (err) {
      console.error('mockingbird act error:', action.name, err.message);
      results.push({ name: action.name, ok: false, error: err.message });
    }
  }

  logEvent({
    app: appContext,
    user_id: user,
    kind: 'execute',
    raw_text: transcript || null,
    actions: actions.map((a) => ({ name: a.name, input: a.input })),
    connector: results.map((r) => r.connector).filter(Boolean)[0] || null,
    status: results.every((r) => r.ok) ? 'ok' : 'error',
    output_text: results.map((r) => r.summary || r.error).filter(Boolean).join('; ') || null,
    duration_ms: Date.now() - startedAt,
    meta: { results: results.map((r) => ({ name: r.name, ok: r.ok, error: r.error || undefined })) }
  });

  const anyOk = results.some((r) => r.ok);
  if (anyOk) return res.status(200).json({ results });
  // Nothing worked: put the reason in `error` too, so clients that only look at
  // the status code still have something to show the user.
  const firstError = results.map((r) => r.error).find(Boolean) || 'Action failed';
  return res.status(502).json({ results, error: firstError });
}
