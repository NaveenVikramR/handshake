// M4 acceptance: the split-order attack is blocked by the real Postgres ledger, including when the
// orders race. Runs against the Neon dev branch only with DB_TESTS=1 (`pnpm test:db`); creates its
// own user + mandate rows and deletes them afterwards.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/index.js";
import { prismaMandateLedger } from "../src/mandate-ledger.js";

const enabled = process.env.DB_TESTS === "1";
const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (enabled && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

describe.skipIf(!enabled)("mandate ledger on Postgres (DB_TESTS=1)", () => {
  const db = enabled ? createDb() : (undefined as never);
  const ledger = enabled ? prismaMandateLedger(db) : (undefined as never);
  const tag = randomBytes(6).toString("hex");
  const userId = `usr_ledger${tag}`;
  const mandateIds: string[] = [];
  const LIMIT = 8000;
  const PER_ORDER = 3000;

  async function newMandate(): Promise<string> {
    const id = `man_ledger${tag}${mandateIds.length}`;
    mandateIds.push(id);
    await db.mandate.create({
      data: { id, userId, payloadJson: {}, hash: `h${id}`, status: "active", pendingUntil: new Date() },
    });
    return id;
  }

  beforeAll(async () => {
    await db.user.create({ data: { id: userId, displayName: "ledger test" } });
  });

  afterAll(async () => {
    await db.mandateSpend.deleteMany({ where: { mandateId: { in: mandateIds } } });
    await db.mandate.deleteMany({ where: { id: { in: mandateIds } } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it("split orders in sequence: 3000 + 3000 succeed, the third 3000 is refused", async () => {
    const key = { mandateId: await newMandate(), periodStart: 1_762_128_000 };
    const order = { ...key, amountMinor: PER_ORDER, limitMinor: LIMIT };
    expect(await ledger.reserve(order)).toBe(true);
    expect(await ledger.reserve(order)).toBe(true);
    expect(await ledger.reserve(order)).toBe(false);
    expect(await ledger.spent(key)).toBe(6000);
  });

  it("split orders racing: 4 concurrent 3000s against 8000 → exactly 2 succeed", async () => {
    const key = { mandateId: await newMandate(), periodStart: 1_762_128_000 };
    const order = { ...key, amountMinor: PER_ORDER, limitMinor: LIMIT };
    const results = await Promise.all([1, 2, 3, 4].map(() => ledger.reserve(order)));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await ledger.spent(key)).toBe(6000);
  });

  it("release frees the amount; a later order then fits", async () => {
    const key = { mandateId: await newMandate(), periodStart: 1_762_128_000 };
    const order = { ...key, amountMinor: PER_ORDER, limitMinor: LIMIT };
    await ledger.reserve(order);
    await ledger.reserve(order);
    expect(await ledger.release({ ...key, amountMinor: PER_ORDER })).toBe(true);
    expect(await ledger.spent(key)).toBe(3000);
    expect(await ledger.reserve({ ...key, amountMinor: 5000, limitMinor: LIMIT })).toBe(true);
    // Over-release is refused and leaves other reservations intact.
    expect(await ledger.release({ ...key, amountMinor: 999_999 })).toBe(false);
    expect(await ledger.spent(key)).toBe(8000);
  });

  it("reservation inside a caller transaction rolls back with it", async () => {
    const key = { mandateId: await newMandate(), periodStart: 1_762_128_000 };
    await expect(
      db.$transaction(async (tx) => {
        expect(await ledger.reserve({ ...key, amountMinor: 3000, limitMinor: LIMIT }, tx)).toBe(true);
        throw new Error("gate failed later");
      }),
    ).rejects.toThrow("gate failed later");
    expect(await ledger.spent(key)).toBe(0);
  });
});
