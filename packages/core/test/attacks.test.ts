import { describe, expect, it } from "vitest";
import {
  CartApproval,
  forgeOffer,
  generateEd25519KeyPair,
  paymentRequestSigningInput,
  raiseCart,
  resignRequest,
  signEnvelope,
  verifyEnvelope,
  verifyPayload,
  type PaymentRequest,
  type SignedOffer,
} from "../src/index.js";

const now = 1_800_000_000;
const cart: CartApproval = {
  v: 1,
  type: "cart_approval",
  offerId: "off_1",
  offerHash: `${"a".repeat(42)}A`,
  merchantId: "mer_corner",
  items: [
    { sku: "RICE-2KG", name: "Rice", qty: 2, unitMinor: 499 },
    { sku: "MILK-1L", name: "Milk", qty: 1, unitMinor: 129 },
  ],
  totalMinor: 1127,
  currency: "USD",
  shipToHash: `${"b".repeat(42)}A`,
  consumerAgentId: "agt_c_demo",
  userId: "usr_0123456789abcdefghijkl",
  iat: now,
  exp: now + 300,
  nonce: "c".repeat(22),
};

describe("attack builders (packages/core/src/attacks.ts)", () => {
  it("raiseCart raises the first line and the total, still a valid cart, original untouched", () => {
    const raised = raiseCart(cart, 1000);
    expect(raised.items[0]!.unitMinor).toBe(1499);
    expect(raised.totalMinor).toBe(3127);
    expect(CartApproval.safeParse(raised).error?.issues ?? []).toEqual([]);
    expect(cart.totalMinor).toBe(1127);
  });

  it("forgeOffer re-signs under the same kid with another key: the real key no longer verifies it", () => {
    const merchant = generateEd25519KeyPair();
    const payload = { type: "offer", v: 1, offerId: "off_1" } as unknown as SignedOffer["payload"];
    const offer = signEnvelope(payload, merchant.privateKey, "agt_m_demo") as SignedOffer;
    expect(verifyEnvelope(offer, merchant.publicKey, "agt_m_demo", "offer")).toBe(true);
    const forged = forgeOffer(offer);
    expect(forged.kid).toBe("agt_m_demo");
    expect(forged.payload).toEqual(offer.payload);
    expect(verifyEnvelope(forged, merchant.publicKey, "agt_m_demo", "offer")).toBe(false);
    const attacker = generateEd25519KeyPair();
    expect(verifyEnvelope(forgeOffer(offer, {}, attacker.privateKey), attacker.publicKey, "agt_m_demo", "offer")).toBe(true);
  });

  it("resignRequest signs the tampered body with the agent key; the old signature no longer covers it", () => {
    const agent = generateEd25519KeyPair();
    const r = { requestId: "req_1", offer: {}, authorization: { kind: "passkey" }, agentSig: "x", kid: "agt_c_demo" };
    const tampered = { ...r, requestId: "req_2" } as unknown as PaymentRequest;
    const resigned = resignRequest(tampered, agent.privateKey);
    const input = paymentRequestSigningInput({
      requestId: "req_2",
      offer: tampered.offer,
      authorization: tampered.authorization,
    });
    expect(verifyPayload(input, resigned.agentSig, agent.publicKey)).toBe(true);
    expect(verifyPayload(input, r.agentSig, agent.publicKey)).toBe(false);
  });
});
