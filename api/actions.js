import { preflight } from "./_lib/http.js";
export default async function handler(req, res) {
  if (await preflight(req, res)) return;
  return res
    .status(501)
    .json({
      error: "CRM actions are not available in this dictation release.",
    });
}
