/**
 * Mockingbird — Whisper-grade transcription proxy.
 *
 * Closes the accuracy gap with desktop dictation apps: instead of the browser's
 * built-in recognizer, audio is transcribed by a Whisper-class model. Deploy once,
 * point every build at it:
 *
 *   <script src="mockingbird.js" data-transcribe-endpoint="https://your-app.vercel.app/api/transcribe"></script>
 *
 * Set ONE of these env vars (checked in order — first match wins):
 *   GROQ_API_KEY      → whisper-large-v3-turbo on Groq (fastest, near-free)
 *   DEEPGRAM_API_KEY  → nova-3 on Deepgram
 *   OPENAI_API_KEY    → whisper-1 on OpenAI
 *
 * Request:  POST raw audio body (audio/webm etc.), X-Mockingbird-Lang header optional
 * Response: { text: string }
 */

import { preflight } from "./_lib/http.js";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024)
      throw Object.assign(new Error("Audio too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Groq and OpenAI share the OpenAI audio/transcriptions wire format.
async function openaiCompatible(url, apiKey, model, audio, contentType, lang) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([audio], { type: contentType }),
    contentType.includes("mp4") ? "audio.m4a" : "audio.webm",
  );
  form.append("model", model);
  if (lang) form.append("language", lang.split("-")[0]);
  const r = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(35000),
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!r.ok) {
    const err = new Error(
      `transcription upstream ${r.status}: ${await r.text()}`,
    );
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  return (data.text || "").trim();
}

async function deepgram(apiKey, audio, contentType, lang) {
  const params = new URLSearchParams({ model: "nova-3", smart_format: "true" });
  if (lang) params.set("language", lang.split("-")[0]);
  const r = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    signal: AbortSignal.timeout(35000),
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": contentType },
    body: audio,
  });
  if (!r.ok) {
    const err = new Error(`deepgram ${r.status}: ${await r.text()}`);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  return (
    data.results?.channels?.[0]?.alternatives?.[0]?.transcript || ""
  ).trim();
}

export default async function handler(req, res) {
  if (await preflight(req, res, undefined, { paid: true, meter: "voice" }))
    return;

  const contentType = req.headers["content-type"] || "audio/webm";
  const lang =
    req.headers["x-mockingbird-lang"] || req.headers["x-speakit-lang"] || "";

  let audio;
  try {
    audio = await readRawBody(req);
  } catch (e) {
    return res
      .status(e.status || 400)
      .json({
        error:
          e.status === 413
            ? "Audio too large (4MB max). Please use a shorter recording."
            : "Could not read audio body",
      });
  }
  if (!audio || audio.length < 100)
    return res.status(400).json({ error: "Empty audio" });
  if (audio.length > 4 * 1024 * 1024)
    return res.status(413).json({ error: "Audio too large (4MB max)" });

  try {
    let text;
    if (process.env.GROQ_API_KEY) {
      text = await openaiCompatible(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        process.env.GROQ_API_KEY,
        "whisper-large-v3-turbo",
        audio,
        contentType,
        lang,
      );
    } else if (process.env.DEEPGRAM_API_KEY) {
      text = await deepgram(
        process.env.DEEPGRAM_API_KEY,
        audio,
        contentType,
        lang,
      );
    } else if (process.env.OPENAI_API_KEY) {
      text = await openaiCompatible(
        "https://api.openai.com/v1/audio/transcriptions",
        process.env.OPENAI_API_KEY,
        "whisper-1",
        audio,
        contentType,
        lang,
      );
    } else {
      return res.status(501).json({
        error:
          "No transcription provider configured. Set GROQ_API_KEY, DEEPGRAM_API_KEY, or OPENAI_API_KEY.",
      });
    }
    const trigger = text
      .toLowerCase()
      .trim()
      .replace(/[.!?]+$/, "")
      .replace(/^insert\s+/, "");
    const snippet = /^insert\s+/i.test(text)
      ? req.account.snippets?.find((s) => s.trigger === trigger)?.text
      : null;
    return res.status(200).json({ text, snippet: snippet || null });
  } catch (err) {
    console.error("mockingbird transcribe error:", err.status || "unavailable");
    // A rejected key is a deployment problem, not a bad recording — say so,
    // without repeating the provider's response to a public caller.
    if (err.status === 401 || err.status === 403) {
      return res.status(503).json({
        error:
          "This deployment's transcription key was rejected. Check GROQ_API_KEY " +
          "(or DEEPGRAM_API_KEY / OPENAI_API_KEY) in the project settings.",
      });
    }
    return res.status(502).json({ error: "Transcription failed" });
  }
}
