// Shared display rules (docs/DESIGN.md): human reasons for codes, order-state pills, money.

/** Never show a raw code: this line, with the code in a small grey tooltip. */
export const REASONS: Record<string, string> = {
  CART_HASH_MISMATCH: "Cart changed after you approved it",
  OFFER_SIG_INVALID: "Offer not signed by this merchant",
  MERCHANT_UNTRUSTED: "Unknown merchant",
  AGENT_UNTRUSTED: "Unknown shopping agent",
  AGENT_SIG_INVALID: "Request not signed by your agent",
  APPROVAL_REPLAY: "This approval was already used",
  APPROVAL_EXPIRED: "Approval expired",
  APPROVAL_UV_MISSING: "Face ID / fingerprint not confirmed",
  MANDATE_LIMIT: "Over your spending limit",
  MANDATE_SCOPE: "Shop or category not allowed",
  OFFER_EXPIRED: "Offer expired",
  RISK_BLOCKED: "Blocked as suspicious",
  STEP_UP_REQUIRED: "Needs your approval",
  CART_MISMATCH: "Cart doesn't match the offer",
  OFFER_USED: "This offer was already used",
  APPROVAL_INVALID: "Approval couldn't be verified",
  MANDATE_INVALID: "Spending permission isn't valid",
  PAYPAL_ERROR: "PayPal couldn't process this payment",
  OUT_OF_STOCK: "Item is out of stock",
  RATE_LIMITED: "Too many attempts, try again shortly",
  SCHEMA_INVALID: "Request was malformed",
};
export const FALLBACK_REASON = "Payment couldn't be completed";
export const WAITING_FOR_PAYPAL = "Waiting for PayPal approval";

export function reasonFor(code: string | null | undefined): string {
  return (code && REASONS[code]) || FALLBACK_REASON;
}

export type Tone = "ok" | "warn" | "bad" | "grey";

/** Order states in words, per the wallet activity list. */
export function orderPill(status: string, awaitingPayPal = false): { label: string; tone: Tone } {
  if (status === "offered")
    return awaitingPayPal ? { label: WAITING_FOR_PAYPAL, tone: "warn" } : { label: "Pending", tone: "warn" };
  if (status === "authorized") return { label: "Held", tone: "warn" };
  if (status === "captured") return { label: "Paid", tone: "ok" };
  if (status === "voided") return { label: "Voided", tone: "grey" };
  if (status === "refunded") return { label: "Refunded", tone: "grey" };
  if (status === "failed") return { label: "Blocked", tone: "bad" };
  return { label: status, tone: "grey" };
}

export function money(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
}

export const GATE_STEPS: Record<string, string> = {
  "1": "Request is well-formed",
  "2": "Request is new",
  "3": "Shopping agent is registered and signed it",
  "4": "Offer is this merchant's and still open",
  "5": "Cart matches the offer",
  "6a": "Passkey approval of this exact cart",
  "6b": "Spending permission covers it",
  "7": "Approval is fresh and unused",
  "8": "Risk check",
  "9": "Committed; PayPal",
};

/** "Approve with Face ID" on Apple devices, "Approve with passkey" elsewhere. */
export function approveLabel(userAgent: string): string {
  return /iPhone|iPad|Macintosh/.test(userAgent) ? "Approve with Face ID" : "Approve with passkey";
}

export function countdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
