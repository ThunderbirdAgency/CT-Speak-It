import { stripe } from "./_lib/billing.js";
import { sb } from "./_lib/log.js";
import { userFilter } from "./_lib/account.js";
export const config = { api: { bodyParser: false } };
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  let event;
  try {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1024 * 1024) throw new Error("Too large");
      chunks.push(c);
    }
    event = stripe().webhooks.constructEvent(
      Buffer.concat(chunks),
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return res.status(400).json({ error: "Invalid webhook signature" });
  }
  try {
    if (event.type.startsWith("customer.subscription.")) {
      const sub = await stripe().subscriptions.retrieve(event.data.object.id);
      const user = sub.metadata?.mockingbird_user;
      if (!user) return res.status(200).json({ received: true });
      const customer =
        typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const rows = await sb(
        `mockingbird_accounts?${userFilter(user)}&stripe_customer_id=eq.${encodeURIComponent(customer)}&limit=1`,
      );
      if (!rows.length) return res.status(200).json({ received: true });
      const recognized = sub.items.data.filter(
        (x) => x.price.id === process.env.STRIPE_PRICE_ID,
      );
      const until = Math.max(
        0,
        ...recognized.map(
          (i) => i.current_period_end || sub.current_period_end || 0,
        ),
      );
      // Replays are harmless. A stale event cannot overwrite a newer event's projection.
      await sb(
        `mockingbird_accounts?${userFilter(user)}&billing_event_at=lte.${event.created}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            stripe_subscription_id: sub.id,
            subscription_status: recognized.length
              ? sub.status
              : "unrecognized",
            paid_until: until ? new Date(until * 1000).toISOString() : null,
            billing_event_at: event.created,
          }),
        },
      );
    }
    return res.status(200).json({ received: true });
  } catch {
    return res.status(503).json({ error: "Please retry this event" });
  }
}
