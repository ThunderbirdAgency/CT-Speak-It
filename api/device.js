import { randomBytes } from "node:crypto";
import { preflight } from "./_lib/http.js";
import { digest, rpc, userFilter, origin } from "./_lib/account.js";
import { sb } from "./_lib/log.js";
export default async function handler(req, res) {
  const exchange = req.method === "POST" && req.body?.action === "exchange";
  if (
    await preflight(req, res, "POST, DELETE, OPTIONS", {
      open: exchange,
      browser: !exchange,
      meter: exchange ? null : "device",
    })
  )
    return;
  try {
    if (exchange) {
      const code = String(req.body.code || "")
        .toUpperCase()
        .replace(/\s/g, "");
      if (!/^[A-F0-9]{32}$/.test(code))
        return res
          .status(400)
          .json({ error: "Paste the full connection code from your account." });
      const token = "mbd_" + randomBytes(32).toString("hex");
      let device;
      try {
        device = await rpc("mockingbird_pair", {
          p_hash: digest(code),
          p_token_hash: digest(token),
          p_name: String(req.body.name || "Desktop").slice(0, 80),
        });
      } catch {
        return res
          .status(400)
          .json({
            error:
              "Connection code expired or already used. Create another in your account.",
          });
      }
      return res.status(200).json({ ...device, token });
    }
    if (req.method === "DELETE") {
      if (!/^[a-f0-9-]{36}$/.test(String(req.body?.id)))
        return res.status(400).json({ error: "Invalid device." });
      await sb(
        `mockingbird_devices?${userFilter(req.userId)}&id=eq.${req.body.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ revoked_at: new Date().toISOString() }),
        },
      );
      return res.status(200).json({ revoked: true });
    }
    const code = randomBytes(16).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    await sb("mockingbird_pairings", {
      method: "POST",
      body: JSON.stringify({
        code_hash: digest(code),
        user_id: req.userId,
        expires_at: expiresAt,
      }),
    });
    return res
      .status(201)
      .json({ code, connectionCode: `${origin()}#${code}`, expiresAt });
  } catch {
    return res
      .status(503)
      .json({ error: "Could not connect this device. Please try again." });
  }
}
