import { describe, expect, it } from "vitest";
import { memoryMandateLedger } from "../src/mandate-ledger.js";

const key = { mandateId: "man_1", periodStart: 1_762_128_000 };
const LIMIT = 8000;

describe("memory mandate ledger", () => {
  it("split orders: 3000 + 3000 fit an 8000 period, the third is refused", async () => {
    const ledger = memoryMandateLedger();
    expect(await ledger.reserve({ ...key, amountMinor: 3000, limitMinor: LIMIT })).toBe(true);
    expect(await ledger.reserve({ ...key, amountMinor: 3000, limitMinor: LIMIT })).toBe(true);
    expect(await ledger.reserve({ ...key, amountMinor: 3000, limitMinor: LIMIT })).toBe(false);
    expect(await ledger.spent(key)).toBe(6000);
  });

  it("allows exactly reaching the limit, not one unit more", async () => {
    const ledger = memoryMandateLedger();
    expect(await ledger.reserve({ ...key, amountMinor: 8000, limitMinor: LIMIT })).toBe(true);
    expect(await ledger.reserve({ ...key, amountMinor: 1, limitMinor: LIMIT })).toBe(false);
  });

  it("release frees the amount for a later order", async () => {
    const ledger = memoryMandateLedger();
    await ledger.reserve({ ...key, amountMinor: 6000, limitMinor: LIMIT });
    expect(await ledger.release({ ...key, amountMinor: 3000 })).toBe(true);
    expect(await ledger.reserve({ ...key, amountMinor: 5000, limitMinor: LIMIT })).toBe(true);
  });

  it("over-release is refused and changes nothing (no clamp wiping other orders)", async () => {
    const ledger = memoryMandateLedger();
    await ledger.reserve({ ...key, amountMinor: 5000, limitMinor: LIMIT });
    expect(await ledger.release({ ...key, amountMinor: 5001 })).toBe(false);
    expect(await ledger.spent(key)).toBe(5000);
  });

  it("buckets are independent: a new week starts from 0", async () => {
    const ledger = memoryMandateLedger();
    await ledger.reserve({ ...key, amountMinor: 8000, limitMinor: LIMIT });
    const nextWeek = { ...key, periodStart: key.periodStart + 7 * 86400 };
    expect(await ledger.reserve({ ...nextWeek, amountMinor: 8000, limitMinor: LIMIT })).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])("rejects amount %s", async (amountMinor) => {
    const ledger = memoryMandateLedger();
    await expect(ledger.reserve({ ...key, amountMinor, limitMinor: LIMIT })).rejects.toThrow();
  });
});
