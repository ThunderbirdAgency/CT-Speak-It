import Stripe from "stripe";
import { sb } from "./log.js";
import { digest, userFilter } from "./account.js";
let client;
export function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Billing unavailable");
  return (client ||= new Stripe(process.env.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 2,
    timeout: 15000,
    httpClient: Stripe.createFetchHttpClient(),
  }));
}
export async function customerFor(account) {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  const customer = await stripe().customers.create(
    { metadata: { mockingbird_user: account.user_id } },
    { idempotencyKey: "mockingbird-customer-" + digest(account.user_id) },
  );
  await sb(`mockingbird_accounts?${userFilter(account.user_id)}`, {
    method: "PATCH",
    body: JSON.stringify({ stripe_customer_id: customer.id }),
  });
  return customer.id;
}
export async function configuredPrice() {
  if (!process.env.STRIPE_PRICE_ID || !process.env.STRIPE_WEBHOOK_SECRET)
    throw new Error("Billing unavailable");
  const p = await stripe().prices.retrieve(process.env.STRIPE_PRICE_ID);
  if (
    !p.active ||
    p.type !== "recurring" ||
    p.recurring.interval !== "month" ||
    p.recurring.interval_count !== 1 ||
    p.currency !== "usd" ||
    p.unit_amount !== 1500
  )
    throw new Error(
      "Configure the $15 USD monthly Pro price before enabling checkout.",
    );
  return p;
}
