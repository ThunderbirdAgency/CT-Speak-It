import { preflight } from "./_lib/http.js";
import { stripe, customerFor, configuredPrice } from "./_lib/billing.js";
import { origin, access } from "./_lib/account.js";
export default async function handler(req, res) {
  if (await preflight(req, res, undefined, { browser: true, meter: "billing" }))
    return;
  try {
    if (req.body?.action === "portal") {
      if (!req.account.stripe_customer_id)
        return res
          .status(400)
          .json({ error: "You do not have a paid billing account yet." });
      const customer = req.account.stripe_customer_id;
      const session = await stripe().billingPortal.sessions.create({
        customer,
        return_url: origin() + "/account",
      });
      return res.status(200).json({ url: session.url });
    }
    if (access(req.account).active)
      return res
        .status(409)
        .json({
          error:
            "You already have Pro access. Manage your membership in Billing.",
        });
    const customer = await customerFor(req.account);
    // Stripe is authoritative; do not open another subscription if a webhook is delayed.
    const existing = await stripe().subscriptions.list({
      customer,
      status: "all",
      limit: 100,
    });
    if (
      existing.data.some(
        (s) => !["canceled", "incomplete_expired"].includes(s.status),
      )
    )
      return res
        .status(409)
        .json({
          error:
            "A membership already exists. Use Manage billing to review it.",
        });
    const open = await stripe().checkout.sessions.list({
      customer,
      status: "open",
      limit: 10,
    });
    const prior = open.data.find(
      (s) =>
        s.mode === "subscription" &&
        s.metadata?.mockingbird_user === req.userId,
    );
    if (prior) return res.status(200).json({ url: prior.url });
    await configuredPrice();
    const session = await stripe().checkout.sessions.create(
      {
        mode: "subscription",
        customer,
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
        client_reference_id: req.userId,
        metadata: { mockingbird_user: req.userId },
        subscription_data: { metadata: { mockingbird_user: req.userId } },
        success_url: origin() + "/account?checkout=success",
        cancel_url: origin() + "/account?checkout=cancelled",
      },
      {
        idempotencyKey: `checkout-${customer}-${Math.floor(Date.now() / 1800000)}`,
      },
    );
    return res.status(200).json({ url: session.url });
  } catch {
    return res
      .status(503)
      .json({
        error:
          "Checkout is not available yet. No payment was taken. Gift codes can still be redeemed.",
      });
  }
}
