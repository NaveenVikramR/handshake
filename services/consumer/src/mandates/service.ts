// Intent mandates (SPEC §4.2, §5.1 step 3): the wallet builds the mandate from the human's
// choices, the human approves hash(mandate) with a passkey once, then the agent may pay within it.
import { randomBytes } from "node:crypto";
import {
  HandshakeError,
  IntentMandate,
  b64urlEncode,
  hash,
  randomNonce,
  shipToHash,
  verifyMandateApproval,
  type WebAuthnAssertion,
} from "@handshake/core";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { StoredMandate } from "../store.js";

/** How long the human has to approve a freshly built mandate. */
export const MANDATE_SIGN_WINDOW_MS = 5 * 60_000;
export const MAX_MANDATE_DAYS = 30;

export const MandateRequest = z.strictObject({
  userId: z.string().min(1).max(64),
  merchants: z.array(z.string()).min(1).max(50),
  categories: z.array(z.string()).min(1).max(50),
  perOrderMinor: z.int().positive(),
  periodMinor: z.int().positive(),
  period: z.enum(["day", "week", "month"]),
  shipTo: z.unknown(),
  days: z.int().min(1).max(MAX_MANDATE_DAYS),
});
export type MandateRequest = z.infer<typeof MandateRequest>;

/** Builds and stores a pending mandate. Every field the human approves is set here, not by the client. */
export async function createMandate(
  ctx: AppContext,
  req: MandateRequest,
): Promise<{ mandateId: string; mandate: IntentMandate; hash: string; merchants: { id: string; name: string }[] }> {
  if (!(await ctx.store.userExists(req.userId)) || !(await ctx.store.hasCredentials(req.userId))) {
    throw new HandshakeError("MANDATE_INVALID", "user has no passkey");
  }
  let shipTo: string;
  try {
    shipTo = shipToHash(req.shipTo);
  } catch {
    throw new HandshakeError("SCHEMA_INVALID", "invalid ship-to address");
  }
  const iat = Math.floor(ctx.now() / 1000);
  const draft = {
    v: 1,
    type: "intent_mandate",
    mandateId: `man_${b64urlEncode(randomBytes(16))}`,
    userId: req.userId,
    consumerAgentId: ctx.consumerAgentId,
    scope: { merchants: [...new Set(req.merchants)], categories: [...new Set(req.categories)] },
    limits: { perOrderMinor: req.perOrderMinor, periodMinor: req.periodMinor, period: req.period },
    shipToHash: shipTo,
    iat,
    exp: iat + req.days * 86400,
    nonce: randomNonce(),
  };
  const parsed = IntentMandate.safeParse(draft);
  if (!parsed.success) throw new HandshakeError("SCHEMA_INVALID", "mandate failed schema");
  const mandate = parsed.data;
  const merchants = await registeredMerchants(ctx, mandate.scope.merchants);
  const h = hash(mandate);
  await ctx.store.createMandate({
    id: mandate.mandateId,
    userId: mandate.userId,
    payload: mandate,
    hash: h,
    pendingUntil: ctx.now() + MANDATE_SIGN_WINDOW_MS,
  });
  return { mandateId: mandate.mandateId, mandate, hash: h, merchants };
}

/**
 * Every merchant in scope must be active in the trust registry, else MERCHANT_UNTRUSTED. Returns
 * their registry names in scope order, so the wallet shows who the human is authorising, not an id.
 */
async function registeredMerchants(ctx: AppContext, ids: string[]): Promise<{ id: string; name: string }[]> {
  const rows = new Map((await ctx.store.getMerchants(ids)).map((m) => [m.id, m]));
  return ids.map((id) => {
    const m = rows.get(id);
    if (!m || m.status !== "active") throw new HandshakeError("MERCHANT_UNTRUSTED", "merchant not active in the registry");
    return { id: m.id, name: m.name };
  });
}

export async function loadPendingMandate(ctx: AppContext, id: string): Promise<StoredMandate> {
  const m = await ctx.store.getMandate(id);
  if (!m) throw new HandshakeError("MANDATE_INVALID", "unknown mandate");
  if (m.status !== "pending") throw new HandshakeError("APPROVAL_REPLAY", "mandate already approved");
  if (m.pendingUntil <= ctx.now()) throw new HandshakeError("APPROVAL_EXPIRED", "mandate approval window passed");
  return m;
}

/** Verifies the passkey over hash(mandate) and activates the mandate, once. */
export async function activateMandate(ctx: AppContext, id: string, assertion: WebAuthnAssertion): Promise<void> {
  const m = await loadPendingMandate(ctx, id);
  if (hash(m.payload) !== m.hash) throw new HandshakeError("MANDATE_INVALID", "stored mandate changed");
  const credential = await ctx.store.getCredential(assertion.credentialId);
  if (!credential || credential.userId !== m.userId) {
    throw new HandshakeError("MANDATE_INVALID", "credential not registered to this user");
  }
  const { newSignCount } = await verifyMandateApproval(
    m.payload,
    assertion,
    credential,
    { expectedOrigin: ctx.webauthn.origin, expectedRpId: ctx.webauthn.rpId },
    { fresh: true },
  );
  const done = await ctx.store.activateMandate({
    id,
    credentialId: credential.credentialId,
    expectedSignCount: credential.signCount,
    newSignCount,
    assertion,
    now: ctx.now(),
  });
  if (!done) throw new HandshakeError("APPROVAL_REPLAY", "mandate was approved concurrently");
}
