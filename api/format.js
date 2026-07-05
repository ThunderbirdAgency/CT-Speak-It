/**
 * CT Speak-It — AI transcript formatter ("Flow formatting").
 *
 * Vercel serverless function. Deploy this repo (or copy this file into any
 * Vercel/Next.js project's /api folder), set ANTHROPIC_API_KEY in the project
 * env, and point the widget at it:
 *
 *   <script src="speakit.js" data-format-endpoint="https://your-app.vercel.app/api/format"></script>
 *
 * Request:  POST { text: string, tone?: string, appContext?: string }
 * Response: { text: string }
 */
import Anthropic from '@anthropic-ai/sdk';

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

// CORS is open by default so the same deployment can serve all of your builds.
// Lock it down by setting ALLOWED_ORIGINS="https://app1.com,https://app2.com".
function corsHeaders(origin) {
  const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const allowOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

export default async function handler(req, res) {
  const headers = corsHeaders(req.headers.origin || '');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { text, tone = 'clean', appContext = '' } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing "text"' });
  }
  if (text.length > 20000) {
    return res.status(413).json({ error: 'Transcript too long' });
  }

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

    return res.status(200).json({ text: cleaned || text });
  } catch (err) {
    console.error('speakit format error:', err);
    // Widget falls back to the raw transcript on any non-200.
    return res.status(502).json({ error: 'Formatting failed' });
  }
}
