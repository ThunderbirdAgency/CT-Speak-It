import { createHash } from "node:crypto";
import { verifyToken } from "@clerk/backend";
import { sb, supabaseConfigured } from "./log.js";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const origin = () => {
  const value = process.env.MOCKINGBIRD_PUBLIC_URL || "";
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Public HTTPS URL is required.");
  return url.origin;
};
export const rpc = (name, body) =>
  sb(`rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
export const userFilter = (user) => `user_id=eq.${encodeURIComponent(user)}`;
export async function account(user) {
  const rows = await sb(`mockingbird_accounts?${userFilter(user)}&limit=1`);
  return (
    rows[0] || {
      user_id: user,
      memory_enabled: false,
      profile: {},
      snippets: [],
      gift_until: null,
    }
  );
}
export async function ensureAccount(user) {
  await sb("mockingbird_accounts", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: user }),
  });
  return account(user);
}
export function access(row) {
  const gift = Date.parse(row.gift_until) > Date.now();
  const paid =
    ["active", "trialing"].includes(row.subscription_status) &&
    Date.parse(row.paid_until) > Date.now();
  return {
    active: gift || paid,
    source: gift ? "gift" : paid ? "subscription" : "none",
    giftUntil: row.gift_until,
    paidUntil: row.paid_until,
    subscriptionStatus: row.subscription_status || null,
  };
}
export function isAdmin(user) {
  return (process.env.MOCKINGBIRD_ADMIN_USER_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .includes(user);
}
export async function authenticate(req) {
  if (!supabaseConfigured())
    throw Object.assign(new Error("Account service is not configured yet."), {
      status: 503,
    });
  const token = String(req.headers.authorization || "").replace(
    /^Bearer /i,
    "",
  );
  if (!token)
    throw Object.assign(new Error("Sign in to Mockingbird to continue."), {
      status: 401,
    });
  if (token.startsWith("mbd_")) {
    const rows = await sb(
      `mockingbird_devices?token_hash=eq.${digest(token)}&revoked_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
    );
    if (!rows.length)
      throw Object.assign(
        new Error("This device session expired. Please sign in again."),
        { status: 401 },
      );
    req.deviceId = rows[0].id;
    return rows[0].user_id;
  }
  if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_AUTHORIZED_PARTIES)
    throw Object.assign(new Error("Sign-in is not configured yet."), {
      status: 503,
    });
  try {
    const claims = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
      jwtKey: process.env.CLERK_JWT_KEY || undefined,
      authorizedParties: process.env.CLERK_AUTHORIZED_PARTIES.split(",").map(
        (x) => x.trim(),
      ),
    });
    if (!claims.sub || !claims.sid) throw new Error("Not a user session");
    return claims.sub;
  } catch {
    throw Object.assign(
      new Error("Your sign-in expired. Please sign in again."),
      { status: 401 },
    );
  }
}
export async function authorize(
  req,
  res,
  { paid = false, meter = null, browser = false } = {},
) {
  try {
    req.userId = await authenticate(req);
    if (browser && req.deviceId)
      throw Object.assign(
        new Error("Open your account in a browser for this change."),
        { status: 403 },
      );
    req.account = await ensureAccount(req.userId);
    if (paid && !access(req.account).active)
      throw Object.assign(
        new Error(
          "Activate Pro with a gift code or a membership in your account.",
        ),
        { status: 402 },
      );
    if (meter) {
      const allowed = await rpc("mockingbird_take_quota", {
        p_user: req.userId,
        p_bucket: meter,
        p_limit: meter === "voice" ? 240 : meter === "text" ? 500 : 20,
      });
      if (!allowed)
        throw Object.assign(
          new Error(
            "You have reached today’s usage limit. Please try again tomorrow.",
          ),
          { status: 429 },
        );
    }
    return true;
  } catch (err) {
    res
      .status(err.status || 503)
      .json({
        error: err.status
          ? err.message
          : "Account service is temporarily unavailable.",
      });
    return false;
  }
}
export function cleanProfile(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("Invalid memory."), { status: 400 });
  const list = (v, count, len) =>
    Array.isArray(v)
      ? [
          ...new Set(
            v
              .filter((x) => typeof x === "string")
              .map((x) => x.trim().slice(0, len))
              .filter(Boolean),
          ),
        ].slice(0, count)
      : [];
  return {
    writing_style: String(value.writing_style || "")
      .trim()
      .slice(0, 1000),
    vocabulary: list(value.vocabulary, 200, 100),
    phrases: list(value.phrases, 30, 300),
  };
}
export function cleanSnippets(value) {
  if (!Array.isArray(value) || value.length > 100)
    throw Object.assign(new Error("Use up to 100 saved responses."), {
      status: 400,
    });
  const snippets = value.map((x) => ({
    trigger: String(x.trigger || "")
      .trim()
      .toLowerCase()
      .slice(0, 80),
    text: String(x.text || "")
      .trim()
      .slice(0, 5000),
  }));
  if (
    snippets.some((x) => !x.trigger || !x.text) ||
    new Set(snippets.map((x) => x.trigger)).size !== snippets.length
  )
    throw Object.assign(
      new Error("Every response needs a unique phrase and text."),
      { status: 400 },
    );
  return snippets;
}
