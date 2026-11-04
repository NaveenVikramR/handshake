import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@handshake/core";
import { adminSessionValid, adminSessionValue } from "../lib/server";
import {
  DASHBOARD_CODES,
  FALLBACK_REASON,
  REASONS,
  approveLabel,
  countdown,
  money,
  orderPill,
  reasonFor,
} from "../lib/ui";

describe("human reasons (docs/DESIGN.md)", () => {
  it("every gate code a user can hit has a plain line; anything else falls back", () => {
    const shown = ERROR_CODES.filter((c) => c !== "DUPLICATE_REQUEST");
    for (const c of [...shown, ...DASHBOARD_CODES]) expect(REASONS[c], c).toBeTruthy();
    // No line is ever just the code.
    for (const [c, line] of Object.entries(REASONS)) expect(line).not.toContain(c);
    expect(reasonFor("SOMETHING_NEW")).toBe(FALLBACK_REASON);
    expect(reasonFor(undefined)).toBe(FALLBACK_REASON);
    expect(reasonFor("CART_HASH_MISMATCH")).toBe("Cart changed after you approved it");
  });

  it("order states in words", () => {
    expect(orderPill("authorized")).toEqual({ label: "Held", tone: "warn" });
    expect(orderPill("captured")).toEqual({ label: "Paid", tone: "ok" });
    expect(orderPill("offered", true)).toEqual({ label: "Waiting for PayPal approval", tone: "warn" });
    expect(orderPill("failed").tone).toBe("bad");
  });

  it("formatting", () => {
    expect(money(1648)).toBe("$16.48");
    expect(countdown(292_000)).toBe("4:52");
    expect(countdown(-5)).toBe("0:00");
    expect(approveLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("Approve with Face ID");
    expect(approveLabel("Mozilla/5.0 (Linux; Android 15)")).toBe("Approve with passkey");
  });
});

describe("admin session cookie", () => {
  const token = "admin-token-0123456789abcdef";
  it("valid until it expires, and only for the token that signed it", () => {
    const v = adminSessionValue(token, 1000);
    expect(adminSessionValid(v, token, 1001)).toBe(true);
    expect(adminSessionValid(v, token, 1000 + 8 * 3600)).toBe(false);
    expect(adminSessionValid(v, "another-token-0123456789abcdef", 1001)).toBe(false);
  });

  it("tampering with the expiry or signature fails", () => {
    const [exp, sig] = adminSessionValue(token, 1000).split(".");
    expect(adminSessionValid(`${Number(exp) + 1}.${sig}`, token, 1001)).toBe(false);
    expect(adminSessionValid(`${exp}.x${sig}`, token, 1001)).toBe(false);
    expect(adminSessionValid(undefined, token, 1001)).toBe(false);
    expect(adminSessionValid("garbage", token, 1001)).toBe(false);
  });
});
