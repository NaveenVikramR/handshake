import { describe, expect, it } from "vitest";
import { hash } from "../src/crypto.js";
import { HandshakeError, type ErrorCode } from "../src/errors.js";
import { checkMandateScope, periodStart, verifyMandateApproval } from "../src/mandate.js";
import { CartApproval, IntentMandate } from "../src/schemas.js";
import { FakeAuthenticator } from "./fake-authenticator.js";
import { cart as cartFixture, iat, mandate as mandateFixture } from "./fixtures.js";

const mandate = IntentMandate.parse(mandateFixture);
const cart = CartApproval.parse(cartFixture);
const ok = { categories: ["grocery", "grocery"], now: iat + 60 };

const utc = (s: string) => Date.parse(s) / 1000;

function codeOf(fn: () => void): ErrorCode | "ok" {
  try {
    fn();
    return "ok";
  } catch (e) {
    if (e instanceof HandshakeError) return e.code;
    throw e;
  }
}

describe("periodStart (UTC calendar buckets, D17)", () => {
  it.each([
    ["day", "2026-11-04T23:59:59Z", "2026-11-04T00:00:00Z"],
    ["day", "2026-11-05T00:00:00Z", "2026-11-05T00:00:00Z"],
    // 2026-11-02 is a Monday.
    ["week", "2026-11-02T00:00:00Z", "2026-11-02T00:00:00Z"],
    ["week", "2026-11-04T12:00:00Z", "2026-11-02T00:00:00Z"],
    ["week", "2026-11-08T23:59:59Z", "2026-11-02T00:00:00Z"],
    ["week", "2026-11-09T00:00:00Z", "2026-11-09T00:00:00Z"],
    ["week", "2027-01-01T10:00:00Z", "2026-12-28T00:00:00Z"], // week spans the year boundary
    ["month", "2026-11-30T23:59:59Z", "2026-11-01T00:00:00Z"],
    ["month", "2026-12-01T00:00:00Z", "2026-12-01T00:00:00Z"],
    ["month", "2028-02-29T12:00:00Z", "2028-02-01T00:00:00Z"], // leap day
  ] as const)("%s bucket of %s starts %s", (period, at, start) => {
    expect(periodStart(period, utc(at))).toBe(utc(start));
  });

  it("is timezone-independent: IST Monday 01:00 is still Sunday UTC → previous week", () => {
    // 2026-11-09 01:00 IST = 2026-11-08 19:30 UTC
    expect(periodStart("week", utc("2026-11-08T19:30:00Z"))).toBe(utc("2026-11-02T00:00:00Z"));
  });
});

describe("checkMandateScope", () => {
  it("accepts an in-scope cart within the per-order limit", () => {
    expect(codeOf(() => checkMandateScope(mandate, cart, ok))).toBe("ok");
  });

  it("accepts exactly the per-order limit", () => {
    const atLimit = { ...cart, items: [{ sku: "RICE-2KG", name: "Rice", qty: 1, unitMinor: 3000 }], totalMinor: 3000 };
    expect(codeOf(() => checkMandateScope(mandate, atLimit, { ...ok, categories: ["grocery"] }))).toBe("ok");
  });

  it.each<[string, Partial<typeof cart>, Partial<typeof ok>, ErrorCode]>([
    ["merchant not in scope", { merchantId: "mer_other" }, {}, "MANDATE_SCOPE"],
    ["one item outside the categories", {}, { categories: ["grocery", "electronics"] }, "MANDATE_SCOPE"],
    ["category missing for an item", {}, { categories: ["grocery"] }, "MANDATE_SCOPE"],
    ["ship-to changed", { shipToHash: hash({ line1: "9 Elsewhere Rd" }) }, {}, "MANDATE_SCOPE"],
    ["another user's cart", { userId: "usr_bob" }, {}, "MANDATE_INVALID"],
    ["another agent's cart", { consumerAgentId: "agt_c_mallory" }, {}, "MANDATE_INVALID"],
    ["mandate expired", {}, { now: mandate.exp + 61 }, "MANDATE_INVALID"],
    ["mandate not yet valid", {}, { now: mandate.iat - 61 }, "MANDATE_INVALID"],
  ])("%s → %s", (_name, cartPatch, ctxPatch, code) => {
    expect(codeOf(() => checkMandateScope(mandate, { ...cart, ...cartPatch }, { ...ok, ...ctxPatch }))).toBe(code);
  });

  it("one minor unit over the per-order limit → MANDATE_LIMIT", () => {
    const over = { ...cart, items: [{ sku: "RICE-2KG", name: "Rice", qty: 1, unitMinor: 3001 }], totalMinor: 3001 };
    expect(codeOf(() => checkMandateScope(mandate, over, { ...ok, categories: ["grocery"] }))).toBe("MANDATE_LIMIT");
  });
});

describe("verifyMandateApproval", () => {
  const ctx = { expectedOrigin: "https://wallet.handshake.test", expectedRpId: "wallet.handshake.test" };
  const setup = () => {
    const auth = new FakeAuthenticator(ctx.expectedRpId, ctx.expectedOrigin);
    const credential = {
      credentialId: auth.credentialId,
      userId: mandate.userId,
      publicKey: auth.publicKeyCose,
      signCount: 0,
    };
    return { auth, credential };
  };

  it("accepts a UV passkey assertion over hash(mandate)", async () => {
    const { auth, credential } = setup();
    await expect(
      verifyMandateApproval(mandate, auth.assert(hash(mandate)), credential, ctx, { fresh: true }),
    ).resolves.toEqual({
      newSignCount: 1,
    });
  });

  it.each([
    ["limits raised after approval", { limits: { ...mandate.limits, periodMinor: 80000 } }],
    ["merchant added after approval", { scope: { ...mandate.scope, merchants: ["mer_corner", "mer_evil"] } }],
    ["expiry extended after approval", { exp: mandate.exp + 86400 }],
  ])("%s → MANDATE_INVALID", async (_n, patch) => {
    const { auth, credential } = setup();
    const a = auth.assert(hash(mandate));
    await expect(
      verifyMandateApproval({ ...mandate, ...patch }, a, credential, ctx, { fresh: true }),
    ).rejects.toMatchObject({
      code: "MANDATE_INVALID",
    });
  });

  it("UV missing → MANDATE_INVALID (reason keeps APPROVAL_UV_MISSING)", async () => {
    const { auth, credential } = setup();
    const err = await verifyMandateApproval(mandate, auth.assert(hash(mandate), { uv: false }), credential, ctx, {
      fresh: true,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "MANDATE_INVALID" });
    expect((err as Error).message).toContain("APPROVAL_UV_MISSING");
  });

  it("fresh (activation): replaying the same counted assertion → MANDATE_INVALID", async () => {
    const { auth, credential } = setup();
    const a = auth.assert(hash(mandate));
    const { newSignCount } = await verifyMandateApproval(mandate, a, credential, ctx, { fresh: true });
    await expect(
      verifyMandateApproval(mandate, a, { ...credential, signCount: newSignCount }, ctx, { fresh: true }),
    ).rejects.toMatchObject({ code: "MANDATE_INVALID" });
  });

  it("stored proof (gate, every order): the same counted assertion verifies again and again", async () => {
    const { auth, credential } = setup();
    auth.assert(hash(cart)); // the authenticator has counted past this assertion since
    const a = auth.assert(hash(mandate));
    const later = { ...credential, signCount: 7 };
    for (let i = 0; i < 3; i++) {
      await expect(verifyMandateApproval(mandate, a, later, ctx, { fresh: false })).resolves.toBeDefined();
    }
  });

  it("stored proof still rejects tampering, UV missing and another user's key", async () => {
    const { auth, credential } = setup();
    const a = auth.assert(hash(mandate));
    const raised = { ...mandate, limits: { ...mandate.limits, periodMinor: 80000 } };
    await expect(verifyMandateApproval(raised, a, credential, ctx, { fresh: false })).rejects.toMatchObject({
      code: "MANDATE_INVALID",
    });
    const noUv = auth.assert(hash(mandate), { uv: false });
    await expect(verifyMandateApproval(mandate, noUv, credential, ctx, { fresh: false })).rejects.toMatchObject({
      code: "MANDATE_INVALID",
    });
    const mallory = new FakeAuthenticator(ctx.expectedRpId, ctx.expectedOrigin);
    const forged = { ...mallory.assert(hash(mandate)), credentialId: credential.credentialId };
    await expect(verifyMandateApproval(mandate, forged, credential, ctx, { fresh: false })).rejects.toMatchObject({
      code: "MANDATE_INVALID",
    });
  });

  it("a cart approval assertion can't activate a mandate (domain separation by payload type)", async () => {
    const { auth, credential } = setup();
    await expect(
      verifyMandateApproval(mandate, auth.assert(hash(cart)), credential, ctx, { fresh: true }),
    ).rejects.toMatchObject({
      code: "MANDATE_INVALID",
    });
  });
});
