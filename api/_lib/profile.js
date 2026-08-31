/**
 * Mockingbird — the voice profile.
 *
 * Mockingbird gets better at supporting one particular agent by reading back
 * what it has already helped them do. Every so often, recent events are
 * distilled into a small, human-readable profile: how this person writes, the
 * words and names they use, who and what comes up repeatedly, and how they
 * work a deal. That profile is injected into the formatting and action prompts
 * so dictation comes out sounding like them and commands resolve to the right
 * person on the first try.
 *
 * Ground rules, deliberately:
 *   - It is entirely optional. No Supabase → no log, no profile, no change in
 *     behaviour. Clients can send { learn: false } per request to opt out.
 *   - MOCKINGBIRD_LEARNING=off disables it deployment-wide.
 *   - The user can read their own profile (GET /api/profile) and delete it
 *     (DELETE /api/profile) — nothing is inferred that we would not show them.
 *   - The distiller is told to stay on work: writing style, vocabulary,
 *     working patterns. Not personal characteristics.
 */
import Anthropic from '@anthropic-ai/sdk';
import { sb, supabaseConfigured } from './log.js';

const REFRESH_AFTER_EVENTS = 25;      // distill again once this many new events land
const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_EVENTS_PER_DISTILL = 200;

const cache = new Map();              // userId -> { at, profile }
const inFlight = new Set();           // userIds currently being distilled

export function learningEnabled() {
  return supabaseConfigured() && (process.env.MOCKINGBIRD_LEARNING || 'on').toLowerCase() !== 'off';
}

// ------------------------------------------------------------------- read

export async function getProfile(userId) {
  if (!userId || !learningEnabled()) return null;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.profile;
  try {
    const rows = await sb(`mockingbird_profiles?user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    const profile = (rows && rows[0]) || null;
    cache.set(userId, { at: Date.now(), profile });
    return profile;
  } catch (err) {
    console.error('mockingbird: profile read failed', err.message);
    return null;
  }
}

/**
 * The profile as a compact prompt block. Kept short on purpose — it steers the
 * model without drowning the actual transcript, and everything in it is
 * phrased as guidance, never as content to insert.
 */
export function profilePromptBlock(profile) {
  if (!profile || !profile.profile) return '';
  const p = profile.profile;
  const lines = [];
  if (p.writing_style) lines.push(`How they write: ${p.writing_style}`);
  if (p.phrases && p.phrases.length) lines.push(`Turns of phrase they actually use: ${p.phrases.slice(0, 12).join('; ')}`);
  if (p.vocabulary && p.vocabulary.length) lines.push(`Names/places/jargon to spell correctly: ${p.vocabulary.slice(0, 60).join(', ')}`);
  if (p.people && p.people.length) lines.push(`People they mention often: ${p.people.slice(0, 30).join(', ')}`);
  if (p.working_patterns && p.working_patterns.length) lines.push(`How they work: ${p.working_patterns.slice(0, 8).join('; ')}`);
  if (p.preferences && p.preferences.length) lines.push(`Preferences observed: ${p.preferences.slice(0, 8).join('; ')}`);
  if (!lines.length) return '';
  return (
    '\nWhat you have learned about this speaker from past dictations ' +
    '(use it to match their voice and resolve names — never to add content they did not say):\n' +
    lines.map((l) => '- ' + l).join('\n') + '\n'
  );
}

/** One call from the request path: fetch the profile and its prompt block. */
export async function profileContext(userId, allowed = true) {
  if (!allowed) return { profile: null, block: '' };
  const profile = await getProfile(userId);
  return { profile, block: profilePromptBlock(profile) };
}

// --------------------------------------------------------------- distill

const DISTILL_SYSTEM = `You maintain a working profile of one person so a voice assistant can support them better.

You are given that person's recent voice-dictation transcripts and the actions they issued inside their business software. Produce a profile that helps the assistant (a) write text that sounds like them, (b) spell the names and places they use, and (c) resolve their spoken commands to the right records the first time.

Rules:
- Report only what is directly evidenced in the transcripts. No speculation.
- Stay on work: writing style, vocabulary, recurring people/properties/clients, how they run their process, stated preferences.
- Never record sensitive personal characteristics (health, beliefs, politics, finances of the speaker, protected traits), gossip about third parties, or anything the speaker would be uncomfortable reading back.
- Keep every field short. This is a cheat sheet, not a dossier.
- If the evidence is thin, return fewer items rather than inventing them.`;

const PROFILE_TOOL = {
  name: 'profile',
  description: 'The distilled working profile for this speaker.',
  input_schema: {
    type: 'object',
    properties: {
      writing_style: {
        type: 'string',
        description: 'One or two sentences: sentence length, formality, greetings/sign-offs, punctuation habits, how they close a message.'
      },
      phrases: {
        type: 'array', items: { type: 'string' },
        description: 'Characteristic phrases they repeat, verbatim.'
      },
      vocabulary: {
        type: 'array', items: { type: 'string' },
        description: 'Proper nouns the recognizer should get right: neighborhoods, streets, brokerages, product names, jargon.'
      },
      people: {
        type: 'array', items: { type: 'string' },
        description: 'Names of people who come up repeatedly (clients, colleagues), as they say them.'
      },
      working_patterns: {
        type: 'array', items: { type: 'string' },
        description: 'How they run their work: routines, follow-up cadence, how they qualify and advance a deal, what they lead with.'
      },
      preferences: {
        type: 'array', items: { type: 'string' },
        description: 'Explicit preferences: formats, tone, tools, times of day, how they want things logged.'
      },
      summary: {
        type: 'string',
        description: 'Two or three plain sentences the person themselves could read: what you have learned about how they work.'
      }
    },
    required: ['summary']
  }
};

/**
 * Rebuild the profile from recent events. Safe to call often — it no-ops
 * unless there is enough new material, and only one distill per user runs at
 * a time inside a given function instance.
 */
export async function distill(userId, { force = false } = {}) {
  if (!userId || !learningEnabled() || inFlight.has(userId)) return null;
  inFlight.add(userId);
  try {
    const existing = await getProfile(userId);
    const events = await sb(
      `mockingbird_events?user_id=eq.${encodeURIComponent(userId)}` +
      `&select=created_at,app,kind,raw_text,output_text,actions,connector` +
      `&order=created_at.desc&limit=${MAX_EVENTS_PER_DISTILL}`
    );
    if (!events || events.length < 5) return null;

    if (!force && existing) {
      const age = Date.now() - new Date(existing.updated_at).getTime();
      const fresh = events.filter((e) => new Date(e.created_at) > new Date(existing.updated_at)).length;
      if (fresh < REFRESH_AFTER_EVENTS && age < REFRESH_AFTER_MS) return existing;
    }

    const transcript = events
      .slice()
      .reverse()
      .map((e) => {
        const when = String(e.created_at).slice(0, 16).replace('T', ' ');
        if (e.kind === 'action' && e.actions) {
          return `[${when}] (${e.app || 'app'}) said: "${(e.raw_text || '').slice(0, 600)}"\n   → actions: ${JSON.stringify(e.actions).slice(0, 800)}`;
        }
        return `[${when}] (${e.app || 'app'}) dictated: "${(e.output_text || e.raw_text || '').slice(0, 800)}"`;
      })
      .join('\n');

    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      system: DISTILL_SYSTEM,
      tools: [PROFILE_TOOL],
      tool_choice: { type: 'tool', name: 'profile' },
      messages: [{
        role: 'user',
        content:
          (existing && existing.profile
            ? `Previous profile (revise it — keep what still holds, drop what the recent evidence contradicts):\n${JSON.stringify(existing.profile).slice(0, 4000)}\n\n`
            : '') +
          `Recent activity for this speaker (${events.length} events, oldest first):\n${transcript.slice(0, 60000)}`
      }]
    });

    const block = response.content.find((b) => b.type === 'tool_use');
    if (!block) return existing;
    const profile = block.input || {};

    const row = {
      user_id: userId,
      profile,
      summary: profile.summary || '',
      events_seen: events.length,
      updated_at: new Date().toISOString()
    };
    await sb('mockingbird_profiles', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row)
    });
    cache.set(userId, { at: Date.now(), profile: row });
    return row;
  } catch (err) {
    console.error('mockingbird: profile distill failed', err.message);
    return null;
  } finally {
    inFlight.delete(userId);
  }
}

/**
 * Called at the end of a request. Kicks off a distill when the profile is
 * stale, without making the user wait for it.
 */
export function maybeRefresh(userId, allowed = true) {
  if (!userId || !allowed || !learningEnabled()) return;
  distill(userId).catch(() => { /* best effort */ });
}

export async function forgetProfile(userId) {
  if (!userId || !supabaseConfigured()) return false;
  await sb(`mockingbird_profiles?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'DELETE', headers: { Prefer: 'return=minimal' }
  });
  cache.delete(userId);
  return true;
}
