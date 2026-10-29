// Every verification failure maps to exactly one of these codes (SPEC §6).
export const ERROR_CODES = [
  "SCHEMA_INVALID",
  "DUPLICATE_REQUEST",
  "AGENT_UNTRUSTED",
  "AGENT_SIG_INVALID",
  "MERCHANT_UNTRUSTED",
  "OFFER_SIG_INVALID",
  "OFFER_EXPIRED",
  "OFFER_USED",
  "CART_MISMATCH",
  "CART_HASH_MISMATCH",
  "APPROVAL_INVALID",
  "APPROVAL_UV_MISSING",
  "APPROVAL_REPLAY",
  "APPROVAL_EXPIRED",
  "MANDATE_INVALID",
  "MANDATE_SCOPE",
  "MANDATE_LIMIT",
  "STEP_UP_REQUIRED",
  "RISK_BLOCKED",
  "PAYPAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// DUPLICATE_REQUEST is not a failure: the caller gets the stored receipt with 200.
const HTTP_STATUS: Record<ErrorCode, number> = {
  SCHEMA_INVALID: 400,
  DUPLICATE_REQUEST: 200,
  AGENT_UNTRUSTED: 401,
  AGENT_SIG_INVALID: 401,
  MERCHANT_UNTRUSTED: 401,
  OFFER_SIG_INVALID: 401,
  OFFER_EXPIRED: 409,
  OFFER_USED: 409,
  CART_MISMATCH: 422,
  CART_HASH_MISMATCH: 422,
  APPROVAL_INVALID: 401,
  APPROVAL_UV_MISSING: 401,
  APPROVAL_REPLAY: 409,
  APPROVAL_EXPIRED: 401,
  MANDATE_INVALID: 401,
  MANDATE_SCOPE: 403,
  MANDATE_LIMIT: 403,
  STEP_UP_REQUIRED: 403,
  RISK_BLOCKED: 403,
  PAYPAL_ERROR: 502,
};

export class HandshakeError extends Error {
  override readonly name = "HandshakeError";
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.code = code;
    this.status = HTTP_STATUS[code];
  }

  toJSON(): { code: ErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export function isHandshakeError(e: unknown): e is HandshakeError {
  return e instanceof HandshakeError;
}
