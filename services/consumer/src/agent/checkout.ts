// Checkout (SPEC §5.2 steps 4–5). Everything here is built by code from the verified offer and
// stored state: the cart copies the offer's items and total, the path comes from policy, and the
// payment request is signed with the agent key. The LLM only names the offer by id.
import { randomBytes } from "node:crypto";
import {
  CartApproval,
  HandshakeError,
  MAX_CART_APPROVAL_TTL_S,
  PaymentRequest,
  b64urlEncode,
  checkFreshness,
  hash,
  paymentRequestSigningInput,
  randomNonce,
  signPayload,
  type Authorization,
  type SignedOffer,
  type WebAuthnAssertion,
} from "@handshake/core";
import { createApproval } from "../approvals/service.js";
import type { AgentConfig, AppContext } from "../context.js";
import { decidePath, type PathDecision } from "./policy.js";

export type CheckoutEvent =
  | { type: "path"; path: "mandate"; mandateId: string }
  | { type: "path"; path: "step_up"; reasons: string[] }
  | { type: "approval_required"; approvalId: string; url: string; expiresAt: number };

/** The cart the human (step-up) or the mandate (no human) authorises: the offer, verbatim. */
export function buildCart(
  offer: SignedOffer,
  opts: { userId: string; consumerAgentId: string; shipToHash: string; nowS: number },
): CartApproval {
  const p = offer.payload;
  const exp = Math.min(opts.nowS + MAX_CART_APPROVAL_TTL_S, p.holdUntil);
  const parsed = CartApproval.safeParse({
    v: 1,
    type: "cart_approval",
    offerId: p.offerId,
    offerHash: hash(p),
    merchantId: p.merchantId,
    items: p.items,
    totalMinor: p.totalMinor,
    currency: p.currency,
    shipToHash: opts.shipToHash,
    consumerAgentId: opts.consumerAgentId,
    userId: opts.userId,
    iat: opts.nowS,
    exp,
    nonce: randomNonce(),
  });
  if (!parsed.success) throw new HandshakeError("OFFER_EXPIRED", "offer hold ends before a cart could be approved");
  return parsed.data;
}

export function signPaymentRequest(
  offer: SignedOffer,
  authorization: Authorization,
  consumerAgentId: string,
  privateKey: string,
): PaymentRequest {
  const body = { requestId: `req_${b64urlEncode(randomBytes(16))}`, offer, authorization };
  const req = PaymentRequest.safeParse({
    ...body,
    agentSig: signPayload(paymentRequestSigningInput(body), privateKey),
    kid: consumerAgentId,
  });
  if (!req.success) throw new HandshakeError("SCHEMA_INVALID", "payment request failed schema");
  return req.data;
}

/** Waits for the human to approve on the phone page. APPROVAL_EXPIRED if the window closes first. */
export async function awaitApproval(
  ctx: AppContext,
  approvalId: string,
  opts: { pollMs: number; signal?: AbortSignal },
): Promise<WebAuthnAssertion> {
  for (;;) {
    if (opts.signal?.aborted) throw new HandshakeError("APPROVAL_EXPIRED", "chat cancelled before approval");
    const a = await ctx.store.getApproval(approvalId);
    if (!a) throw new HandshakeError("APPROVAL_INVALID", "approval disappeared");
    if (a.status === "approved" && a.assertion) return a.assertion;
    if (a.expiresAt <= ctx.now()) throw new HandshakeError("APPROVAL_EXPIRED", "approval window closed");
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

export interface CheckoutInput {
  userId: string;
  offer: SignedOffer;
  /** One per offer item, from the merchant catalog. */
  categories: string[];
  /** From the signed-in wallet request, or the mandate's when omitted. Never from the LLM. */
  shipToHash: string | undefined;
  /** Set → skip the mandate path and ask the human, with this reason. */
  forceStepUp?: string | undefined;
  emit: (e: CheckoutEvent) => void;
  signal?: AbortSignal;
}

/** Decides the path, gets the authorization, and returns the signed payment request. */
export async function authorize(
  ctx: AppContext,
  agent: AgentConfig,
  input: CheckoutInput,
): Promise<{ request: PaymentRequest; decision: PathDecision }> {
  const nowS = Math.floor(ctx.now() / 1000);
  const mandates = (await ctx.store.listActiveMandates(input.userId)).filter(
    (m) => m.assertion && checkFreshness(m.payload, nowS) === "ok",
  );
  // With no explicit address, a live mandate's own ship-to is the only one the human has approved.
  const shipToHash = input.shipToHash ?? mandates[0]?.payload.shipToHash;
  if (!shipToHash) throw new HandshakeError("SCHEMA_INVALID", "ship-to address required");

  const cart = buildCart(input.offer, { userId: input.userId, consumerAgentId: ctx.consumerAgentId, shipToHash, nowS });
  const decision: PathDecision = input.forceStepUp
    ? { path: "step_up", reasons: [input.forceStepUp] }
    : await decidePath({ cart, categories: input.categories, mandates, spent: agent.spent, now: nowS });

  let authorization: Authorization;
  if (decision.path === "mandate") {
    input.emit({ type: "path", path: "mandate", mandateId: decision.mandate.id });
    authorization = {
      kind: "mandate",
      mandate: decision.mandate.payload,
      assertion: decision.mandate.assertion as WebAuthnAssertion,
      cart,
    };
  } else {
    input.emit({ type: "path", path: "step_up", reasons: decision.reasons });
    const { id } = await createApproval(ctx, cart);
    input.emit({
      type: "approval_required",
      approvalId: id,
      url: `${new URL(agent.webUrl).origin}/approve/${id}`,
      expiresAt: cart.exp * 1000,
    });
    const assertion = await awaitApproval(ctx, id, {
      pollMs: agent.approvalPollMs ?? 1000,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    authorization = { kind: "passkey", cartApproval: cart, assertion };
  }
  return { request: signPaymentRequest(input.offer, authorization, ctx.consumerAgentId, agent.privateKey), decision };
}
