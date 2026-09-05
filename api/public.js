import { preflight } from "./_lib/http.js";
import { configuredPrice } from "./_lib/billing.js";
let lastCheck = 0,
  ready = false;
export default async function handler(req, res) {
  if (await preflight(req, res, "GET, OPTIONS", { open: true })) return;
  if (Date.now() - lastCheck > 60000) {
    ready = false;
    try {
      await configuredPrice();
      ready = true;
    } catch {}
    lastCheck = Date.now();
  }
  const billingReady = ready;
  const safeURL = (s) => {
    try {
      const u = new URL(s);
      return u.protocol === "https:" && !u.username && !u.password
        ? u.href
        : null;
    } catch {
      return null;
    }
  };
  return res
    .status(200)
    .json({
      name: "Mockingbird",
      plan: {
        name: "Pro",
        amount: 15,
        currency: "USD",
        interval: "month",
        billingReady,
      },
      clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || "",
      hubUrl: safeURL(process.env.MOCKINGBIRD_HUB_URL),
      supportEmail: process.env.MOCKINGBIRD_SUPPORT_EMAIL || null,
      downloads: {
        mac: safeURL(process.env.MOCKINGBIRD_MAC_DOWNLOAD_URL),
        windows: safeURL(process.env.MOCKINGBIRD_WINDOWS_DOWNLOAD_URL),
      },
      mobileNative: false,
    });
}
