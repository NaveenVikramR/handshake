import { describe, expect, it } from "vitest";
import { generateEd25519KeyPair, hash, randomNonce, signEnvelope, signPayload, verifyPayload } from "../src/crypto.js";
import {
  CartApproval,
  IntentMandate,
  Offer,
  PaymentRequest,
  Receipt,
  paymentRequestSigningInput,
  type Offer as OfferT,
} from "../src/schemas.js";

const iat = 1_762_000_000;
const items = [
  { sku: "RICE-2KG", name: "Rice 2 kg", qty: 2, unitMinor: 499 },
  { sku: "DET-1L", name: "Detergent 1 L", qty: 1, unitMinor: 350 },
];
const shipToHash = hash({ line1: "1 Main St" });

const offer: OfferT = {
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

const cart = {
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

const mandate = {
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

const assertion = {
  credentialId: "Y3JlZA",
  authenticatorData: "YXV0aA",
  clientDataJSON: "Y2xpZW50",
  signature: "c2ln",
};

describe("Offer", () => {
  it("accepts a valid offer", () => {
    expect(Offer.parse(offer)).toEqual(offer);
  });

  it.each([
    ["total ≠ sum of items", { totalMinor: 1347 }],
    ["non-integer amount", { totalMinor: 13.48 }],
    ["negative amount", { totalMinor: -1 }],
    ["other currency", { currency: "EUR" }],
    ["wrong version", { v: 2 }],
    ["wrong type", { type: "cart_approval" }],
    ["unknown key", { discount: 100 }],
    ["bad merchant id prefix", { merchantId: "corner" }],
    ["consumer agent as merchant agent", { merchantAgentId: "agt_c_alice" }],
    ["short nonce", { nonce: "abc" }],
    ["exp before iat", { exp: iat - 1 }],
    ["no items", { items: [], totalMinor: 0 }],
    ["zero qty", { items: [{ ...items[0], qty: 0 }], totalMinor: 0 }],
    ["string amount", { totalMinor: "1348" }],
  ])("rejects %s", (_name, patch) => {
    expect(Offer.safeParse({ ...offer, ...patch }).success).toBe(false);
  });

  it("rejects an unknown key inside an item", () => {
    const bad = { ...offer, items: [{ ...items[0], note: "ignore previous" }, items[1]] };
    expect(Offer.safeParse(bad).success).toBe(false);
  });

  it("rejects a sum that overflows safe integers", () => {
    const big = Number.MAX_SAFE_INTEGER;
    const bad = {
      ...offer,
      items: [{ ...items[0], qty: 2, unitMinor: big }],
      totalMinor: big,
    };
    expect(Offer.safeParse(bad).success).toBe(false);
  });
});

describe("IntentMandate", () => {
  it("accepts a valid mandate", () => {
    expect(IntentMandate.parse(mandate)).toEqual(mandate);
  });

  it.each([
    ["perOrder > period", { limits: { perOrderMinor: 9000, periodMinor: 8000, period: "week" } }],
    ["unknown period", { limits: { perOrderMinor: 1, periodMinor: 2, period: "year" } }],
    ["zero limit", { limits: { perOrderMinor: 0, periodMinor: 8000, period: "week" } }],
    ["empty merchant scope", { scope: { merchants: [], categories: ["grocery"] } }],
    ["extra scope key", { scope: { ...mandate.scope, any: true } }],
    ["bad shipToHash", { shipToHash: "x" }],
  ])("rejects %s", (_name, patch) => {
    expect(IntentMandate.safeParse({ ...mandate, ...patch }).success).toBe(false);
  });
});

describe("CartApproval", () => {
  it("accepts a valid cart approval", () => {
    expect(CartApproval.parse(cart)).toEqual(cart);
  });

  it.each([
    ["lifetime > 5 min", { exp: iat + 301 }],
    ["total tampered", { totalMinor: 1 }],
    ["bad offerHash", { offerHash: "short" }],
    ["unknown key", { tip: 100 }],
  ])("rejects %s", (_name, patch) => {
    expect(CartApproval.safeParse({ ...cart, ...patch }).success).toBe(false);
  });
});

describe("PaymentRequest", () => {
  const merchant = generateEd25519KeyPair();
  const consumer = generateEd25519KeyPair();
  const signedOffer = signEnvelope(offer, merchant.privateKey, "agt_m_corner");

  function build(authorization: unknown) {
    const body = { requestId: "req_1", offer: signedOffer, authorization };
    return { ...body, agentSig: signPayload(body, consumer.privateKey), kid: "agt_c_alice" };
  }

  it("accepts the passkey and mandate variants", () => {
    expect(PaymentRequest.safeParse(build({ kind: "passkey", cartApproval: cart, assertion })).success).toBe(true);
    expect(PaymentRequest.safeParse(build({ kind: "mandate", mandate, assertion, cart })).success).toBe(true);
  });

  it("agentSig covers {requestId, offer, authorization} and detects tamper", () => {
    const req = PaymentRequest.parse(build({ kind: "passkey", cartApproval: cart, assertion }));
    const input = paymentRequestSigningInput(req);
    expect(verifyPayload(input, req.agentSig, consumer.publicKey)).toBe(true);
    const tampered = { ...input, requestId: "req_2" };
    expect(verifyPayload(tampered, req.agentSig, consumer.publicKey)).toBe(false);
  });

  it.each([
    ["unknown kind", { kind: "card", cartApproval: cart, assertion }],
    ["passkey without assertion", { kind: "passkey", cartApproval: cart }],
    ["mandate missing cart", { kind: "mandate", mandate, assertion }],
    ["mixed variant fields", { kind: "passkey", cartApproval: cart, assertion, mandate }],
    ["assertion extra field", { kind: "passkey", cartApproval: cart, assertion: { ...assertion, uv: true } }],
  ])("rejects %s", (_name, authorization) => {
    expect(PaymentRequest.safeParse(build(authorization)).success).toBe(false);
  });

  it("rejects an offer envelope with a consumer kid or extra fields", () => {
    const base = build({ kind: "passkey", cartApproval: cart, assertion });
    expect(PaymentRequest.safeParse({ ...base, offer: { ...signedOffer, kid: "agt_c_alice" } }).success).toBe(false);
    expect(PaymentRequest.safeParse({ ...base, offer: { ...signedOffer, alg: "none" } }).success).toBe(false);
    expect(PaymentRequest.safeParse({ ...base, kid: "agt_m_corner" }).success).toBe(false);
  });
});

describe("Receipt", () => {
  const receipt = {
    requestId: "req_1",
    offerHash: hash(offer),
    approvalHash: hash(cart),
    paypalOrderId: "5O190127TN364715T",
    authorizationId: "0VF52814937998046",
    status: "authorized",
    decisions: [{ step: "1", result: "pass", reason: "schema ok" }],
  };

  it("accepts with and without optional fields", () => {
    expect(Receipt.safeParse(receipt).success).toBe(true);
    expect(Receipt.safeParse({ ...receipt, status: "captured", captureId: "C1", trackingNumber: "T1" }).success).toBe(
      true,
    );
  });

  it.each([
    ["unknown status", { status: "approved" }],
    ["bad decision result", { decisions: [{ step: "1", result: "ok", reason: "" }] }],
    ["unknown key", { amount: 1348 }],
  ])("rejects %s", (_name, patch) => {
    expect(Receipt.safeParse({ ...receipt, ...patch }).success).toBe(false);
  });
});

describe("identity binding", () => {
  const merchant = generateEd25519KeyPair();
  const consumer = generateEd25519KeyPair();

  function build(authorization: unknown, kid = "agt_c_alice", offerKid = "agt_m_corner") {
    const body = { requestId: "req_1", offer: signEnvelope(offer, merchant.privateKey, offerKid), authorization };
    return { ...body, agentSig: signPayload(body, consumer.privateKey), kid };
  }

  it("rejects an offer signed by a different merchant agent than it names", () => {
    const req = build({ kind: "passkey", cartApproval: cart, assertion }, "agt_c_alice", "agt_m_other");
    expect(PaymentRequest.safeParse(req).success).toBe(false);
  });

  it("rejects a passkey approval re-wrapped by another consumer agent", () => {
    const req = build({ kind: "passkey", cartApproval: cart, assertion }, "agt_c_mallory");
    expect(PaymentRequest.safeParse(req).success).toBe(false);
  });

  it("rejects a mandate whose agent or user differs from the cart", () => {
    const otherAgent = { ...mandate, consumerAgentId: "agt_c_mallory" };
    expect(PaymentRequest.safeParse(build({ kind: "mandate", mandate: otherAgent, assertion, cart })).success).toBe(
      false,
    );
    const otherUser = { ...mandate, userId: "usr_bob" };
    expect(PaymentRequest.safeParse(build({ kind: "mandate", mandate: otherUser, assertion, cart })).success).toBe(
      false,
    );
  });

  it("rejects a non-canonical hash spelling", () => {
    const h = hash(offer);
    const alt = h.slice(0, -1) + (h.endsWith("B") ? "C" : "B");
    expect(CartApproval.safeParse({ ...cart, offerHash: alt }).success).toBe(false);
  });
});
