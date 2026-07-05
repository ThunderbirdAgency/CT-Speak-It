/**
 * CT Speak-It — voice actions ("say it and it pops out").
 *
 * The host app registers its actions (create_open_house, add_task, log_note, ...)
 * as JSON schemas via SpeakIt.registerActions(). Spoken input is routed here and
 * Claude decides: is this a command (→ structured action object your dashboard
 * handler receives) or ordinary dictation (→ cleaned text inserted at the cursor)?
 *
 * The registered action schemas are passed to Claude as tools, so extraction is
 * schema-accurate without any per-app prompt engineering.
 *
 * Request:  POST { text, actions: [{name, description, input_schema}], appContext?, dictionary? }
 * Response: { kind: 'action', name, input } | { kind: 'dictation', text }
 */
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const SYSTEM_PROMPT = `You route raw voice-dictation transcripts inside a business app.

The user spoke into their microphone. Decide whether they issued one of the app's registered commands or were simply dictating text, then call exactly one tool.

When the speech matches a registered command:
- Extract every field the speaker mentioned. Resolve relative dates/times against the current date given below (e.g. "this Saturday" → the actual date, ISO format YYYY-MM-DD; times as HH:MM 24h).
- Apply the speaker's self-corrections ("2pm no wait 3pm" → 15:00).
- Clean up spoken fragments into presentable values (addresses title-cased, names capitalized).
- Put anything said that doesn't fit a field into a notes/description field if the schema has one.

When it does NOT clearly match a command, call "dictation" with the transcript cleaned up: remove filler words (um, uh, like), apply self-corrections, convert spoken punctuation ("period", "new line") to real characters, fix casing and homophones. Preserve the speaker's wording and meaning — never summarize or add content.

If the speaker's words are ambiguous between command and dictation, prefer dictation.`;

const DICTATION_TOOL = {
  name: 'dictation',
  description: 'The speech is ordinary dictation to be typed into the focused field, not one of the registered commands. Provide the cleaned-up transcript.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The cleaned transcript, ready to insert.' }
    },
    required: ['text']
  }
};

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

  const { text, actions = [], appContext = '', dictionary = [] } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing "text"' });
  if (text.length > 20000) return res.status(413).json({ error: 'Transcript too long' });
  if (!Array.isArray(actions) || actions.length > 40) {
    return res.status(400).json({ error: '"actions" must be an array of at most 40 items' });
  }

  const tools = actions
    .filter((a) => a && a.name && a.input_schema)
    .map((a) => ({
      name: String(a.name).slice(0, 64),
      description: String(a.description || a.name).slice(0, 1024),
      input_schema: a.input_schema
    }))
    .concat([DICTATION_TOOL]);

  const now = new Date();

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools,
      tool_choice: { type: 'any' },
      messages: [
        {
          role: 'user',
          content:
            `Current date/time: ${now.toISOString()} (${now.toUTCString()})\n` +
            (appContext ? `App context: ${appContext}\n` : '') +
            (dictionary.length ? `Names/terms the speaker uses (fix mishearings toward these): ${dictionary.slice(0, 200).join(', ')}\n` : '') +
            `\nRaw transcript:\n${text}`
        }
      ]
    });

    if (response.stop_reason === 'refusal') {
      return res.status(200).json({ kind: 'dictation', text });
    }

    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.name === 'dictation') {
      const cleaned = toolUse && toolUse.input && toolUse.input.text
        ? String(toolUse.input.text).trim()
        : text;
      return res.status(200).json({ kind: 'dictation', text: cleaned || text });
    }

    return res.status(200).json({
      kind: 'action',
      name: toolUse.name,
      input: toolUse.input || {}
    });
  } catch (err) {
    console.error('speakit actions error:', err);
    // Widget degrades to plain dictation on any non-200.
    return res.status(502).json({ error: 'Action resolution failed' });
  }
}
