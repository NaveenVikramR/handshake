import { describe, expect, it } from "vitest";
import { generateEd25519KeyPair, publicKeyFromPrivate, randomNonce, signEnvelope } from "../src/crypto.js";
import { HandshakeError, type ErrorCode } from "../src/errors.js";
import { MAX_OFFER_REQUEST_TTL_S, OfferRequest, SignedOfferRequest } from "../src/schemas.js";
import { CLOCK_SKEW_S } from "../src/time.js";
import { verifyOfferRequestEnvelope } from "../src/verify.js";
import { iat } from "./fixtures.js";

const keys = generateEd25519KeyPair();
const otherKeys = generateEd25519KeyPair();
const alice = { id: "agt_c_alice", publicKey: keys.publicKey };
const mallory = { id: "agt_c_mallory", publicKey: otherKeys.publicKey };

const request: OfferRequest = {
  v: 1,
  type: "offer_request",
  consumerAgentId: "agt_c_alice",
  merchantId: "mer_corner",
  items: [
    { sku: "RICE-2KG", qty: 2 },
    { sku: "DET-1L", qty: 1 },
  ],
  iat,
  exp: iat + 60,
  nonce: randomNonce(),
};

const signed = (payload: object = request, key = keys.privateKey, kid = "agt_c_alice") =>
  SignedOfferRequest.parse(signEnvelope(payload as OfferRequest, key, kid));

function codeOf(fn: () => void): ErrorCode | "none" {
  try {
    fn();
    return "none";
  } catch (e) {
    if (e instanceof HandshakeError) return e.code;
    throw e;
  }
}

describe("publicKeyFromPrivate", () => {
  it("derives the key pair's public key", () => {
    expect(publicKeyFromPrivate(keys.privateKey)).toBe(keys.publicKey);
    expect(publicKeyFromPrivate(otherKeys.privateKey)).not.toBe(keys.publicKey);
  });

  it("rejects a malformed private key", () => {
    expect(() => publicKeyFromPrivate("not-a-key")).toThrow();
    expect(() => publicKeyFromPrivate(keys.publicKey)).toThrow();
  });
});

describe("OfferRequest schema", () => {
  it("accepts a well-formed request", () => {
    expect(OfferRequest.safeParse(request).success).toBe(true);
  });

  it.each([
    [
      "duplicate sku",
      {
        items: [
          { sku: "RICE-2KG", qty: 1 },
          { sku: "RICE-2KG", qty: 1 },
        ],
      },
    ],
    ["qty 0", { items: [{ sku: "RICE-2KG", qty: 0 }] }],
    ["no items", { items: [] }],
    ["a client-set price", { items: [{ sku: "RICE-2KG", qty: 1, unitMinor: 1 }] }],
    ["lifetime over the max", { exp: iat + MAX_OFFER_REQUEST_TTL_S + 1 }],
    ["wrong type", { type: "offer" }],
    ["unknown field", { totalMinor: 1 }],
  ])("rejects %s", (_n, patch) => {
    expect(OfferRequest.safeParse({ ...request, ...patch }).success).toBe(false);
  });
});

describe("verifyOfferRequestEnvelope", () => {
  const now = iat + 10;

  it("accepts a request signed by the named, registered agent", () => {
    expect(codeOf(() => verifyOfferRequestEnvelope(signed(), alice, "mer_corner", now))).toBe("none");
  });

  it.each<[string, () => SignedOfferRequest, typeof alice, string, number]>([
    ["signed by another key", () => signed(request, otherKeys.privateKey), alice, "mer_corner", now],
    [
      "kid names another agent",
      () => signed(request, otherKeys.privateKey, "agt_c_mallory"),
      mallory,
      "mer_corner",
      now,
    ],
    [
      "payload tampered after signing",
      () => ({ ...signed(), payload: { ...request, items: [{ sku: "RICE-2KG", qty: 900 }] } }),
      alice,
      "mer_corner",
      now,
    ],
    ["addressed to another merchant", () => signed(), alice, "mer_other", now],
    ["expired", () => signed(), alice, "mer_corner", request.exp + CLOCK_SKEW_S + 1],
    ["not yet valid", () => signed(), alice, "mer_corner", iat - CLOCK_SKEW_S - 1],
  ])("%s → AGENT_SIG_INVALID", (_n, make, agent, merchantId, at) => {
    expect(codeOf(() => verifyOfferRequestEnvelope(make(), agent, merchantId, at))).toBe("AGENT_SIG_INVALID");
  });

  it("a signed offer can't pass as an offer request (domain separation)", () => {
    const asOffer = { ...signed(), payload: { ...request } };
    const forged = signEnvelope({ ...request, type: "offer" } as unknown as OfferRequest, keys.privateKey, alice.id);
    expect(codeOf(() => verifyOfferRequestEnvelope({ ...asOffer, sig: forged.sig }, alice, "mer_corner", now))).toBe(
      "AGENT_SIG_INVALID",
    );
  });
});
