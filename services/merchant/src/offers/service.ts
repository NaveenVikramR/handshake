// Merchant identity, agent card, catalog and offer creation (SPEC §4.1, §10).
// Prices and names come only from the catalog rows; the request supplies skus and quantities.
import {
  CLOCK_SKEW_S,
  HandshakeError,
  MAX_OFFER_REQUEST_TTL_S,
  Offer,
  SignedOfferRequest,
  b64urlEncode,
  hash,
  publicKeyFromPrivate,
  randomNonce,
  signEnvelope,
  verifyOfferRequestEnvelope,
  type OfferRequest,
} from "@handshake/core";
import { randomBytes } from "node:crypto";
import type { OfferStore, PricedOffer, ProductRow } from "./store.js";

/** Stock is held this long; the offer expires with it (SPEC §4.1). */
export const OFFER_HOLD_S = 600;
export const MAX_OPEN_OFFERS_PER_AGENT = 20;
/** A shopping basket, not the shelf: one request or one agent can't hold the whole catalog. */
export const MAX_QTY_PER_LINE = 10;
export const MAX_HELD_UNITS_PER_AGENT = 40;

/** This merchant, as the trust registry knows it. */
export interface MerchantSelf {
  merchantId: string;
  merchantAgentId: string;
  paypalMerchantId: string;
  name: string;
  publicKey: string;
  privateKey: string;
}

export interface OfferContext {
  store: OfferStore;
  self: MerchantSelf;
  /** ms since epoch; injected in tests. */
  now: () => number;
}

/**
 * Resolves this merchant from the registry by its agent id. Refuses to start unless the agent is an
 * active merchant agent of an active merchant and the registry key is the one we sign with, so every
 * offer we sign verifies for consumers and payee ids have a single source.
 */
export async function loadSelf(store: OfferStore, agentId: string, privateKey: string): Promise<MerchantSelf> {
  const agent = await store.getAgent(agentId);
  if (!agent || agent.role !== "merchant" || agent.status !== "active" || !agent.merchantId) {
    throw new Error(`merchant agent ${agentId} is not an active merchant agent in the registry`);
  }
  const merchant = await store.getMerchant(agent.merchantId);
  if (!merchant || merchant.status !== "active") throw new Error(`merchant ${agent.merchantId} is not active`);
  if (publicKeyFromPrivate(privateKey) !== agent.publicKey) {
    throw new Error("MERCHANT_AGENT_PRIVATE_KEY does not match the registry public key (re-run db:seed)");
  }
  return {
    merchantId: merchant.id,
    merchantAgentId: agent.id,
    paypalMerchantId: merchant.paypalMerchantId,
    name: merchant.name,
    publicKey: agent.publicKey,
    privateKey,
  };
}

/**
 * GET /.well-known/agent.json. A discovery hint only, unsigned: no public key, so nobody is tempted to
 * verify offers against it. Consumers look up keys and ids in the registry.
 */
export function agentCard(self: MerchantSelf) {
  return {
    v: 1,
    type: "agent_card",
    name: self.name,
    merchantId: self.merchantId,
    merchantAgentId: self.merchantAgentId,
    paypalMerchantId: self.paypalMerchantId,
    currency: "USD",
    endpoints: { catalog: "/catalog", offers: "/offers", payments: "/payments" },
    offerRequest: { type: "offer_request", maxTtlSeconds: MAX_OFFER_REQUEST_TTL_S },
  };
}

export function catalog(products: ProductRow[]) {
  return products.map(({ sku, name, category, priceMinor, stock }) => ({
    sku,
    name,
    category,
    priceMinor,
    currency: "USD",
    // Not the exact count: that would point an attacker at the last units.
    inStock: stock > 0,
  }));
}

/** Builds and signs the offer from catalog rows. `nowS` is unix seconds. */
export function priceOffer(
  self: MerchantSelf,
  lines: OfferRequest["items"],
  products: Map<string, ProductRow>,
  nowS: number,
): PricedOffer {
  const items = lines.map(({ sku, qty }) => {
    const p = products.get(sku);
    if (!p) throw new HandshakeError("SCHEMA_INVALID", "unknown sku");
    return { sku, name: p.name, qty, unitMinor: p.priceMinor };
  });
  const draft = {
    v: 1,
    type: "offer",
    offerId: `off_${b64urlEncode(randomBytes(16))}`,
    merchantId: self.merchantId,
    merchantAgentId: self.merchantAgentId,
    paypalMerchantId: self.paypalMerchantId,
    items,
    totalMinor: items.reduce((sum, i) => sum + i.qty * i.unitMinor, 0),
    currency: "USD",
    holdUntil: nowS + OFFER_HOLD_S,
    iat: nowS,
    exp: nowS + OFFER_HOLD_S,
    nonce: randomNonce(),
  };
  // Re-validate what we're about to sign (overflow, zero total, bad catalog names).
  const parsed = Offer.safeParse(draft);
  if (!parsed.success) throw new HandshakeError("SCHEMA_INVALID", "offer failed schema");
  return { offer: signEnvelope(parsed.data, self.privateKey, self.merchantAgentId), hash: hash(parsed.data) };
}

/** POST /offers: verify the signed request, then hold stock and sign the offer atomically. */
export async function createOffer(ctx: OfferContext, body: unknown): Promise<PricedOffer> {
  const parsed = SignedOfferRequest.safeParse(body);
  if (!parsed.success) throw new HandshakeError("SCHEMA_INVALID", "invalid offer request");
  const req = parsed.data;
  if (req.payload.items.some((l) => l.qty > MAX_QTY_PER_LINE)) {
    throw new HandshakeError("SCHEMA_INVALID", `qty above ${MAX_QTY_PER_LINE}`);
  }
  const agent = await ctx.store.getAgent(req.kid);
  if (!agent || agent.role !== "consumer" || agent.status !== "active") {
    throw new HandshakeError("AGENT_UNTRUSTED", "consumer agent not active in the registry");
  }
  const now = ctx.now();
  const nowS = Math.floor(now / 1000);
  verifyOfferRequestEnvelope(req, agent, ctx.self.merchantId, nowS);
  return ctx.store.createOffer({
    agentId: agent.id,
    nonce: req.payload.nonce,
    nonceExp: req.payload.exp + CLOCK_SKEW_S,
    lines: req.payload.items,
    maxOpen: MAX_OPEN_OFFERS_PER_AGENT,
    maxHeldUnits: MAX_HELD_UNITS_PER_AGENT,
    now,
    build: (products) => priceOffer(ctx.self, req.payload.items, products, nowS),
  });
}
