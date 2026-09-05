import { preflight } from "./_lib/http.js";
export default async function handler(req, res) {
  if (
    await preflight(req, res, "GET, POST, OPTIONS", {
      open: req.method === "GET",
    })
  )
    return;
  return res.status(200).json({
    consumer: true,
    tools: [],
    connectors: [],
    requiresSignIn: true,
    configured: {
      transcription: Boolean(
        process.env.GROQ_API_KEY ||
          process.env.DEEPGRAM_API_KEY ||
          process.env.OPENAI_API_KEY,
      ),
      ai: Boolean(process.env.ANTHROPIC_API_KEY),
      accounts: Boolean(
        process.env.SUPABASE_URL &&
          process.env.SUPABASE_SERVICE_ROLE_KEY &&
          process.env.CLERK_SECRET_KEY,
      ),
    },
  });
}
