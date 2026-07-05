/**
 * CT Speak-It — Whisper-grade transcription proxy.
 *
 * Closes the accuracy gap with desktop dictation apps: instead of the browser's
 * built-in recognizer, audio is transcribed by a Whisper-class model. Deploy once,
 * point every build at it:
 *
 *   <script src="speakit.js" data-transcribe-endpoint="https://your-app.vercel.app/api/transcribe"></script>
 *
 * Set ONE of these env vars (checked in order — first match wins):
 *   GROQ_API_KEY      → whisper-large-v3-turbo on Groq (fastest, near-free)
 *   DEEPGRAM_API_KEY  → nova-3 on Deepgram
 *   OPENAI_API_KEY    → whisper-1 on OpenAI
 *
 * Request:  POST raw audio body (audio/webm etc.), X-SpeakIt-Lang header optional
 * Response: { text: string }
 */

export const config = { api: { bodyParser: false } };

function corsHeaders(origin) {
  const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const allowOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-SpeakIt-Lang'
  };
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Groq and OpenAI share the OpenAI audio/transcriptions wire format.
async function openaiCompatible(url, apiKey, model, audio, contentType, lang) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: contentType }), 'audio.webm');
  form.append('model', model);
  if (lang) form.append('language', lang.split('-')[0]);
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  if (!r.ok) throw new Error(`transcription upstream ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data.text || '').trim();
}

async function deepgram(apiKey, audio, contentType, lang) {
  const params = new URLSearchParams({ model: 'nova-3', smart_format: 'true' });
  if (lang) params.set('language', lang.split('-')[0]);
  const r = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': contentType },
    body: audio
  });
  if (!r.ok) throw new Error(`deepgram ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
}

export default async function handler(req, res) {
  const headers = corsHeaders(req.headers.origin || '');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const contentType = req.headers['content-type'] || 'audio/webm';
  const lang = req.headers['x-speakit-lang'] || '';

  let audio;
  try {
    audio = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Could not read audio body' });
  }
  if (!audio || audio.length < 100) return res.status(400).json({ error: 'Empty audio' });
  if (audio.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'Audio too large (25MB max)' });

  try {
    let text;
    if (process.env.GROQ_API_KEY) {
      text = await openaiCompatible(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        process.env.GROQ_API_KEY, 'whisper-large-v3-turbo', audio, contentType, lang
      );
    } else if (process.env.DEEPGRAM_API_KEY) {
      text = await deepgram(process.env.DEEPGRAM_API_KEY, audio, contentType, lang);
    } else if (process.env.OPENAI_API_KEY) {
      text = await openaiCompatible(
        'https://api.openai.com/v1/audio/transcriptions',
        process.env.OPENAI_API_KEY, 'whisper-1', audio, contentType, lang
      );
    } else {
      return res.status(501).json({
        error: 'No transcription provider configured. Set GROQ_API_KEY, DEEPGRAM_API_KEY, or OPENAI_API_KEY.'
      });
    }
    return res.status(200).json({ text });
  } catch (err) {
    console.error('speakit transcribe error:', err);
    return res.status(502).json({ error: 'Transcription failed' });
  }
}
