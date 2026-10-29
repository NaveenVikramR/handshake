// One-off setup: make sure the sandbox REST app has a webhook pointing at the deployed merchant.
import { createHash } from "node:crypto";
import type { PayPalClient, PayPalWebhook } from "./client.js";

/** What onOrderEvent handles (webhooks/events.ts). Payments v2 sends DECLINED, v1 docs list DENIED: both. */
export const WEBHOOK_EVENT_TYPES = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
];

/** `<merchantUrl>/webhooks/paypal`; https only, since PayPal delivers to public HTTPS endpoints. */
export function webhookUrlFor(merchantUrl: string): string {
  let u: URL;
  try {
    u = new URL(merchantUrl);
  } catch {
    throw new Error("MERCHANT_URL is not a valid URL");
  }
  if (u.protocol !== "https:" || u.hostname === "localhost" || u.hostname.includes("<")) {
    throw new Error("MERCHANT_URL must be the public https URL of the deployed merchant");
  }
  return `${u.origin}/webhooks/paypal`;
}

export interface EnsureResult {
  webhook: PayPalWebhook;
  created: boolean;
  /** Event types we want that an existing webhook isn't subscribed to. */
  missing: string[];
}

/** Returns the webhook already registered for `url`, or creates it. */
export async function ensureWebhook(
  paypal: Pick<PayPalClient, "listWebhooks" | "createWebhook">,
  url: string,
  eventTypes: string[] = WEBHOOK_EVENT_TYPES,
): Promise<EnsureResult> {
  const existing = (await paypal.listWebhooks()).find((w) => w.url === url);
  if (existing) {
    const have = new Set((existing.event_types ?? []).map((e) => e.name));
    return { webhook: existing, created: false, missing: eventTypes.filter((e) => !have.has(e) && !have.has("*")) };
  }
  // Idempotency comes from listing first (PayPal doesn't document PayPal-Request-Id on this POST);
  // the id is still sent (rule 4) and is stable per url + events.
  const requestId = `webhook-${createHash("sha256")
    .update(`${url}|${eventTypes.join(",")}`)
    .digest("hex")
    .slice(0, 32)}`;
  return { webhook: await paypal.createWebhook(url, eventTypes, requestId), created: true, missing: [] };
}
