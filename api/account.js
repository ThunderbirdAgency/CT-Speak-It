import { preflight } from "./_lib/http.js";
import {
  access,
  isAdmin,
  cleanProfile,
  cleanSnippets,
  userFilter,
} from "./_lib/account.js";
import { sb } from "./_lib/log.js";
export default async function handler(req, res) {
  if (
    await preflight(req, res, "GET, PATCH, DELETE, OPTIONS", { browser: true })
  )
    return;
  try {
    if (req.method === "PATCH") {
      const body = req.body || {};
      const patch = {};
      if (typeof body.memory_enabled === "boolean")
        patch.memory_enabled = body.memory_enabled;
      if ("profile" in body) patch.profile = cleanProfile(body.profile);
      if ("snippets" in body) patch.snippets = cleanSnippets(body.snippets);
      await sb(`mockingbird_accounts?${userFilter(req.userId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      Object.assign(req.account, patch);
    }
    if (req.method === "DELETE") {
      // Erase personalization, including data from the previous logging implementation.
      await sb(`mockingbird_accounts?${userFilter(req.userId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          profile: {},
          memory_enabled: false,
          snippets: [],
        }),
      });
      for (const table of ["mockingbird_events", "mockingbird_profiles"]) {
        try {
          await sb(`${table}?${userFilter(req.userId)}`, { method: "DELETE" });
        } catch (err) {
          if (!/404/.test(err.message)) throw err;
        }
      }
      return res.status(200).json({ deleted: true });
    }
    const devices = await sb(
      `mockingbird_devices?${userFilter(req.userId)}&select=id,name,expires_at,revoked_at,created_at&revoked_at=is.null`,
    );
    const usage = await sb(
      `mockingbird_quotas?${userFilter(req.userId)}&day=eq.${new Date().toISOString().slice(0, 10)}&select=bucket,used`,
    );
    const { profile, memory_enabled, snippets } = req.account;
    return res
      .status(200)
      .json({
        profile,
        memory_enabled,
        snippets,
        access: access(req.account),
        devices,
        usage,
        admin: isAdmin(req.userId),
        billingAvailable: Boolean(
          process.env.STRIPE_SECRET_KEY &&
            process.env.STRIPE_PRICE_ID &&
            process.env.STRIPE_WEBHOOK_SECRET,
        ),
      });
  } catch (err) {
    return res
      .status(err.status || 503)
      .json({
        error: err.status
          ? err.message
          : "Could not update your account. Please try again.",
      });
  }
}
