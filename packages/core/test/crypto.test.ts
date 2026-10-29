import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  b64urlDecode,
  b64urlEncode,
  b64urlEqual,
  generateEd25519KeyPair,
  hash,
  randomNonce,
  signEnvelope,
  signPayload,
  verifyEnvelope,
  verifyPayload,
} from "../src/crypto.js";

const payload = { v: 1, type: "offer", totalMinor: 499, items: [{ sku: "RICE-2KG", qty: 1 }] };

describe("base64url", () => {
  it("round-trips without padding", () => {
    const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0x00]);
    const s = b64urlEncode(bytes);
    expect(s).toBe("-_-_AA");
    expect(b64urlDecode(s)).toEqual(bytes);
  });

  it.each(["ab+c", "ab/c", "abc=", "ab c", "AB"])("rejects invalid or non-canonical %j", (s) => {
    // "AB" decodes to one byte but re-encodes as "AA": non-canonical trailing bits.
    expect(() => b64urlDecode(s)).toThrow(TypeError);
  });
});

describe("hash", () => {
  it("is base64url(SHA-256(JCS(x)))", () => {
    const expected = createHash("sha256")
      .update('{"items":[{"qty":1,"sku":"RICE-2KG"}],"totalMinor":499,"type":"offer","v":1}')
      .digest("base64url");
    expect(hash(payload)).toBe(expected);
    expect(hash(payload)).toHaveLength(43);
  });

  it("ignores key order but changes on any tamper", () => {
    expect(hash({ totalMinor: 499, v: 1 })).toBe(hash({ v: 1, totalMinor: 499 }));
    expect(hash({ ...payload, totalMinor: 498 })).not.toBe(hash(payload));
    expect(hash({ ...payload, currency: "EUR" })).not.toBe(hash(payload));
  });

  it("compares in constant time and fails closed on junk", () => {
    const h = hash(payload);
    expect(b64urlEqual(h, hash({ ...payload }))).toBe(true);
    expect(b64urlEqual(h, hash({ ...payload, totalMinor: 1 }))).toBe(false);
    expect(b64urlEqual(h, h.slice(0, -1))).toBe(false);
    expect(b64urlEqual(h, "not base64!")).toBe(false);
  });
});

describe("randomNonce", () => {
  it("is 16 random bytes, base64url", () => {
    const a = randomNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b64urlDecode(a)).toHaveLength(16);
    expect(randomNonce()).not.toBe(a);
  });
});

describe("Ed25519 sign/verify", () => {
  const keys = generateEd25519KeyPair();
  const other = generateEd25519KeyPair();

  it("verifies a valid signature, regardless of key order", () => {
    const sig = signPayload(payload, keys.privateKey);
    expect(b64urlDecode(sig)).toHaveLength(64);
    expect(verifyPayload(payload, sig, keys.publicKey)).toBe(true);
    const reordered = { items: payload.items, totalMinor: 499, type: "offer", v: 1 };
    expect(verifyPayload(reordered, sig, keys.publicKey)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const sig = signPayload(payload, keys.privateKey);
    expect(verifyPayload({ ...payload, totalMinor: 1 }, sig, keys.publicKey)).toBe(false);
    expect(verifyPayload({ ...payload, extra: true }, sig, keys.publicKey)).toBe(false);
  });

  it("rejects a signature from another key", () => {
    const sig = signPayload(payload, other.privateKey);
    expect(verifyPayload(payload, sig, keys.publicKey)).toBe(false);
  });

  it("rejects a flipped signature bit", () => {
    const raw = b64urlDecode(signPayload(payload, keys.privateKey));
    raw[0] = raw[0]! ^ 1;
    expect(verifyPayload(payload, b64urlEncode(raw), keys.publicKey)).toBe(false);
  });

  it("fails closed on malformed signature, key or payload", () => {
    const sig = signPayload(payload, keys.privateKey);
    expect(verifyPayload(payload, sig.slice(0, -2), keys.publicKey)).toBe(false);
    expect(verifyPayload(payload, "", keys.publicKey)).toBe(false);
    expect(verifyPayload(payload, "!!", keys.publicKey)).toBe(false);
    expect(verifyPayload(payload, sig, "garbage")).toBe(false);
    expect(verifyPayload(payload, sig, keys.privateKey)).toBe(false);
    expect(verifyPayload({ bad: undefined }, sig, keys.publicKey)).toBe(false);
  });

  it("rejects a non-Ed25519 public key", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = b64urlEncode(ec.publicKey.export({ format: "der", type: "spki" }));
    const sig = signPayload(payload, keys.privateKey);
    expect(verifyPayload(payload, sig, spki)).toBe(false);
    const pkcs8 = b64urlEncode(ec.privateKey.export({ format: "der", type: "pkcs8" }));
    expect(() => signPayload(payload, pkcs8)).toThrow();
  });
});

describe("signed envelope", () => {
  const keys = generateEd25519KeyPair();
  const kid = "agt_m_shop1";

  it("signs and verifies {payload, sig, kid}", () => {
    const env = signEnvelope(payload, keys.privateKey, kid);
    expect(Object.keys(env).sort()).toEqual(["kid", "payload", "sig"]);
    expect(verifyEnvelope(env, keys.publicKey, kid, "offer")).toBe(true);
  });

  it("rejects tampered payload, swapped sig or mismatched kid", () => {
    const env = signEnvelope(payload, keys.privateKey, kid);
    expect(verifyEnvelope({ ...env, payload: { ...payload, totalMinor: 1 } }, keys.publicKey, kid, "offer")).toBe(
      false,
    );
    const other = signEnvelope({ ...payload, totalMinor: 1 }, keys.privateKey, kid);
    expect(verifyEnvelope({ ...env, sig: other.sig }, keys.publicKey, kid, "offer")).toBe(false);
    expect(verifyEnvelope({ ...env, kid: "agt_m_evil" }, keys.publicKey, kid, "offer")).toBe(false);
    expect(verifyEnvelope(env, keys.publicKey, "agt_m_evil", "offer")).toBe(false);
  });

  it("enforces domain separation by payload type", () => {
    const mandate = signEnvelope({ ...payload, type: "intent_mandate" }, keys.privateKey, kid);
    expect(verifyEnvelope(mandate, keys.publicKey, kid, "intent_mandate")).toBe(true);
    expect(verifyEnvelope(mandate, keys.publicKey, kid, "offer")).toBe(false);
    const env = signEnvelope(payload, keys.privateKey, kid);
    expect(verifyEnvelope(env, keys.publicKey, kid, "cart_approval")).toBe(false);
    const untyped = { payload: { totalMinor: 499 }, sig: signPayload({ totalMinor: 499 }, keys.privateKey), kid };
    expect(verifyEnvelope(untyped, keys.publicKey, kid, "offer")).toBe(false);
    const arr = { payload: [], sig: signPayload([], keys.privateKey), kid };
    expect(verifyEnvelope(arr, keys.publicKey, kid, "offer")).toBe(false);
  });

  it("fails closed on non-string sig/kid", () => {
    const env = signEnvelope(payload, keys.privateKey, kid);
    const bad = { ...env, sig: 1 } as unknown as typeof env;
    expect(verifyEnvelope(bad, keys.publicKey, kid, "offer")).toBe(false);
  });
});

describe("fail-closed edges", () => {
  it("empty strings are never equal", () => {
    expect(b64urlEqual("", "")).toBe(false);
  });

  it("verifyEnvelope returns false for null", () => {
    const { publicKey } = generateEd25519KeyPair();
    expect(verifyEnvelope(null as never, publicKey, "agt_m_x", "offer")).toBe(false);
  });
});
