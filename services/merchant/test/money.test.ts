import { describe, expect, it } from "vitest";
import { toPayPalValue } from "../src/paypal/money.js";

describe("toPayPalValue", () => {
  it("converts minor units to a 2-decimal string", () => {
    expect(toPayPalValue(499)).toBe("4.99");
    expect(toPayPalValue(100)).toBe("1.00");
    expect(toPayPalValue(5)).toBe("0.05");
    expect(toPayPalValue(123456)).toBe("1234.56");
  });

  it("rejects non-integer, zero, negative and unsafe amounts", () => {
    for (const bad of [4.99, 0, -100, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => toPayPalValue(bad)).toThrow();
    }
  });
});
