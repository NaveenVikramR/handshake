import { describe, expect, it } from "vitest";
import { generateEd25519KeyPair, signEnvelope, signPayload } from "../src/crypto.js";
import { HandshakeError, type ErrorCode } from "../src/errors.js";
import { PaymentRequest, paymentRequestSigningInput, type Authorization, type SignedOffer } from "../src/schemas.js";
import { CLOCK_SKEW_S } from "../src/time.js";
import { checkMandateCartBinding, verifyOfferEnvelope, verifyPaymentRequestSig } from "../src/verify.js";
import { assertion, cart, iat, mandate, offer } from "./fixtures.js";

const merchantKeys = generateEd25519KeyPair();
const otherMerchantKeys = generateEd25519KeyPair();
const consumerKeys = generateEd25519KeyPair();
const otherConsumerKeys = generateEd25519KeyPair();

const merchant = { id: "agt_m_corner", publicKey: merchantKeys.publicKey };
const otherMerchant = { id: "agt_m_other", publicKey: otherMerchantKeys.publicKey };
const consumer = { id: "agt_c_alice", publicKey: consumerKeys.publicKey };
const mallory = { id: "agt_c_mallory", publicKey: otherConsumerKeys.publicKey };

const signedOffer: SignedOffer = signEnvelope(offer, merchantKeys.privateKey, merchant.id);
const passkeyAuth = { kind: "passkey", cartApproval: cart, assertion } as Authorization;
const mandateAuth = { kind: "mandate", mandate, assertion, cart } as Authorization;

function buildRequest(authorization: Authorization, signer = consumerKeys.privateKey, kid = consumer.id) {
  const body = { requestId: "req_1", offer: signedOffer, authorization };
  return PaymentRequest.parse({ ...body, agentSig: signPayload(paymentRequestSigningInput(body), signer), kid });
}

function codeOf(fn: () => void): ErrorCode | "none" {
  try {
    fn();
    return "none";
  } catch (e) {
    if (e instanceof HandshakeError) return e.code;
    throw e;
  }
}

describe("verifyOfferEnvelope", () => {
  const now = iat + 10;

  it("accepts an offer signed by the merchant agent it names", () => {
    expect(codeOf(() => verifyOfferEnvelope(signedOffer, merchant, now))).toBe("none");
  });

  it("OFFER_SIG_INVALID: signed by a registered key not owned by the named merchant agent", () => {
    const forged = signEnvelope(offer, otherMerchantKeys.privateKey, otherMerchant.id);
    expect(codeOf(() => verifyOfferEnvelope(forged, otherMerchant, now))).toBe("OFFER_SIG_INVALID");
    expect(codeOf(() => verifyOfferEnvelope(forged, merchant, now))).toBe("OFFER_SIG_INVALID");
  });

  it("OFFER_SIG_INVALID: right kid, wrong key", () => {
    const forged = signEnvelope(offer, otherMerchantKeys.privateKey, merchant.id);
    expect(codeOf(() => verifyOfferEnvelope(forged, merchant, now))).toBe("OFFER_SIG_INVALID");
  });

  it("OFFER_SIG_INVALID: tampered amount", () => {
    const tampered = {
      ...signedOffer,
      payload: { ...offer, totalMinor: 1, items: [{ ...offer.items[0]!, qty: 1, unitMinor: 1 }] },
    };
    expect(codeOf(() => verifyOfferEnvelope(tampered, merchant, now))).toBe("OFFER_SIG_INVALID");
  });

  it("OFFER_EXPIRED: past holdUntil even while exp is still valid", () => {
    const longExp = signEnvelope(
      { ...offer, exp: iat + 3600, holdUntil: iat + 600 },
      merchantKeys.privateKey,
      merchant.id,
    );
    expect(codeOf(() => verifyOfferEnvelope(longExp, merchant, iat + 600))).toBe("none");
    expect(codeOf(() => verifyOfferEnvelope(longExp, merchant, iat + 601))).toBe("OFFER_EXPIRED");
  });

  it("OFFER_EXPIRED: past exp beyond skew, or issued in the future", () => {
    expect(codeOf(() => verifyOfferEnvelope(signedOffer, merchant, offer.exp + CLOCK_SKEW_S + 1))).toBe(
      "OFFER_EXPIRED",
    );
    expect(codeOf(() => verifyOfferEnvelope(signedOffer, merchant, iat - CLOCK_SKEW_S - 1))).toBe("OFFER_EXPIRED");
  });
});

describe("verifyPaymentRequestSig", () => {
  it("accepts both authorization kinds signed by the approved agent", () => {
    expect(codeOf(() => verifyPaymentRequestSig(buildRequest(passkeyAuth), consumer))).toBe("none");
    expect(codeOf(() => verifyPaymentRequestSig(buildRequest(mandateAuth), consumer))).toBe("none");
  });

  it("AGENT_SIG_INVALID: request signed by a different consumer agent than the passkey approval names", () => {
    const req = buildRequest(passkeyAuth, otherConsumerKeys.privateKey, mallory.id);
    expect(codeOf(() => verifyPaymentRequestSig(req, mallory))).toBe("AGENT_SIG_INVALID");
  });

  it("AGENT_SIG_INVALID: mandate or cart names another agent", () => {
    const m = { ...mandateAuth, mandate: { ...mandate, consumerAgentId: "agt_c_mallory" } } as Authorization;
    expect(codeOf(() => verifyPaymentRequestSig(buildRequest(m), consumer))).toBe("AGENT_SIG_INVALID");
    const c = { ...mandateAuth, cart: { ...cart, consumerAgentId: "agt_c_mallory" } } as Authorization;
    expect(codeOf(() => verifyPaymentRequestSig(buildRequest(c), consumer))).toBe("AGENT_SIG_INVALID");
  });

  it("AGENT_SIG_INVALID: kid does not match the registry agent looked up", () => {
    expect(codeOf(() => verifyPaymentRequestSig(buildRequest(passkeyAuth), mallory))).toBe("AGENT_SIG_INVALID");
  });

  it("AGENT_SIG_INVALID: signature from another key or over a tampered body", () => {
    const wrongKey = buildRequest(passkeyAuth, otherConsumerKeys.privateKey);
    expect(codeOf(() => verifyPaymentRequestSig(wrongKey, consumer))).toBe("AGENT_SIG_INVALID");
    const req = buildRequest(passkeyAuth);
    expect(codeOf(() => verifyPaymentRequestSig({ ...req, requestId: "req_2" }, consumer))).toBe("AGENT_SIG_INVALID");
  });

  it("AGENT_SIG_INVALID: signature over the untagged body (no domain separation) is rejected", () => {
    const body = { requestId: "req_1", offer: signedOffer, authorization: passkeyAuth };
    const req = PaymentRequest.parse({
      ...body,
      agentSig: signPayload(body, consumerKeys.privateKey),
      kid: consumer.id,
    });
    expect(codeOf(() => verifyPaymentRequestSig(req, consumer))).toBe("AGENT_SIG_INVALID");
  });

  it("signing input is tagged payment_request v1", () => {
    const input = paymentRequestSigningInput(buildRequest(passkeyAuth));
    expect(input.type).toBe("payment_request");
    expect(input.v).toBe(1);
  });
});

describe("checkMandateCartBinding", () => {
  it("accepts matching users and ignores the passkey path", () => {
    expect(codeOf(() => checkMandateCartBinding(mandateAuth))).toBe("none");
    expect(codeOf(() => checkMandateCartBinding(passkeyAuth))).toBe("none");
  });

  it("MANDATE_INVALID: mandate belongs to another user", () => {
    const a = { ...mandateAuth, mandate: { ...mandate, userId: "usr_bob" } } as Authorization;
    expect(codeOf(() => checkMandateCartBinding(a))).toBe("MANDATE_INVALID");
  });
});
