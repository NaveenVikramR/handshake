import { hash, randomNonce } from "../src/crypto.js";
import type { Offer } from "../src/schemas.js";

export const iat = 1_762_000_000;
export const items = [
  { sku: "RICE-2KG", name: "Rice 2 kg", qty: 2, unitMinor: 499 },
  { sku: "DET-1L", name: "Detergent 1 L", qty: 1, unitMinor: 350 },
];
export const shipToHash = hash({ line1: "1 Main St" });

export const offer: Offer = {
  v: 1,
  type: "offer",
  offerId: "off_1",
  merchantId: "mer_corner",
  merchantAgentId: "agt_m_corner",
  paypalMerchantId: "ABCD1234EFGH5",
  items,
  totalMinor: 1348,
  currency: "USD",
  holdUntil: iat + 600,
  iat,
  exp: iat + 600,
  nonce: randomNonce(),
};

export const cart = {
  v: 1,
  type: "cart_approval",
  offerId: "off_1",
  offerHash: hash(offer),
  merchantId: "mer_corner",
  items,
  totalMinor: 1348,
  currency: "USD",
  shipToHash,
  consumerAgentId: "agt_c_alice",
  userId: "usr_alice",
  iat,
  exp: iat + 300,
  nonce: randomNonce(),
};

export const mandate = {
  v: 1,
  type: "intent_mandate",
  mandateId: "man_1",
  userId: "usr_alice",
  consumerAgentId: "agt_c_alice",
  scope: { merchants: ["mer_corner"], categories: ["grocery"] },
  limits: { perOrderMinor: 3000, periodMinor: 8000, period: "week" },
  shipToHash,
  iat,
  exp: iat + 7 * 86400,
  nonce: randomNonce(),
};

export const assertion = {
  credentialId: "Y3JlZA",
  authenticatorData: "YXV0aA",
  clientDataJSON: "Y2xpZW50",
  signature: "c2ln",
};
