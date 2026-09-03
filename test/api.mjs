/**
 * End-to-end tests for the API as Vercel actually runs it.
 *
 * Every endpoint is invoked the way the platform invokes it — a request object
 * in, a response object out — against a local server standing in for Claude,
 * Groq, Supabase and Follow Up Boss. The Anthropic SDK really makes its HTTP
 * call here (via ANTHROPIC_BASE_URL), so this covers the request shape we
 * actually put on the wire, not a mock of it.
 *
 *   node test/api.mjs
 */
import assert from 'assert';
import http from 'http';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (err) { failures++; console.error('  ✗ ' + name + '\n    ' + err.message); }
}

// --------------------------------------------------------------- upstreams

const upstream = { anthropic: [], supabase: [], groq: [], fub: [] };
let claudeReplies = [];   // queued responses for successive Claude calls

function claudeMessage(content) {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 10, output_tokens: 10 }
  };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const json = () => { try { return JSON.parse(body); } catch (e) { return null; } };

    if (req.url.startsWith('/anthropic/v1/messages')) {
      upstream.anthropic.push(json());
      return send(200, claudeReplies.shift() || claudeMessage([{ type: 'text', text: 'ok' }]));
    }
    if (req.url.startsWith('/groq')) {
      upstream.groq.push({ url: req.url, length: body.length });
      return send(200, { text: 'um just met maria lopez five five five oh one four two' });
    }
    if (req.url.startsWith('/supabase/rest/v1/mockingbird_events')) {
      upstream.supabase.push({ table: 'events', method: req.method, body: json() });
      // The profile distiller reads rows back; PostgREST answers with an array.
      if (req.method === 'GET') return send(200, []);
      return send(201, {});
    }
    if (req.url.startsWith('/supabase/rest/v1/mockingbird_profiles')) {
      upstream.supabase.push({ table: 'profiles', method: req.method, url: req.url, body: json() });
      if (req.method === 'GET') {
        return send(200, [{
          user_id: 'erik', updated_at: '2026-09-01T10:00:00Z', events_seen: 42,
          summary: 'Writes short, warm follow-ups and always names the property.',
          profile: { writing_style: 'Short and warm.', vocabulary: ['Poinciana'], people: ['Maria Lopez'] }
        }]);
      }
      return send(200, {});
    }
    if (req.url.startsWith('/fub')) {
      upstream.fub.push({ url: req.url, method: req.method, body: json() });
      if (req.url.includes('/people?q=')) return send(200, { people: [{ id: 9, name: 'Maria Lopez' }] });
      return send(200, { id: 42, name: 'Maria Lopez' });
    }
    send(404, { error: 'unexpected upstream ' + req.url });
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// Endpoints that hardcode a vendor host get redirected to the fake; everything
// else (including the SDK's own call) goes through untouched.
const realFetch = global.fetch;
global.fetch = (url, init) => {
  const href = String(url);
  if (href.startsWith('https://api.groq.com')) return realFetch(base + '/groq', init);
  if (href.startsWith('https://api.followupboss.com')) {
    return realFetch(base + '/fub' + href.replace('https://api.followupboss.com/v1', ''), init);
  }
  return realFetch(url, init);
};

process.env.ANTHROPIC_BASE_URL = base + '/anthropic';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.SUPABASE_URL = base + '/supabase';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.GROQ_API_KEY = 'test-groq';
process.env.ALLOWED_ORIGINS = '*';

// ------------------------------------------------------------ vercel shims

function mockRes() {
  const res = {
    statusCode: null, headers: {}, body: undefined, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; this.ended = true; return this; },
    end() { this.ended = true; return this; }
  };
  return res;
}

function mockReq(method, { body, query, headers } = {}) {
  return { method, body, query: query || {}, headers: Object.assign({ origin: 'https://crm.test' }, headers || {}) };
}

/** transcribe reads the raw body by iterating the request. */
function mockAudioReq(buffer, headers) {
  const req = mockReq('POST', { headers: Object.assign({ 'content-type': 'audio/webm' }, headers || {}) });
  req[Symbol.asyncIterator] = async function* () { yield buffer; };
  return req;
}

const { default: tools } = await import('../api/tools.js');
const { default: format } = await import('../api/format.js');
const { default: actions } = await import('../api/actions.js');
const { default: act } = await import('../api/act.js');
const { default: transcribe } = await import('../api/transcribe.js');
const { default: profile } = await import('../api/profile.js');

const FUB = [{ type: 'followupboss', credentials: { apiKey: 'fub-test-key' } }];
const settle = () => new Promise((r) => setTimeout(r, 60)); // let fire-and-forget logging land

// ------------------------------------------------------------------- tests

console.log('deployment health');
await check('GET /api/tools reports what this deployment can do', async () => {
  const res = mockRes();
  await tools(mockReq('GET'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.configured.ai, true);
  assert.strictEqual(res.body.configured.transcription, true);
  assert.strictEqual(res.body.configured.log, true);
  assert.ok(res.body.connectors.some((c) => c.type === 'followupboss'));
});

await check('CORS preflight is answered for browsers', async () => {
  const res = mockRes();
  await format(mockReq('OPTIONS'), res);
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.headers['access-control-allow-origin'], '*');
});

console.log('dictation');
await check('POST /api/transcribe turns audio into words', async () => {
  const res = mockRes();
  await transcribe(mockAudioReq(Buffer.alloc(500, 1), { 'x-mockingbird-lang': 'en-US' }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.body.text, /maria lopez/);
  assert.ok(upstream.groq.length, 'groq was not called');
});

await check('POST /api/format polishes and logs it', async () => {
  claudeReplies = [claudeMessage([{ type: 'text', text: 'Just met Maria Lopez, 555-0142.' }])];
  const res = mockRes();
  await format(mockReq('POST', { body: { text: 'um just met maria lopez five five five oh one four two', user: 'erik' } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.text, 'Just met Maria Lopez, 555-0142.');
  await settle();
  const logged = upstream.supabase.find((c) => c.table === 'events' && c.body && c.body.kind === 'dictation');
  assert.ok(logged, 'no dictation event was logged');
  assert.strictEqual(logged.body.user_id, 'erik');
});

await check('the request we send Claude is the one we meant to send', () => {
  const sent = upstream.anthropic.at(-1);
  assert.strictEqual(sent.model, 'claude-opus-5');
  assert.strictEqual(sent.output_config.effort, 'low', 'the polish path must stay fast');
  assert.ok(sent.system.includes('voice-dictation'), 'system prompt missing');
});

await check("the speaker's learned profile reaches the prompt", () => {
  const sent = upstream.anthropic.at(-1);
  const text = sent.messages[0].content;
  assert.match(text, /Short and warm/, 'writing style not passed through');
  assert.match(text, /Poinciana/, 'learned vocabulary not passed through');
});

console.log('commands');
await check('POST /api/actions returns a connector action to confirm', async () => {
  claudeReplies = [claudeMessage([{
    type: 'tool_use', id: 'tu_1', name: 'fub_create_person',
    input: { name: 'Maria Lopez', phone: '555-0142' }
  }])];
  const res = mockRes();
  await actions(mockReq('POST', { body: {
    text: 'add maria lopez 555 0142', connectors: FUB, user: 'erik', mode: 'command'
  } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.kind, 'actions');
  const [action] = res.body.actions;
  assert.strictEqual(action.name, 'fub_create_person');
  assert.strictEqual(action.execute, true, 'must be marked for Mockingbird to run');
  assert.strictEqual(action.connectorLabel, 'Follow Up Boss');
});

await check('the connector tools were offered to Claude', () => {
  const sent = upstream.anthropic.at(-1);
  const names = sent.tools.map((t) => t.name);
  assert.ok(names.includes('fub_create_person'), 'connector tools missing');
  assert.ok(names.includes('dictation'), 'the dictation escape hatch must always be offered');
});

await check('ordinary speech still comes back as dictation', async () => {
  claudeReplies = [claudeMessage([{
    type: 'tool_use', id: 'tu_2', name: 'dictation',
    input: { text: 'Send the disclosures tomorrow.' }
  }])];
  const res = mockRes();
  await actions(mockReq('POST', { body: { text: 'send the disclosures tomorrow', connectors: FUB } }), res);
  assert.strictEqual(res.body.kind, 'dictation');
  assert.strictEqual(res.body.text, 'Send the disclosures tomorrow.');
});

await check('POST /api/act writes it to Follow Up Boss and logs it', async () => {
  const res = mockRes();
  await act(mockReq('POST', { body: {
    actions: [{ name: 'fub_create_person', input: { name: 'Maria Lopez', phone: '555-0142' } }],
    connectors: FUB, user: 'erik', transcript: 'add maria lopez'
  } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.results[0].ok, true);
  assert.match(res.body.results[0].summary, /Maria Lopez/);
  const created = upstream.fub.find((c) => c.method === 'POST' && c.url.includes('/people'));
  assert.ok(created, 'no contact was created upstream');
  assert.strictEqual(created.body.firstName, 'Maria');
  await settle();
  const logged = upstream.supabase.find((c) => c.table === 'events' && c.body && c.body.kind === 'execute');
  assert.ok(logged, 'the executed action was not logged');
  assert.strictEqual(logged.body.status, 'ok');
});

console.log('the profile, in the open');
await check('GET /api/profile shows a person what was learned', async () => {
  const res = mockRes();
  await profile(mockReq('GET', { query: { user: 'erik' } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.enabled, true);
  assert.match(res.body.summary, /warm follow-ups/);
});

await check('DELETE /api/profile erases it', async () => {
  const res = mockRes();
  await profile(mockReq('DELETE', { query: { user: 'erik' } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.deleted, true);
  const del = upstream.supabase.find((c) => c.table === 'profiles' && c.method === 'DELETE');
  assert.ok(del, 'nothing was deleted upstream');
  assert.match(del.url, /user_id=eq\.erik/);
});

console.log('a half-configured deployment says so');
await check('a missing ANTHROPIC_API_KEY is a sentence an operator can act on', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  // Reimport with a cache-buster so the module builds a fresh client.
  const { default: freshFormat } = await import('../api/format.js?nokey=1');
  const res = mockRes();
  await freshFormat(mockReq('POST', { body: { text: 'hello' } }), res);
  process.env.ANTHROPIC_API_KEY = saved;
  assert.strictEqual(res.statusCode, 503);
  assert.match(res.body.error, /ANTHROPIC_API_KEY/);
});

await check('a transcription request with no provider configured explains itself', async () => {
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  const res = mockRes();
  await transcribe(mockAudioReq(Buffer.alloc(500, 1)), res);
  process.env.GROQ_API_KEY = saved;
  assert.strictEqual(res.statusCode, 501);
  assert.match(res.body.error, /GROQ_API_KEY/);
});

console.log('access key');
await check('with a key configured, an unauthenticated request is refused', async () => {
  process.env.MOCKINGBIRD_ACCESS_KEY = 'sekrit';
  const res = mockRes();
  await format(mockReq('POST', { body: { text: 'hello' } }), res);
  assert.strictEqual(res.statusCode, 401);
  assert.match(res.body.error, /access key/i);
});

await check('the right key gets through', async () => {
  claudeReplies = [claudeMessage([{ type: 'text', text: 'Hello.' }])];
  const res = mockRes();
  await format(mockReq('POST', {
    body: { text: 'hello' }, headers: { 'x-mockingbird-key': 'sekrit' }
  }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.text, 'Hello.');
});

await check('a near-miss key is still refused', async () => {
  const res = mockRes();
  await format(mockReq('POST', {
    body: { text: 'hello' }, headers: { 'x-mockingbird-key': 'sekri' }
  }), res);
  assert.strictEqual(res.statusCode, 401);
});

await check('the health check still answers, and says a key is needed', async () => {
  const res = mockRes();
  await tools(mockReq('GET'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.requiresKey, true);
  delete process.env.MOCKINGBIRD_ACCESS_KEY;
});

server.close();
console.log(failures ? '\nFAILED' : '\nall good');
process.exit(failures ? 1 : 0);
