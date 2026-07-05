/**
 * Mockingbird — voice actions ("say it and it pops out").
 *
 * The host app registers its actions (create_contact, create_open_house,
 * add_task, ...) as JSON schemas via Mockingbird.registerActions(). Spoken input
 * is routed here and Claude decides: command(s) or ordinary dictation?
 *
 * One utterance can produce MULTIPLE actions — "just had an open house, three
 * people came through: John Doe 555-1234, Maria Lopez maria@x.com, ..." returns
 * one create_contact action per person.
 *
 * The registered schemas are passed to Claude as tools, so extraction is
 * schema-accurate without any per-app prompt engineering.
 *
 * Request:  POST { text, actions: [{name, description, input_schema}], appContext?, dictionary?, user? }
 * Response: { kind: 'actions', actions: [{name, input}, ...] } | { kind: 'dictation', text }
 */
import Anthropic from '@anthropic-ai/sdk';
import { logEvent } from './_lib/log.js';

const client = new Anthropic();

const SYSTEM_PROMPT = `You route raw voice-dictation transcripts inside a business app.

The user spoke into their microphone. Decide whether they issued one or more of the app's registered commands or were simply dictating text, then call the appropriate tool(s).

When the speech matches registered commands:
- The transcript may contain SEVERAL items ("three people came through: John..., Maria..., Sam...") — make one tool call per item, in the order spoken.
- Extract every field the speaker mentioned. Resolve relative dates/times against the current date given below (e.g. "this Saturday" → the actual date, ISO format YYYY-MM-DD; times as HH:MM 24h).
- Apply the speaker's self-corrections ("2pm no wait 3pm" → 15:00).
- Clean up spoken fragments into presentable values: addresses title-cased, names capitalized, phone numbers digits-formatted, spelled-out email addresses assembled ("maria at gmail dot com" → "maria@gmail.com").
- Put anything said that doesn't fit a field into a notes/description field if the schema has one.

When the speech does NOT clearly match any command, call "dictation" once with the transcript cleaned up: remove filler words (um, uh, like), apply self-corrections, convert spoken punctuation ("period", "new line") to real characters, fix casing and homophones. Preserve the speaker's wording and meaning — never summarize or add content.

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

  const { text, actions = [], appContext = '', dictionary = [], user = null } = req.body || {};
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
  const startedAt = Date.now();

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
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

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const matched = toolUses.filter((b) => b.name !== 'dictation');

    if (matched.length) {
      const result = {
        kind: 'actions',
        actions: matched.map((b) => ({ name: b.name, input: b.input || {} }))
      };
      logEvent({
        app: appContext, user_id: user, kind: 'action',
        raw_text: text, actions: result.actions,
        duration_ms: Date.now() - startedAt,
        meta: { model: response.model, action_count: result.actions.length }
      });
      return res.status(200).json(result);
    }

    const dictationBlock = toolUses.find((b) => b.name === 'dictation');
    const cleaned = dictationBlock && dictationBlock.input && dictationBlock.input.text
      ? String(dictationBlock.input.text).trim()
      : text;
    logEvent({
      app: appContext, user_id: user, kind: 'dictation',
      raw_text: text, output_text: cleaned,
      duration_ms: Date.now() - startedAt,
      meta: { model: response.model, via: 'actions' }
    });
    return res.status(200).json({ kind: 'dictation', text: cleaned || text });
  } catch (err) {
    console.error('mockingbird actions error:', err);
    // Widget degrades to plain dictation on any non-200.
    return res.status(502).json({ error: 'Action resolution failed' });
  }
}
