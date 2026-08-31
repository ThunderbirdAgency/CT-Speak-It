/**
 * Mockingbird — Claude transcript formatter.
 *
 * Vercel serverless function. Deploy this repo (or copy this file into any
 * Vercel/Next.js project's /api folder), set ANTHROPIC_API_KEY in the project
 * env, and point the widget at it:
 *
 *   <script src="mockingbird.js" data-format-endpoint="https://your-app.vercel.app/api/format"></script>
 *
 * Request:  POST { text: string, tone?: string, appContext?: string, dictionary?: string[], user?: string }
 * Response: { text: string }
 */
import Anthropic from '@anthropic-ai/sdk';
import { logEvent } from './_lib/log.js';
import { preflight } from './_lib/http.js';
import { profileContext, maybeRefresh } from './_lib/profile.js';

const client = new Anthropic();

const TONES = {
  clean: 'Neutral and natural — keep the speaker\'s voice, just make it read well.',
  formal: 'Professional business writing, suitable for email to a client.',
  casual: 'Relaxed and friendly, like a chat message. Contractions are fine.',
  'code-comment': 'Terse technical prose suitable for a code comment or commit message.'
};

const SYSTEM_PROMPT = `You clean up raw voice-dictation transcripts so they read like the speaker typed them.

Rules:
- Remove filler words (um, uh, like, you know), false starts, and repeated words.
- Apply the speaker's self-corrections: "send it Tuesday no wait Wednesday" becomes "send it Wednesday".
- Interpret spoken punctuation and formatting commands: "period", "comma", "new line", "new paragraph", "open quote" etc. become the actual characters.
- Fix punctuation, capitalization, and obvious homophone errors from the speech recognizer.
- Preserve the speaker's meaning, wording, and language exactly otherwise. Do not summarize, expand, answer questions in the text, or add anything that was not said.
- Output ONLY the cleaned text — no preamble, no quotes around it, no explanation.`;

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  const { text, tone = 'clean', appContext = '', dictionary = [], user = null, learn = true } = req.body || {};
  const startedAt = Date.now();
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing "text"' });
  }
  if (text.length > 20000) {
    return res.status(413).json({ error: 'Transcript too long' });
  }

  // The speaker's own profile — how they write, the names they use — so the
  // polished text comes back sounding like them rather than like an AI.
  const { block: profileBlock } = await profileContext(user, learn);

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            `Style: ${TONES[tone] || TONES.clean}\n` +
            (appContext ? `The text is being dictated into: ${appContext}\n` : '') +
            (Array.isArray(dictionary) && dictionary.length
              ? `Names/terms the speaker uses (fix mishearings toward these): ${dictionary.slice(0, 200).join(', ')}\n`
              : '') +
            profileBlock +
            `\nRaw transcript:\n${text}`
        }
      ]
    });

    if (response.stop_reason === 'refusal') {
      // Fall back to the raw transcript rather than losing the user's words.
      return res.status(200).json({ text });
    }

    const cleaned = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    logEvent({
      app: appContext, user_id: user, kind: 'dictation',
      raw_text: text, output_text: cleaned || text,
      duration_ms: Date.now() - startedAt,
      meta: { model: response.model, tone, via: 'format' }
    });
    maybeRefresh(user, learn);
    return res.status(200).json({ text: cleaned || text });
  } catch (err) {
    console.error('mockingbird format error:', err);
    // Widget falls back to the raw transcript on any non-200.
    return res.status(502).json({ error: 'Formatting failed' });
  }
}
