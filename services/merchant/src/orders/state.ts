// Order state machine (SPEC §7.1). The only way an order's status changes.
// Events are confirmations from the PayPal API response or a verified webhook,
// so each one names the status PayPal now reports.
import type { OrderStatus } from "@handshake/core";

export type OrderEventSource = "api" | "webhook";

export interface OrderEvent {
  to: OrderStatus;
  source: OrderEventSource;
}

// failed is reachable only while no money has been taken: a captured order
// holds the buyer's money and leaves that state only by refund (DECISIONS D15).
const NEXT: Record<OrderStatus, readonly OrderStatus[]> = {
  offered: ["authorized", "failed"],
  authorized: ["captured", "voided", "failed"],
  captured: ["refunded"],
  refunded: [],
  voided: [],
  failed: [],
};

// States an order has necessarily passed through. A confirmation for one of
// these arriving late (webhooks are unordered, and usually follow the API
// response) is stale and ignored rather than treated as an error.
const PASSED: Record<OrderStatus, readonly OrderStatus[]> = {
  offered: [],
  authorized: ["offered"],
  captured: ["offered", "authorized"],
  refunded: ["offered", "authorized", "captured"],
  voided: ["offered", "authorized"],
  failed: ["offered"],
};

export class InvalidTransitionError extends Error {
  override readonly name = "InvalidTransitionError";
  constructor(
    readonly from: OrderStatus,
    readonly event: OrderEvent,
  ) {
    super(`invalid order transition ${from} → ${event.to} (${event.source})`);
  }
}

export interface TransitionResult {
  status: OrderStatus;
  /** false when the event repeats the current state or is a stale confirmation. */
  changed: boolean;
}

export function transition(from: OrderStatus, event: OrderEvent): TransitionResult {
  if (event.to === from || PASSED[from].includes(event.to)) return { status: from, changed: false };
  if (NEXT[from].includes(event.to)) return { status: event.to, changed: true };
  throw new InvalidTransitionError(from, event);
}

export function isTerminal(status: OrderStatus): boolean {
  return NEXT[status].length === 0;
}
