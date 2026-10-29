// SPEC §5.2 step 4: code, never the LLM, decides mandate path vs step-up. Within an active
// mandate's scope, per-order and period limits → mandate; anything else → step-up with the reason.
import {
  isHandshakeError,
  checkMandateScope,
  periodStart,
  type CartApproval,
  type IntentMandate,
} from "@handshake/core";
import type { StoredMandate } from "../store.js";

export type PathDecision = { path: "mandate"; mandate: StoredMandate } | { path: "step_up"; reasons: string[] };

export interface PolicyInput {
  cart: CartApproval;
  /** One per cart item, from the merchant's catalog; unknown → "". */
  categories: string[];
  /** The user's active mandates (stored proof included). */
  mandates: StoredMandate[];
  spent(key: { mandateId: string; periodStart: number }): Promise<number>;
  /** unix seconds */
  now: number;
}

async function check(m: IntentMandate, input: PolicyInput): Promise<string | undefined> {
  try {
    checkMandateScope(m, input.cart, { categories: input.categories, now: input.now });
  } catch (e) {
    if (isHandshakeError(e)) return `${m.mandateId}: ${e.code} ${e.message}`;
    throw e;
  }
  const spent = await input.spent({ mandateId: m.mandateId, periodStart: periodStart(m.limits.period, input.now) });
  if (spent + input.cart.totalMinor > m.limits.periodMinor)
    return `${m.mandateId}: MANDATE_LIMIT over the ${m.limits.period} limit`;
  return undefined;
}

export async function decidePath(input: PolicyInput): Promise<PathDecision> {
  const reasons: string[] = [];
  for (const m of input.mandates) {
    if (m.status !== "active" || !m.assertion) continue;
    const reason = await check(m.payload, input);
    if (!reason) return { path: "mandate", mandate: m };
    reasons.push(reason);
  }
  return { path: "step_up", reasons: reasons.length ? reasons : ["no active mandate"] };
}
