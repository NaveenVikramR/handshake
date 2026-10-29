import { describe, expect, it } from "vitest";
import { generateEd25519KeyPair, hash, signEnvelope, signPayload } from "../src/crypto.js";
import { CartApproval, IntentMandate, Offer, PaymentRequest, Receipt } from "../src/schemas.js";
import { assertion, cart, iat, items, mandate, offer } from "./fixtures.js";

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
    ["zero total", { items: [{ ...items[0], unitMinor: 0 }], totalMinor: 0 }],
    ["negative qty", { items: [{ ...items[0], qty: -1 }], totalMinor: -499 }],
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
    ["zero total", { items: [{ ...items[0], unitMinor: 0 }], totalMinor: 0 }],
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

describe("shape only — identity binding is not a schema concern", () => {
  it("parses a request whose kids mismatch (verify.ts rejects it with *_SIG_INVALID)", () => {
    const m = generateEd25519KeyPair();
    const env = signEnvelope(offer, m.privateKey, "agt_m_other");
    const body = { requestId: "req_1", offer: env, authorization: { kind: "passkey", cartApproval: cart, assertion } };
    expect(PaymentRequest.safeParse({ ...body, agentSig: "c2ln", kid: "agt_c_mallory" }).success).toBe(true);
  });

  it("rejects a non-canonical hash spelling", () => {
    const h = hash(offer);
    const alt = h.slice(0, -1) + (h.endsWith("B") ? "C" : "B");
    expect(CartApproval.safeParse({ ...cart, offerHash: alt }).success).toBe(false);
  });
});
