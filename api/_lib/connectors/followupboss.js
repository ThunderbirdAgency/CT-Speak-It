/**
 * Mockingbird connector — Follow Up Boss.
 *
 * Turns spoken commands into real Follow Up Boss records: people, notes,
 * tasks, calls, appointments, stage changes. Credentials are supplied per
 * request by the client (desktop app config / app server) or fall back to
 * FOLLOWUPBOSS_API_KEY on the deployment — Mockingbird never stores them.
 *
 * API: https://api.followupboss.com/v1 — HTTP Basic auth, username = API key,
 * password empty. Registered integrations may also send X-System /
 * X-System-Key; set them in credentials if FUB issued you a system key.
 */

const BASE = 'https://api.followupboss.com/v1';

export const id = 'followupboss';
export const label = 'Follow Up Boss';

export const credentialFields = [
  { key: 'apiKey', label: 'API key', secret: true, required: true,
    help: 'Follow Up Boss → Admin → API → create key' },
  { key: 'system', label: 'X-System (optional)', secret: false, required: false },
  { key: 'systemKey', label: 'X-System-Key (optional)', secret: true, required: false }
];

// ---------------------------------------------------------------- transport

function authHeaders(creds) {
  const key = (creds && creds.apiKey) || process.env.FOLLOWUPBOSS_API_KEY;
  if (!key) throw new Error('Follow Up Boss is not connected — add an API key in Settings.');
  const headers = {
    Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'),
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  const system = (creds && creds.system) || process.env.FOLLOWUPBOSS_SYSTEM;
  const systemKey = (creds && creds.systemKey) || process.env.FOLLOWUPBOSS_SYSTEM_KEY;
  if (system) headers['X-System'] = system;
  if (systemKey) headers['X-System-Key'] = systemKey;
  return headers;
}

async function fub(method, path, creds, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: authHeaders(creds),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!r.ok) {
    const detail = (data && (data.errorMessage || data.message)) || text.slice(0, 300);
    const err = new Error(`Follow Up Boss ${r.status}: ${detail}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------ helpers

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return { firstName: parts.shift() || '', lastName: parts.join(' ') };
}

function personLabel(p) {
  return (p && (p.name || [p.firstName, p.lastName].filter(Boolean).join(' '))) || 'contact';
}

/**
 * Find the person a spoken command refers to. Speakers say names ("Maria
 * Lopez"), sometimes an email or phone. Returns null when nothing matches so
 * callers can decide between creating and failing.
 */
async function findPerson(query, creds) {
  const q = String(query || '').trim();
  if (!q) return null;
  const data = await fub('GET', `/people?q=${encodeURIComponent(q)}&limit=10&sort=-updated`, creds);
  const people = (data && data.people) || [];
  if (!people.length) return null;
  const lower = q.toLowerCase();
  // Prefer an exact name match over fuzzy search ranking.
  return people.find((p) => personLabel(p).toLowerCase() === lower) || people[0];
}

async function requirePerson(query, creds) {
  const person = await findPerson(query, creds);
  if (!person) throw new Error(`No Follow Up Boss contact matches "${query}".`);
  return person;
}

// Spoken dates arrive already resolved to ISO by the actions endpoint; combine
// an optional time so FUB gets a real timestamp.
function isoDateTime(date, time) {
  if (!date) return undefined;
  if (/T/.test(date)) return date;
  return `${date}T${(time || '09:00').slice(0, 5)}:00`;
}

// -------------------------------------------------------------------- tools

export function tools() {
  return [
    {
      name: 'fub_create_person',
      description:
        'Create a new contact/lead in Follow Up Boss. Trigger when the speaker gives a person\'s name with contact details or says they met or spoke to someone new. Several people in one utterance = one action per person.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Full name as spoken' },
          email: { type: 'string' },
          phone: { type: 'string' },
          stage: { type: 'string', description: 'FUB stage, e.g. Lead, Hot Prospect, Active Client' },
          source: { type: 'string', description: 'Where they came from, e.g. "open house at 123 Main St"' },
          tags: { type: 'array', items: { type: 'string' } },
          note: { type: 'string', description: 'Anything else said about them — logged as a note on the contact' }
        },
        required: ['name']
      }
    },
    {
      name: 'fub_add_note',
      description:
        'Log a note on an existing Follow Up Boss contact. Trigger on "note on X", "log that", "make a note about".',
      input_schema: {
        type: 'object',
        properties: {
          person: { type: 'string', description: 'Name, email, or phone of the contact' },
          subject: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['person', 'note']
      }
    },
    {
      name: 'fub_create_task',
      description:
        'Create a task/reminder in Follow Up Boss. Trigger on "remind me to", "add a task", "follow up with X on Monday".',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          person: { type: 'string', description: 'Contact the task is about, if one was named' },
          dueDate: { type: 'string', description: 'ISO date YYYY-MM-DD' },
          dueTime: { type: 'string', description: 'HH:MM 24h' }
        },
        required: ['title']
      }
    },
    {
      name: 'fub_log_call',
      description:
        'Log a phone call on a Follow Up Boss contact. Trigger on "just got off the phone with", "called X", "left a voicemail for X".',
      input_schema: {
        type: 'object',
        properties: {
          person: { type: 'string' },
          outcome: {
            type: 'string',
            enum: ['Interested', 'Not Interested', 'Left Message', 'No Answer', 'Bad Number', 'Talked'],
            description: 'Best match for how the call went'
          },
          note: { type: 'string', description: 'What was said' },
          durationMinutes: { type: 'number' }
        },
        required: ['person']
      }
    },
    {
      name: 'fub_create_appointment',
      description:
        'Book an appointment/showing on the Follow Up Boss calendar. Trigger on "showing at", "meeting with X", "open house Saturday at 2".',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          person: { type: 'string' },
          date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
          time: { type: 'string', description: 'HH:MM 24h start time' },
          durationMinutes: { type: 'number', description: 'Defaults to 60' },
          location: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['title', 'date']
      }
    },
    {
      name: 'fub_update_stage',
      description:
        'Move a Follow Up Boss contact to a different stage. Trigger on "move X to", "mark X as", "X went under contract".',
      input_schema: {
        type: 'object',
        properties: {
          person: { type: 'string' },
          stage: { type: 'string' }
        },
        required: ['person', 'stage']
      }
    },
    {
      name: 'fub_find_person',
      description:
        'Look up a Follow Up Boss contact and read back their details. Trigger on questions: "what\'s Maria\'s number", "pull up John Doe", "when did I last talk to X".',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Name, email, or phone' } },
        required: ['query']
      }
    }
  ];
}

// ------------------------------------------------------------------ execute

export async function execute(action, input, creds) {
  switch (action) {
    case 'fub_create_person': {
      const { firstName, lastName } = splitName(input.name);
      const body = {
        firstName,
        lastName,
        source: input.source || 'Mockingbird',
        tags: Array.isArray(input.tags) ? input.tags : undefined,
        stage: input.stage || undefined,
        emails: input.email ? [{ value: input.email, type: 'work' }] : undefined,
        phones: input.phone ? [{ value: input.phone, type: 'mobile' }] : undefined
      };
      // deduplicate=true merges into an existing contact instead of creating a
      // second record for someone the agent already knows.
      const person = await fub('POST', '/people?deduplicate=true', creds, body);
      if (input.note) {
        await fub('POST', '/notes', creds, {
          personId: person.id, subject: 'Voice note', body: input.note
        });
      }
      return {
        summary: `Added ${personLabel(person)} to Follow Up Boss`,
        url: `https://app.followupboss.com/2/people/view/${person.id}`,
        data: { id: person.id }
      };
    }

    case 'fub_add_note': {
      const person = await requirePerson(input.person, creds);
      await fub('POST', '/notes', creds, {
        personId: person.id,
        subject: input.subject || 'Voice note',
        body: input.note
      });
      return {
        summary: `Note added to ${personLabel(person)}`,
        url: `https://app.followupboss.com/2/people/view/${person.id}`,
        data: { personId: person.id }
      };
    }

    case 'fub_create_task': {
      const person = input.person ? await findPerson(input.person, creds) : null;
      const task = await fub('POST', '/tasks', creds, {
        name: input.title,
        personId: person ? person.id : undefined,
        dueDate: isoDateTime(input.dueDate, input.dueTime),
        isCompleted: false
      });
      return {
        summary: person
          ? `Task for ${personLabel(person)}: ${input.title}`
          : `Task: ${input.title}`,
        data: { id: task && task.id }
      };
    }

    case 'fub_log_call': {
      const person = await requirePerson(input.person, creds);
      await fub('POST', '/calls', creds, {
        personId: person.id,
        outcome: input.outcome || 'Talked',
        note: input.note || '',
        duration: input.durationMinutes ? Math.round(input.durationMinutes * 60) : undefined,
        isIncoming: false
      });
      return {
        summary: `Call logged on ${personLabel(person)}`,
        url: `https://app.followupboss.com/2/people/view/${person.id}`,
        data: { personId: person.id }
      };
    }

    case 'fub_create_appointment': {
      const person = input.person ? await findPerson(input.person, creds) : null;
      const start = isoDateTime(input.date, input.time);
      const minutes = input.durationMinutes || 60;
      const end = start
        ? new Date(new Date(start).getTime() + minutes * 60000).toISOString().slice(0, 19)
        : undefined;
      const appt = await fub('POST', '/appointments', creds, {
        title: input.title,
        start,
        end,
        location: input.location || undefined,
        description: input.description || undefined,
        invitees: person ? [{ personId: person.id }] : undefined
      });
      return {
        summary: `${input.title} booked${person ? ' with ' + personLabel(person) : ''}`,
        data: { id: appt && appt.id }
      };
    }

    case 'fub_update_stage': {
      const person = await requirePerson(input.person, creds);
      await fub('PUT', `/people/${person.id}`, creds, { stage: input.stage });
      return {
        summary: `${personLabel(person)} → ${input.stage}`,
        url: `https://app.followupboss.com/2/people/view/${person.id}`,
        data: { personId: person.id }
      };
    }

    case 'fub_find_person': {
      const person = await findPerson(input.query, creds);
      if (!person) return { summary: `No contact found for "${input.query}"`, data: null };
      const email = (person.emails && person.emails[0] && person.emails[0].value) || '';
      const phone = (person.phones && person.phones[0] && person.phones[0].value) || '';
      return {
        summary: [personLabel(person), phone, email, person.stage].filter(Boolean).join(' · '),
        // speak/insert-able answer for read-only lookups
        text: [personLabel(person), phone && `phone ${phone}`, email, person.stage && `stage ${person.stage}`]
          .filter(Boolean).join(', '),
        url: `https://app.followupboss.com/2/people/view/${person.id}`,
        data: { id: person.id }
      };
    }

    default:
      throw new Error(`Unknown Follow Up Boss action: ${action}`);
  }
}
