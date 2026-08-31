/**
 * Mockingbird — voice actions ("say it and it happens").
 *
 * Two sources of actions are merged into one decision:
 *   1. Actions the host app registers (Mockingbird.registerActions) — things
 *      that app can do in its own UI.
 *   2. Connectors the user has enabled (Follow Up Boss, custom HTTP endpoints
 *      for our own builds) — things Mockingbird can do on their behalf from
 *      anywhere, including the desktop app with no browser involved.
 *
 * Claude decides: command(s), a lookup, or ordinary dictation. One utterance
 * can produce MULTIPLE actions — "three people came through: John…, Maria…,
 * Sam…" returns one create action per person. Connector-owned actions come
 * back marked with `connector` and `execute: true`; the client confirms and
 * POSTs them to /api/act.
 *
 * Request:  POST {
 *   text, actions?: [{name, description, input_schema}],
 *   connectors?: [{type, id?, label?, credentials?, config?}] | ['followupboss'],
 *   mode?: 'auto' | 'command', appContext?, dictionary?, user?, tone?, learn?
 * }
 * Response: { kind: 'actions', actions: [{name, input, connector?, execute?}] }
 *         | { kind: 'dictation', text }
 */
import Anthropic from '@anthropic-ai/sdk';
import { logEvent } from './_lib/log.js';
import { preflight } from './_lib/http.js';
import { toolsFor } from './_lib/connectors/index.js';
import { profileContext, maybeRefresh } from './_lib/profile.js';

const client = new Anthropic();

const SYSTEM_PROMPT = `You route raw voice-dictation transcripts for someone running their business by voice.

The user spoke into their microphone — while writing an email, working in their CRM, or with any application in front of them. Decide whether they issued one or more of the available commands or were simply dictating text, then call the appropriate tool(s).

When the speech matches available commands:
- The transcript may contain SEVERAL items ("three people came through: John..., Maria..., Sam...") — make one tool call per item, in the order spoken.
- Extract every field the speaker mentioned. Resolve relative dates/times against the current date given below (e.g. "this Saturday" → the actual date, ISO format YYYY-MM-DD; times as HH:MM 24h).
- Apply the speaker's self-corrections ("2pm no wait 3pm" → 15:00).
- Clean up spoken fragments into presentable values: addresses title-cased, names capitalized, phone numbers digits-formatted, spelled-out email addresses assembled ("maria at gmail dot com" → "maria@gmail.com").
- Put anything said that doesn't fit a field into a notes/description field if the schema has one.

When the speech does NOT clearly match any command, call "dictation" once with the transcript cleaned up: remove filler words (um, uh, like), apply self-corrections, convert spoken punctuation ("period", "new line") to real characters, fix casing and homophones. Preserve the speaker's wording and meaning — never summarize or add content.

Judging command vs dictation:
- A command is addressed TO the assistant about the speaker's systems ("add John Doe to the CRM", "remind me to call Maria Monday", "log that showing").
- Dictation is text meant for whatever they are typing into — an email, a message, a document — even when it mentions people, dates, or the same nouns a command would.
- If the speaker's words are ambiguous between command and dictation, prefer dictation. Words that end up in the wrong email are a nuisance; a record created by accident is worse.`;

const COMMAND_MODE_NOTE = `
The speaker explicitly invoked command mode for this utterance — they pressed the command hotkey or addressed the assistant by name. Prefer a command interpretation, and only fall back to "dictation" when nothing they said maps to an available tool.`;

const DICTATION_TOOL = {
  name: 'dictation',
  description: 'The speech is ordinary dictation to be typed where the cursor is, not one of the available commands. Provide the cleaned-up transcript.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The cleaned transcript, ready to insert.' }
    },
    required: ['text']
  }
};

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  const {
    text, actions = [], connectors = [], mode = 'auto',
    appContext = '', dictionary = [], user = null, learn = true
  } = req.body || {};

  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing "text"' });
  if (text.length > 20000) return res.status(413).json({ error: 'Transcript too long' });
  if (!Array.isArray(actions) || actions.length > 40) {
    return res.status(400).json({ error: '"actions" must be an array of at most 40 items' });
  }

  // App-registered actions first so they keep priority over connector tools of
  // the same name; the dictation escape hatch is always last.
  const appTools = actions
    .filter((a) => a && a.name && a.input_schema)
    .map((a) => ({
      name: String(a.name).slice(0, 64),
      description: String(a.description || a.name).slice(0, 1024),
      input_schema: a.input_schema
    }));

  const { tools: connectorTools, routes } = toolsFor(connectors);
  const appNames = new Set(appTools.map((t) => t.name));
  const tools = appTools
    .concat(connectorTools.filter((t) => !appNames.has(t.name)))
    .concat([DICTATION_TOOL]);

  if (tools.length === 1) {
    // Nothing registered — there is no decision to make.
    return res.status(400).json({ error: 'No actions or connectors provided' });
  }

  const now = new Date();
  const startedAt = Date.now();
  const { block: profileBlock } = await profileContext(user, learn);

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      system: SYSTEM_PROMPT + (mode === 'command' ? COMMAND_MODE_NOTE : ''),
      tools,
      tool_choice: { type: 'any' },
      messages: [
        {
          role: 'user',
          content:
            `Current date/time: ${now.toISOString()} (${now.toUTCString()})\n` +
            (appContext ? `What is in front of the speaker: ${appContext}\n` : '') +
            (dictionary.length ? `Names/terms the speaker uses (fix mishearings toward these): ${dictionary.slice(0, 200).join(', ')}\n` : '') +
            profileBlock +
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
      const list = matched.map((b) => {
        const owner = routes[b.name];
        return {
          name: b.name,
          input: b.input || {},
          // Connector actions are executed by Mockingbird via /api/act; app
          // actions are handed to the app's own handler.
          connector: owner ? owner.id : null,
          connectorLabel: owner ? owner.label : null,
          execute: Boolean(owner)
        };
      });
      logEvent({
        app: appContext, user_id: user, kind: 'action',
        raw_text: text, actions: list,
        duration_ms: Date.now() - startedAt,
        meta: { model: response.model, action_count: list.length, mode }
      });
      maybeRefresh(user, learn);
      return res.status(200).json({ kind: 'actions', actions: list });
    }

    const dictationBlock = toolUses.find((b) => b.name === 'dictation');
    const cleaned = dictationBlock && dictationBlock.input && dictationBlock.input.text
      ? String(dictationBlock.input.text).trim()
      : text;
    logEvent({
      app: appContext, user_id: user, kind: 'dictation',
      raw_text: text, output_text: cleaned,
      duration_ms: Date.now() - startedAt,
      meta: { model: response.model, via: 'actions', mode }
    });
    maybeRefresh(user, learn);
    return res.status(200).json({ kind: 'dictation', text: cleaned || text });
  } catch (err) {
    console.error('mockingbird actions error:', err);
    // Widget degrades to plain dictation on any non-200.
    return res.status(502).json({ error: 'Action resolution failed' });
  }
}
