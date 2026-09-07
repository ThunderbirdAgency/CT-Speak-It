import { authorize } from "./account.js";

export function corsHeaders(origin, methods) {
  const allowed = (
    process.env.ALLOWED_ORIGINS ||
    process.env.MOCKINGBIRD_PUBLIC_URL ||
    ""
  )
    .split(",")
    .map((s) => s.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : "null",
    "Access-Control-Allow-Methods": methods || "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Mockingbird-Lang, X-Mockingbird-User, X-SpeakIt-Lang",
    Vary: "Origin",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
export async function preflight(
  req,
  res,
  methods = "POST, OPTIONS",
  options = {},
) {
  for (const [k, v] of Object.entries(
    corsHeaders(req.headers.origin || "", methods),
  ))
    res.setHeader(k, v);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  if (
    !methods
      .split(",")
      .map((s) => s.trim())
      .includes(req.method)
  ) {
    res.status(405).json({ error: "Method not allowed" });
    return true;
  }
  if (options.open) return false;
  return !(await authorize(req, res, options));
}
