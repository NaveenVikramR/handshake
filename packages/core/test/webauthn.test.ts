import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { b64urlEncode, hash } from "../src/crypto.js";
import { HandshakeError, type ErrorCode } from "../src/errors.js";
import type { WebAuthnAssertion } from "../src/schemas.js";
import {
  approvalChallenge,
  signCountAcceptable,
  verifyApprovalAssertion,
  type PasskeyCredential,
} from "../src/webauthn.js";
import { FakeAuthenticator, type AssertOptions } from "./fake-authenticator.js";
import { cart } from "./fixtures.js";

const ctx = { expectedOrigin: "https://wallet.handshake.test", expectedRpId: "wallet.handshake.test" };

function setup(counting = true) {
  const auth = new FakeAuthenticator(ctx.expectedRpId, ctx.expectedOrigin, counting);
  const credential: PasskeyCredential = {
    credentialId: auth.credentialId,
    userId: cart.userId,
    publicKey: auth.publicKeyCose,
    signCount: 0,
  };
  const sign = (opts: AssertOptions = {}, payload: unknown = cart) => auth.assert(hash(payload), opts);
  return { auth, credential, sign };
}

async function codeOf(p: Promise<unknown>): Promise<ErrorCode | "ok"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof HandshakeError) return e.code;
    throw e;
  }
}

describe("approvalChallenge", () => {
  it("is the raw SHA-256 bytes whose base64url is hash(payload)", () => {
    const bytes = approvalChallenge(cart);
    expect(bytes).toHaveLength(32);
    expect(b64urlEncode(bytes)).toBe(hash(cart));
  });
});

describe("verifyApprovalAssertion — positive", () => {
  it("accepts a UV assertion over hash(cart) and returns the new sign count", async () => {
    const { credential, sign } = setup();
    expect(await verifyApprovalAssertion(cart, sign(), credential, ctx)).toEqual({ newSignCount: 1 });
  });

  it("accepts an increasing count from a counting authenticator", async () => {
    const { credential, sign } = setup();
    const first = await verifyApprovalAssertion(cart, sign(), credential, ctx);
    const second = await verifyApprovalAssertion(cart, sign(), { ...credential, signCount: first.newSignCount }, ctx);
    expect(second.newSignCount).toBe(2);
  });

  it("accepts 0 → 0 from a synced passkey that never counts (D12)", async () => {
    const { credential, sign } = setup(false);
    expect(await verifyApprovalAssertion(cart, sign(), credential, ctx)).toEqual({ newSignCount: 0 });
    expect(await verifyApprovalAssertion(cart, sign(), credential, ctx)).toEqual({ newSignCount: 0 });
  });
});

describe("verifyApprovalAssertion — each broken property fails closed", () => {
  it("UV missing → APPROVAL_UV_MISSING", async () => {
    const { credential, sign } = setup();
    expect(await codeOf(verifyApprovalAssertion(cart, sign({ uv: false }), credential, ctx))).toBe(
      "APPROVAL_UV_MISSING",
    );
  });

  it("UP missing → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    expect(await codeOf(verifyApprovalAssertion(cart, sign({ up: false }), credential, ctx))).toBe("APPROVAL_INVALID");
  });

  it("signCount rollback → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    const stored = { ...credential, signCount: 5 };
    expect(await codeOf(verifyApprovalAssertion(cart, sign({ signCount: 4 }), stored, ctx))).toBe("APPROVAL_INVALID");
  });

  it("signCount repeated (replayed assertion) → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    const a = sign();
    const { newSignCount } = await verifyApprovalAssertion(cart, a, credential, ctx);
    expect(await codeOf(verifyApprovalAssertion(cart, a, { ...credential, signCount: newSignCount }, ctx))).toBe(
      "APPROVAL_INVALID",
    );
  });

  it("counting authenticator dropping to 0 → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    const stored = { ...credential, signCount: 3 };
    expect(await codeOf(verifyApprovalAssertion(cart, sign({ signCount: 0 }), stored, ctx))).toBe("APPROVAL_INVALID");
  });

  it("wrong origin → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    const a = sign({ origin: "https://evil.example" });
    expect(await codeOf(verifyApprovalAssertion(cart, a, credential, ctx))).toBe("APPROVAL_INVALID");
  });

  it("look-alike origin (http, subdomain, trailing slash) → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    for (const origin of [
      "http://wallet.handshake.test",
      "https://x.wallet.handshake.test",
      `${ctx.expectedOrigin}/`,
    ]) {
      expect(await codeOf(verifyApprovalAssertion(cart, sign({ origin }), credential, ctx))).toBe("APPROVAL_INVALID");
    }
  });

  it("cross-origin iframe → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    expect(await codeOf(verifyApprovalAssertion(cart, sign({ crossOrigin: true }), credential, ctx))).toBe(
      "APPROVAL_INVALID",
    );
  });

  it("wrong rpId → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    expect(await codeOf(verifyApprovalAssertion(cart, sign({ rpId: "evil.example" }), credential, ctx))).toBe(
      "APPROVAL_INVALID",
    );
  });

  it("wrong challenge → CART_HASH_MISMATCH", async () => {
    const { credential, sign } = setup();
    const a = sign({ challenge: hash({ something: "else" }) });
    expect(await codeOf(verifyApprovalAssertion(cart, a, credential, ctx))).toBe("CART_HASH_MISMATCH");
  });

  it("cart changed after approval (amount raised) → CART_HASH_MISMATCH", async () => {
    const { credential, sign } = setup();
    const a = sign();
    const tampered = {
      ...cart,
      items: [{ ...cart.items[0]!, unitMinor: cart.items[0]!.unitMinor + 1000 }, ...cart.items.slice(1)],
      totalMinor: cart.totalMinor + 1000,
    };
    expect(await codeOf(verifyApprovalAssertion(tampered, a, credential, ctx))).toBe("CART_HASH_MISMATCH");
  });

  it("ship-to changed after approval → CART_HASH_MISMATCH", async () => {
    const { credential, sign } = setup();
    const a = sign();
    const moved = { ...cart, shipToHash: hash({ line1: "9 Elsewhere Rd" }) };
    expect(await codeOf(verifyApprovalAssertion(moved, a, credential, ctx))).toBe("CART_HASH_MISMATCH");
  });

  it("registration clientData type (webauthn.create) → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    expect(await codeOf(verifyApprovalAssertion(cart, sign({ type: "webauthn.create" }), credential, ctx))).toBe(
      "APPROVAL_INVALID",
    );
  });

  it("tampered signature → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    expect(await codeOf(verifyApprovalAssertion(cart, sign({ tamperSignature: true }), credential, ctx))).toBe(
      "APPROVAL_INVALID",
    );
  });

  it("signed by a different key → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    expect(await codeOf(verifyApprovalAssertion(cart, sign({ signWith: other }), credential, ctx))).toBe(
      "APPROVAL_INVALID",
    );
  });

  it("assertion for another credential id → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    const a = { ...sign(), credentialId: new FakeAuthenticator(ctx.expectedRpId, ctx.expectedOrigin).credentialId };
    expect(await codeOf(verifyApprovalAssertion(cart, a, credential, ctx))).toBe("APPROVAL_INVALID");
  });

  it("valid assertion from another user's authenticator against this credential → APPROVAL_INVALID", async () => {
    const { credential } = setup();
    const mallory = new FakeAuthenticator(ctx.expectedRpId, ctx.expectedOrigin);
    const a = { ...mallory.assert(hash(cart)), credentialId: credential.credentialId };
    expect(await codeOf(verifyApprovalAssertion(cart, a, credential, ctx))).toBe("APPROVAL_INVALID");
  });

  it.each<[string, (a: WebAuthnAssertion) => WebAuthnAssertion]>([
    ["non-base64url clientDataJSON", (a) => ({ ...a, clientDataJSON: "not base64!" })],
    ["clientDataJSON not JSON", (a) => ({ ...a, clientDataJSON: b64urlEncode(Buffer.from("nope")) })],
    [
      "clientDataJSON missing challenge",
      (a) => ({ ...a, clientDataJSON: b64urlEncode(Buffer.from('{"type":"webauthn.get","origin":"x"}')) }),
    ],
    ["short authenticatorData", (a) => ({ ...a, authenticatorData: b64urlEncode(Buffer.alloc(10)) })],
    ["empty signature", (a) => ({ ...a, signature: "" })],
    ["garbage signature", (a) => ({ ...a, signature: b64urlEncode(Buffer.from("garbage")) })],
  ])("malformed: %s → fails closed", async (_name, mutate) => {
    const { credential, sign } = setup();
    const code = await codeOf(verifyApprovalAssertion(cart, mutate(sign()), credential, ctx));
    expect(code).not.toBe("ok");
    expect(["APPROVAL_INVALID", "CART_HASH_MISMATCH"]).toContain(code);
  });

  it("garbage stored public key → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    const broken = { ...credential, publicKey: b64urlEncode(Buffer.from("not a cose key")) };
    expect(await codeOf(verifyApprovalAssertion(cart, sign(), broken, ctx))).toBe("APPROVAL_INVALID");
  });
});

describe("verifyApprovalAssertion — user binding", () => {
  it("own passkey signing a cart that names another user → APPROVAL_INVALID", async () => {
    const { credential, sign } = setup();
    const forVictim = { ...cart, userId: "usr_victim" };
    expect(await codeOf(verifyApprovalAssertion(forVictim, sign({}, forVictim), credential, ctx))).toBe(
      "APPROVAL_INVALID",
    );
  });

  it.each([null, "str", {}, { userId: 7 }])(
    "payload without a string userId (%j) → APPROVAL_INVALID",
    async (payload) => {
      const { credential, sign } = setup();
      expect(await codeOf(verifyApprovalAssertion(payload, sign({}, payload), credential, ctx))).toBe(
        "APPROVAL_INVALID",
      );
    },
  );
});

describe("signCountAcceptable (D12)", () => {
  it.each([
    [0, 0, true],
    [0, 7, true],
    [7, 8, true],
    [7, 7, false],
    [7, 6, false],
    [7, 0, false],
  ])("stored %i, reported %i → %s", (stored, reported, ok) => {
    expect(signCountAcceptable(stored, reported)).toBe(ok);
  });
});
