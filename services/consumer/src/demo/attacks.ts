// DEMO_MODE attack demo (dashboard): real tampered payment requests, signed by this consumer agent
// and sent to the live merchant gate, built with the attack suite's builders (packages/core). The gate
// must refuse each one; the dashboard then shows it as a blocked row with the human reason.
import { randomBytes } from "node:crypto";
import {
  HandshakeError,
  b64urlEncode,
  forgeOffer,
  isHandshakeError,
  raiseCart,
  randomNonce,
  shipToHash,
  signEnvelope,
  type OfferRequest,
  type PaymentRequest,
  type WebAuthnAssertion,
} from "@handshake/core";
import { buildCart, signPaymentRequest } from "../agent/checkout.js";
import { merchantClient, type MerchantClient } from "../agent/merchant.js";
import type { AgentConfig, AppContext } from "../context.js";

export const ATTACKS = ["amount", "merchant", "replay"] as const;
export type AttackKind = (typeof ATTACKS)[number];

/** Not a wallet user: the gate stops these requests before any user or passkey lookup. */
const DEMO_USER = "usr_attackDemo000000000000";
const DEMO_SHIP_TO = shipToHash({ name: "Attack demo", line1: "1 Demo St", city: "Nowhere", postalCode: "00000", country: "US" });
/** Never verified: steps 4 and 5 (offer, cart) fail before the gate reads an assertion. */
const NO_ASSERTION: WebAuthnAssertion = {
  credentialId: b64urlEncode(randomBytes(16)),
  authenticatorData: b64urlEncode(randomBytes(37)),
  clientDataJSON: b64urlEncode(randomBytes(32)),
  signature: b64urlEncode(randomBytes(64)),
};

export interface AttackResult {
  kind: AttackKind;
  requestId: string;
  /** The gate's error code; "OK" would mean it let the request through. */
  code: string;
}

/** A fresh signed offer for one unit of the first in-stock product. */
async function freshOffer(ctx: AppContext, agent: AgentConfig, m: MerchantClient) {
  const [card, catalog] = await Promise.all([m.card(), m.catalog()]);
  const product = catalog.products.find((p) => p.inStock);
  if (!product) throw new HandshakeError("OUT_OF_STOCK", "nothing in stock to offer");
  const iat = Math.floor(ctx.now() / 1000);
  const payload: OfferRequest = {
    v: 1,
    type: "offer_request",
    consumerAgentId: ctx.consumerAgentId,
    merchantId: card.merchantId,
    items: [{ sku: product.sku, qty: 1 }],
    iat,
    exp: iat + 60,
    nonce: randomNonce(),
  };
  return m.requestOffer(signEnvelope(payload, agent.privateKey, ctx.consumerAgentId));
}

async function build(
  ctx: AppContext,
  agent: AgentConfig,
  m: MerchantClient,
  kind: AttackKind,
): Promise<PaymentRequest> {
  const sign = (offer: PaymentRequest["offer"], authorization: PaymentRequest["authorization"]) =>
    signPaymentRequest(offer, authorization, ctx.consumerAgentId, agent.privateKey);
  if (kind === "replay") {
    // A real approval the human already gave (and the gate already used), sent again as new.
    const done = await ctx.store.latestApprovedApproval();
    if (!done?.offer || !done.assertion) throw new HandshakeError("APPROVAL_INVALID", "no approved purchase yet");
    return sign(done.offer, { kind: "passkey", cartApproval: done.payload, assertion: done.assertion });
  }
  const offer = await freshOffer(ctx, agent, m);
  const cart = buildCart(offer, {
    userId: DEMO_USER,
    consumerAgentId: ctx.consumerAgentId,
    shipToHash: DEMO_SHIP_TO,
    nowS: Math.floor(ctx.now() / 1000),
  });
  if (kind === "amount") {
    return sign(offer, { kind: "passkey", cartApproval: raiseCart(cart, 1000), assertion: NO_ASSERTION });
  }
  return sign(forgeOffer(offer), { kind: "passkey", cartApproval: cart, assertion: NO_ASSERTION });
}

export async function runAttack(ctx: AppContext, kind: AttackKind, client?: MerchantClient): Promise<AttackResult> {
  const agent = ctx.agent;
  const url = agent?.merchantUrls[0];
  if (!agent || !url) throw new HandshakeError("MERCHANT_UNTRUSTED", "no merchant configured");
  const m = client ?? merchantClient(url, agent.fetch);
  const req = await build(ctx, agent, m, kind);
  try {
    await m.pay(req);
    console.error(`attack demo: the gate accepted a ${kind} attack (${req.requestId})`);
    return { kind, requestId: req.requestId, code: "OK" };
  } catch (e) {
    if (!isHandshakeError(e)) throw e;
    return { kind, requestId: req.requestId, code: e.code };
  }
}
