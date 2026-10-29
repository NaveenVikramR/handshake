// Cart approvals (SPEC §4.3, §5.2 step 4). The approval is bound to the exact cart:
// challenge = hash(cart), so any change after approval invalidates it.
import { randomBytes } from "node:crypto";
import {
  CartApproval,
  HandshakeError,
  b64urlEncode,
  checkFreshness,
  hash,
  verifyApprovalAssertion,
  type WebAuthnAssertion,
} from "@handshake/core";
import type { AppContext } from "../context.js";
import type { StoredApproval } from "../store.js";

export const newApprovalId = () => `apr_${b64urlEncode(randomBytes(16))}`;

/** Creates a pending approval for a cart. Called by the consumer agent (M6); amounts come from the verified offer. */
export async function createApproval(ctx: AppContext, cart: unknown): Promise<{ id: string; hash: string }> {
  const parsed = CartApproval.safeParse(cart);
  if (!parsed.success) throw new HandshakeError("SCHEMA_INVALID", "cart approval failed schema");
  const payload = parsed.data;
  if (!(await ctx.store.userExists(payload.userId))) throw new HandshakeError("APPROVAL_INVALID", "unknown user");
  if (checkFreshness(payload, Math.floor(ctx.now() / 1000)) !== "ok") {
    throw new HandshakeError("APPROVAL_EXPIRED", "cart approval already expired");
  }
  const id = newApprovalId();
  const h = hash(payload);
  await ctx.store.createApproval({ id, userId: payload.userId, payload, hash: h, expiresAt: payload.exp * 1000 });
  return { id, hash: h };
}

function assertUsable(approval: StoredApproval | undefined, nowMs: number): StoredApproval {
  if (!approval) throw new HandshakeError("APPROVAL_INVALID", "unknown approval");
  if (approval.status !== "pending") throw new HandshakeError("APPROVAL_REPLAY", "approval already used");
  if (approval.expiresAt <= nowMs || checkFreshness(approval.payload, Math.floor(nowMs / 1000)) !== "ok") {
    throw new HandshakeError("APPROVAL_EXPIRED", "approval expired");
  }
  return approval;
}

export async function loadPendingApproval(ctx: AppContext, id: string): Promise<StoredApproval> {
  return assertUsable(await ctx.store.getApproval(id), ctx.now());
}

/** Verifies the passkey assertion over hash(cart) and marks the approval used, once. */
export async function verifyApproval(ctx: AppContext, id: string, assertion: WebAuthnAssertion): Promise<void> {
  const approval = await loadPendingApproval(ctx, id);
  // Defence in depth: the stored hash must still match the stored cart.
  if (hash(approval.payload) !== approval.hash) throw new HandshakeError("CART_HASH_MISMATCH", "stored cart changed");

  const credential = await ctx.store.getCredential(assertion.credentialId);
  if (!credential || credential.userId !== approval.userId) {
    throw new HandshakeError("APPROVAL_INVALID", "credential not registered to this user");
  }
  const { newSignCount } = await verifyApprovalAssertion(approval.payload, assertion, credential, {
    expectedOrigin: ctx.webauthn.origin,
    expectedRpId: ctx.webauthn.rpId,
  });
  const done = await ctx.store.completeApproval({
    id,
    credentialId: credential.credentialId,
    expectedSignCount: credential.signCount,
    newSignCount,
    assertion,
    now: ctx.now(),
  });
  if (!done) throw new HandshakeError("APPROVAL_REPLAY", "approval was used concurrently");
}
