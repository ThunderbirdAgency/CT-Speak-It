/**
 * Tests for the server side: the connector registry, the Follow Up Boss
 * connector's request shapes, and the guards on custom HTTP connectors.
 *
 * No network — global fetch is stubbed, so these assert exactly what we would
 * put on the wire.
 *
 *   node test/server.mjs
 */
import assert from 'assert';
import { toolsFor, executeAction, availableConnectors } from '../api/_lib/connectors/index.js';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (err) { failures++; console.error('  ✗ ' + name + '\n    ' + err.message); }
}

/** Stub fetch and record what was sent. */
function stubFetch(responder) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null
    };
    calls.push(call);
    const result = responder(call) || {};
    return {
      ok: result.status ? result.status < 400 : true,
      status: result.status || 200,
      text: async () => JSON.stringify(result.data || {})
    };
  };
  return calls;
}

console.log('registry');
await check('both connector types are offered', () => {
  const types = availableConnectors().map((c) => c.type);
  assert.deepStrictEqual(types.sort(), ['custom', 'followupboss']);
});

await check("an app's own action name wins over a connector's", () => {
  const { routes } = toolsFor([
    { type: 'custom', id: 'a', label: 'A', config: { baseUrl: 'https://a.test', actions: [{ name: 'shared', description: 'd', input_schema: { type: 'object' }, path: '/a' }] } },
    { type: 'custom', id: 'b', label: 'B', config: { baseUrl: 'https://b.test', actions: [{ name: 'shared', description: 'd', input_schema: { type: 'object' }, path: '/b' }] } }
  ]);
  assert.strictEqual(routes.shared.id, 'a');
});

await check('an unrouted action is refused rather than guessed at', async () => {
  await assert.rejects(() => executeAction('nope', {}, []), /No connector is registered/);
});

console.log('follow up boss');
await check('a new contact is created with the name split and deduplicated', async () => {
  const calls = stubFetch(() => ({ data: { id: 42, name: 'Maria Lopez' } }));
  const result = await executeAction(
    'fub_create_person',
    { name: 'Maria Lopez', phone: '555-0142', email: 'maria@x.com', source: 'open house' },
    [{ type: 'followupboss', credentials: { apiKey: 'test-key' } }]
  );
  const create = calls[0];
  assert.match(create.url, /\/people\?deduplicate=true$/);
  assert.strictEqual(create.method, 'POST');
  assert.strictEqual(create.body.firstName, 'Maria');
  assert.strictEqual(create.body.lastName, 'Lopez');
  assert.strictEqual(create.body.phones[0].value, '555-0142');
  assert.strictEqual(create.body.emails[0].value, 'maria@x.com');
  assert.match(create.headers.Authorization, /^Basic /);
  assert.match(result.summary, /Maria Lopez/);
  assert.match(result.url, /people\/view\/42/);
});

await check('anything else said about them is logged as a note', async () => {
  const calls = stubFetch(() => ({ data: { id: 7 } }));
  await executeAction('fub_create_person', { name: 'John Doe', note: 'wants a 3 bed under 400' },
    [{ type: 'followupboss', credentials: { apiKey: 'k' } }]);
  const note = calls.find((c) => c.url.endsWith('/notes'));
  assert.ok(note, 'no note was written');
  assert.strictEqual(note.body.personId, 7);
  assert.match(note.body.body, /3 bed under 400/);
});

await check('a task resolves the person it was about', async () => {
  const calls = stubFetch((call) =>
    call.url.includes('/people?q=') ? { data: { people: [{ id: 9, name: 'Maria Lopez' }] } } : { data: { id: 3 } });
  const result = await executeAction(
    'fub_create_task',
    { title: 'Call about the disclosures', person: 'Maria Lopez', dueDate: '2026-09-07', dueTime: '09:30' },
    [{ type: 'followupboss', credentials: { apiKey: 'k' } }]
  );
  const task = calls.find((c) => c.url.endsWith('/tasks'));
  assert.strictEqual(task.body.personId, 9);
  assert.strictEqual(task.body.dueDate, '2026-09-07T09:30:00');
  assert.match(result.summary, /Maria Lopez/);
});

await check('a command about someone unknown fails loudly, not silently', async () => {
  stubFetch(() => ({ data: { people: [] } }));
  await assert.rejects(
    () => executeAction('fub_add_note', { person: 'Nobody', note: 'hi' },
      [{ type: 'followupboss', credentials: { apiKey: 'k' } }]),
    /No Follow Up Boss contact matches/
  );
});

await check('an upstream error reaches the user with its reason', async () => {
  stubFetch(() => ({ status: 401, data: { errorMessage: 'Invalid API key' } }));
  await assert.rejects(
    () => executeAction('fub_create_person', { name: 'X' },
      [{ type: 'followupboss', credentials: { apiKey: 'bad' } }]),
    /Follow Up Boss 401: Invalid API key/
  );
});

await check('a missing key is a setup message, not a stack trace', async () => {
  delete process.env.FOLLOWUPBOSS_API_KEY;
  await assert.rejects(
    () => executeAction('fub_create_person', { name: 'X' }, [{ type: 'followupboss', credentials: {} }]),
    /not connected/
  );
});

console.log('custom http');
const APU = {
  type: 'custom', id: 'apu', label: 'Agent Power Ups',
  config: {
    label: 'Agent Power Ups',
    baseUrl: 'https://apu.example.com',
    headers: { Authorization: 'Bearer t' },
    actions: [{
      name: 'create_open_house',
      description: 'Schedule an open house',
      input_schema: { type: 'object', properties: { address: { type: 'string' } } },
      method: 'POST',
      path: '/api/open-houses',
      body: { street: '{{address}}', guests: '{{count}}' },
      summary: 'Open house at {{address}}'
    }]
  }
};

await check('a product’s endpoint is called with its template filled in', async () => {
  const calls = stubFetch(() => ({ data: { url: 'https://apu.example.com/oh/1' } }));
  const result = await executeAction('create_open_house', { address: '123 Main St', count: 3 }, [APU]);
  assert.strictEqual(calls[0].url, 'https://apu.example.com/api/open-houses');
  assert.strictEqual(calls[0].body.street, '123 Main St');
  assert.strictEqual(calls[0].body.guests, 3, 'a whole-value placeholder should keep its type');
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer t');
  assert.strictEqual(result.summary, 'Open house at 123 Main St');
});

await check('plain http is refused', async () => {
  const insecure = JSON.parse(JSON.stringify(APU));
  insecure.config.baseUrl = 'http://apu.example.com';
  await assert.rejects(() => executeAction('create_open_house', { address: 'x' }, [insecure]), /HTTPS/);
});

await check('the server will not be pointed at a private address', async () => {
  const internal = JSON.parse(JSON.stringify(APU));
  internal.config.baseUrl = 'https://192.168.1.10';
  await assert.rejects(() => executeAction('create_open_house', { address: 'x' }, [internal]), /not allowed/);
});

await check('CONNECTOR_ALLOWED_HOSTS narrows it further when set', async () => {
  process.env.CONNECTOR_ALLOWED_HOSTS = 'thunderbird.com';
  await assert.rejects(() => executeAction('create_open_house', { address: 'x' }, [APU]), /CONNECTOR_ALLOWED_HOSTS/);
  delete process.env.CONNECTOR_ALLOWED_HOSTS;
});

await check('GET actions put their input in the query string', async () => {
  const lookup = JSON.parse(JSON.stringify(APU));
  lookup.config.actions = [{
    name: 'find_listing', description: 'd',
    input_schema: { type: 'object' }, method: 'GET', path: '/api/listings'
  }];
  const calls = stubFetch(() => ({ data: { results: [] } }));
  await executeAction('find_listing', { q: '123 Main' }, [lookup]);
  assert.strictEqual(calls[0].url, 'https://apu.example.com/api/listings?q=123+Main');
  assert.strictEqual(calls[0].body, null);
});

console.log(failures ? '\nFAILED' : '\nall good');
process.exit(failures ? 1 : 0);
