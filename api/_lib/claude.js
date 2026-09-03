/**
 * Mockingbird — one place that decides how we call Claude.
 *
 * Model and effort live here rather than in each endpoint so there is a single
 * line to change when a better model ships, and so the latency/quality
 * tradeoff of each path is a stated decision rather than an accident.
 *
 * Effort, by path:
 *   FAST      dictation polish and command routing. Someone is standing there
 *             with their cursor blinking — these must feel instant, the task is
 *             short, and a misread command is caught by the confirmation card
 *             before anything is written.
 *   THOROUGH  reserved for paths where nobody is waiting and being wrong is
 *             expensive.
 *   BACKGROUND the profile distiller — runs after the response has been sent.
 */
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-opus-5';

export const EFFORT = {
  FAST: 'low',
  THOROUGH: 'high',
  BACKGROUND: 'medium'
};

/**
 * What a caller is told when the deployment's Claude credentials are missing or
 * rejected. The upstream error goes to the function log, where an operator can
 * read it; it is not echoed to a public endpoint.
 */
export const SETUP_MESSAGE =
  "This deployment's ANTHROPIC_API_KEY is missing or was rejected by Claude. " +
  'Check it in the Vercel project settings, then redeploy.';

let client = null;

/**
 * The Anthropic client, built on first use. Constructing lazily means a
 * deployment that is missing its key fails with a sentence an operator can act
 * on, at the one endpoint that needed it — not with an import-time crash on
 * every route.
 */
export function claude() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY is not set on this deployment.');
    err.setup = true;
    throw err;
  }
  if (!client) client = new Anthropic();
  return client;
}

/** True when the failure is a missing/blocked credential rather than a blip. */
export function isSetupError(err) {
  return Boolean(err && (err.setup || err.status === 401 || err.status === 403));
}
