import { describe, expect, it } from "vitest";
import { ERROR_CODES, HandshakeError, isHandshakeError } from "../src/errors.js";
import { CLOCK_SKEW_S, checkFreshness } from "../src/time.js";

describe("errors", () => {
  it("covers every code named in SPEC §5–§6", () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        "AGENT_SIG_INVALID",
        "AGENT_UNTRUSTED",
        "APPROVAL_EXPIRED",
        "APPROVAL_INVALID",
        "APPROVAL_REPLAY",
        "APPROVAL_UV_MISSING",
        "CART_HASH_MISMATCH",
        "CART_MISMATCH",
        "DUPLICATE_REQUEST",
        "MANDATE_INVALID",
        "MANDATE_LIMIT",
        "MANDATE_SCOPE",
        "MERCHANT_UNTRUSTED",
        "OFFER_EXPIRED",
        "OFFER_SIG_INVALID",
        "OFFER_USED",
        "PAYPAL_ERROR",
        "RISK_BLOCKED",
        "SCHEMA_INVALID",
        "STEP_UP_REQUIRED",
      ].sort(),
    );
  });

  it("HandshakeError carries code, status and serialises without stack", () => {
    const e = new HandshakeError("CART_MISMATCH", "total differs", { cause: new Error("x") });
    expect(e).toBeInstanceOf(Error);
    expect(isHandshakeError(e)).toBe(true);
    expect(e.code).toBe("CART_MISMATCH");
    expect(e.status).toBe(422);
    expect(e.name).toBe("HandshakeError");
    expect(JSON.parse(JSON.stringify(e))).toEqual({
      code: "CART_MISMATCH",
      message: "total differs",
    });
  });

  it("only DUPLICATE_REQUEST maps to a success status", () => {
    for (const code of ERROR_CODES) {
      const { status } = new HandshakeError(code);
      if (code === "DUPLICATE_REQUEST") expect(status).toBe(200);
      else expect(status).toBeGreaterThanOrEqual(400);
    }
  });

  it("isHandshakeError rejects look-alikes", () => {
    expect(isHandshakeError({ name: "HandshakeError", code: "OFFER_USED" })).toBe(false);
    expect(isHandshakeError(new Error("OFFER_USED"))).toBe(false);
  });
});

describe("checkFreshness", () => {
  const now = 1_762_000_000;
  it("accepts within window and within skew", () => {
    expect(checkFreshness({ iat: now - 10, exp: now + 10 }, now)).toBe("ok");
    expect(checkFreshness({ iat: now + CLOCK_SKEW_S, exp: now + 300 }, now)).toBe("ok");
    expect(checkFreshness({ iat: now - 300, exp: now - CLOCK_SKEW_S }, now)).toBe("ok");
  });

  it("rejects expired beyond skew", () => {
    expect(checkFreshness({ iat: now - 300, exp: now - CLOCK_SKEW_S - 1 }, now)).toBe("expired");
  });

  it("rejects issued in the future beyond skew", () => {
    expect(checkFreshness({ iat: now + CLOCK_SKEW_S + 1, exp: now + 300 }, now)).toBe("not_yet_valid");
  });

  it("fails closed on non-integer input", () => {
    expect(checkFreshness({ iat: now, exp: Number.NaN }, now)).toBe("expired");
    expect(checkFreshness({ iat: now, exp: now + 10 }, Number.NaN)).toBe("expired");
  });
});
