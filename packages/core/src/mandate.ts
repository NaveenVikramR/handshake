// Intent mandates (SPEC §4.2, §6 step 6b): a standing permission the human approved with a
// passkey once. Pure checks only; the period ledger lives in packages/db (mandate-ledger).
import { HandshakeError, isHandshakeError } from "./errors.js";
import { hash } from "./crypto.js";
import { ShipTo, type CartApproval, type IntentMandate, type WebAuthnAssertion } from "./schemas.js";
import { checkFreshness } from "./time.js";
import { verifyApprovalAssertion, type PasskeyCredential, type WebAuthnContext } from "./webauthn.js";

export type MandatePeriod = IntentMandate["limits"]["period"];

/** shipToHash for mandates and carts: hash of the schema-checked address (throws on a bad one). */
export function shipToHash(address: unknown): string {
  return hash(ShipTo.parse(address));
}

/**
 * Start of the UTC calendar bucket containing `nowSec` (D17): day = UTC date, week = ISO week
 * starting Monday 00:00 UTC, month = calendar month. Returns unix seconds.
 */
export function periodStart(period: MandatePeriod, nowSec: number): number {
  const d = new Date(nowSec * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  switch (period) {
    case "day":
      return Date.UTC(y, m, day) / 1000;
    case "week": {
      const sinceMonday = (d.getUTCDay() + 6) % 7;
      return Date.UTC(y, m, day - sinceMonday) / 1000;
    }
    case "month":
      return Date.UTC(y, m, 1) / 1000;
  }
}

export interface MandateScopeContext {
  /** Category of every cart item, resolved by the merchant from its own catalog (never from the request). */
  categories: readonly string[];
  /** unix seconds */
  now: number;
}

/**
 * Everything in 6b except the period limit, which needs the ledger. Throws MANDATE_INVALID
 * (stale or not this cart's user/agent), MANDATE_SCOPE (merchant, category or ship-to outside the
 * mandate) or MANDATE_LIMIT (over the per-order limit).
 */
export function checkMandateScope(mandate: IntentMandate, cart: CartApproval, ctx: MandateScopeContext): void {
  if (checkFreshness(mandate, ctx.now) !== "ok") throw new HandshakeError("MANDATE_INVALID", "mandate expired");
  if (mandate.userId !== cart.userId || mandate.consumerAgentId !== cart.consumerAgentId) {
    throw new HandshakeError("MANDATE_INVALID", "mandate is for another user or agent");
  }
  if (!mandate.scope.merchants.includes(cart.merchantId)) {
    throw new HandshakeError("MANDATE_SCOPE", "merchant not in mandate scope");
  }
  if (ctx.categories.length !== cart.items.length) {
    throw new HandshakeError("MANDATE_SCOPE", "category missing for an item");
  }
  if (!ctx.categories.every((c) => mandate.scope.categories.includes(c))) {
    throw new HandshakeError("MANDATE_SCOPE", "category not in mandate scope");
  }
  if (mandate.shipToHash !== cart.shipToHash) {
    throw new HandshakeError("MANDATE_SCOPE", "ship-to differs from the mandate");
  }
  if (cart.totalMinor > mandate.limits.perOrderMinor) {
    throw new HandshakeError("MANDATE_LIMIT", "over the per-order limit");
  }
}

/**
 * The passkey approval of a mandate. Any failure is MANDATE_INVALID (§6 step 6b); the reason keeps the detail.
 *
 * `fresh: true` at activation (wallet): the assertion was just made, so the sign count must advance
 * and the caller stores `newSignCount`. `fresh: false` when re-checking the stored proof on each
 * order (merchant gate): the same assertion is verified many times, so its count can't advance and
 * is not checked; the caller must not update any sign count from it (D17).
 */
export async function verifyMandateApproval(
  mandate: IntentMandate,
  assertion: WebAuthnAssertion,
  credential: PasskeyCredential,
  ctx: WebAuthnContext,
  opts: { fresh: boolean },
): Promise<{ newSignCount: number }> {
  try {
    // signCount 0 = "never counted": the D12 rule then accepts any reported count.
    const asSeen = opts.fresh ? credential : { ...credential, signCount: 0 };
    return await verifyApprovalAssertion(mandate, assertion, asSeen, ctx);
  } catch (e) {
    if (isHandshakeError(e)) throw new HandshakeError("MANDATE_INVALID", `${e.code}: ${e.message}`, { cause: e });
    throw e;
  }
}
