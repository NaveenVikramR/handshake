// PayPal webhook events we act on (docs/PAYPAL.md § Webhooks).
import type { OrderStatus } from "@handshake/core";
import { z } from "zod";

// Envelope fields we use; the raw event is stored in full in paypal_events.
export const WebhookEvent = z.object({
  id: z.string().min(1).max(128),
  event_type: z.string().min(1).max(128),
  resource_type: z.string().optional(),
  create_time: z.string().optional(),
  resource: z.object({ id: z.string().min(1), status: z.string().optional() }).loose(),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

/** Which PayPal object the event is about; M7 resolves it to an orders row. */
export type PayPalRef = { kind: "authorization" | "capture" | "refund"; id: string };

export interface MappedOrderEvent {
  ref: PayPalRef;
  to: OrderStatus;
}

// Payments v2 sends PAYMENT.CAPTURE.DECLINED; v1/marketplaces docs list DENIED. Accept both.
// There is no authorization denied/expired event. CHECKOUT.ORDER.APPROVED, CAPTURE.PENDING and
// CAPTURE.REVERSED don't move our state machine; they are recorded and ignored.
const MAP: Record<string, { kind: PayPalRef["kind"]; to: OrderStatus }> = {
  "PAYMENT.AUTHORIZATION.CREATED": { kind: "authorization", to: "authorized" },
  "PAYMENT.AUTHORIZATION.VOIDED": { kind: "authorization", to: "voided" },
  "PAYMENT.CAPTURE.COMPLETED": { kind: "capture", to: "captured" },
  "PAYMENT.CAPTURE.DECLINED": { kind: "capture", to: "failed" },
  "PAYMENT.CAPTURE.DENIED": { kind: "capture", to: "failed" },
  "PAYMENT.CAPTURE.REFUNDED": { kind: "refund", to: "refunded" },
};

export function orderEventFor(event: WebhookEvent): MappedOrderEvent | undefined {
  const m = MAP[event.event_type];
  return m ? { ref: { kind: m.kind, id: event.resource.id }, to: m.to } : undefined;
}

export const HANDLED_EVENT_TYPES = Object.keys(MAP);
