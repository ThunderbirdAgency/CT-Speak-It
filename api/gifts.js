import { randomBytes } from "node:crypto";
import { preflight } from "./_lib/http.js";
import { digest, rpc, isAdmin } from "./_lib/account.js";
import { sb } from "./_lib/log.js";
export default async function handler(req, res) {
  if (
    await preflight(req, res, "GET, POST, DELETE, OPTIONS", {
      browser: true,
      meter: "gift",
    })
  )
    return;
  try {
    const b = req.body || {};
    if (req.method === "POST" && b.action === "redeem") {
      const code = String(b.code || "")
        .toUpperCase()
        .replace(/\s/g, "");
      if (!/^MB-[A-F0-9]{24}$/.test(code))
        return res
          .status(400)
          .json({ error: "Check your gift code and try again." });
      let until;
      try {
        until = await rpc("mockingbird_redeem", {
          p_user: req.userId,
          p_hash: digest(code),
        });
      } catch {
        return res
          .status(400)
          .json({
            error:
              "That code is expired, unavailable, or has already been fully claimed.",
          });
      }
      return res
        .status(200)
        .json({
          giftUntil: until,
          message:
            "Mockingbird Pro is covered by Thunderbird. No card required.",
        });
    }
    if (!isAdmin(req.userId))
      return res
        .status(403)
        .json({ error: "Only the gift administrator can do that." });
    if (req.method === "GET")
      return res
        .status(200)
        .json({
          codes: await sb(
            "mockingbird_gift_codes?select=id,label,duration_days,max_uses,uses,expires_at,revoked_at&order=created_at.desc&limit=100",
          ),
        });
    if (req.method === "DELETE") {
      if (!/^[a-f0-9-]{36}$/.test(String(b.id)))
        return res.status(400).json({ error: "Invalid gift." });
      await sb(`mockingbird_gift_codes?id=eq.${b.id}`, {
        method: "PATCH",
        body: JSON.stringify({ revoked_at: new Date().toISOString() }),
      });
      return res.status(200).json({ revoked: true });
    }
    const days = Number(b.days || 365),
      uses = Number(b.uses || 1);
    if (
      !Number.isInteger(days) ||
      days < 1 ||
      days > 3650 ||
      !Number.isInteger(uses) ||
      uses < 1 ||
      uses > 10000
    )
      return res
        .status(400)
        .json({ error: "Choose 1–3,650 days and 1–10,000 recipients." });
    const code = "MB-" + randomBytes(12).toString("hex").toUpperCase();
    await sb("mockingbird_gift_codes", {
      method: "POST",
      body: JSON.stringify({
        code_hash: digest(code),
        label: String(b.label || "Thunderbird gift").slice(0, 120),
        duration_days: days,
        max_uses: uses,
        expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
        created_by: req.userId,
      }),
    });
    return res
      .status(201)
      .json({
        code,
        days,
        uses,
        message:
          "Copy this code now. It will not be shown again. Recipients have 90 days to claim it.",
      });
  } catch {
    return res
      .status(503)
      .json({ error: "Gift service is temporarily unavailable." });
  }
}
