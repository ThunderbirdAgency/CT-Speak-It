/**
 * Mockingbird — connector discovery.
 *
 * GET /api/tools                → connector types this deployment supports and
 *                                 the credentials each one needs (drives the
 *                                 desktop Settings screen).
 * POST /api/tools { connectors } → the actual voice commands those connectors
 *                                 expose, so a client can show the user what
 *                                 they can now say.
 */
import { preflight } from './_lib/http.js';
import { availableConnectors, toolsFor } from './_lib/connectors/index.js';

export default async function handler(req, res) {
  if (preflight(req, res, 'GET, POST, OPTIONS')) return;

  if (req.method === 'GET') {
    return res.status(200).json({
      connectors: availableConnectors(),
      // Handy for the desktop app's "is my deployment set up?" check.
      configured: {
        transcription: Boolean(process.env.GROQ_API_KEY || process.env.DEEPGRAM_API_KEY || process.env.OPENAI_API_KEY),
        ai: Boolean(process.env.ANTHROPIC_API_KEY),
        log: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
        followupbossEnv: Boolean(process.env.FOLLOWUPBOSS_API_KEY)
      }
    });
  }

  const { connectors = [] } = req.body || {};
  const { tools } = toolsFor(connectors);
  return res.status(200).json({
    tools: tools.map((t) => ({ name: t.name, description: t.description }))
  });
}
