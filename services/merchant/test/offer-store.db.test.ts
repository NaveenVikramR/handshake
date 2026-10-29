// M5 on real Postgres: two offers can't both take the last unit, the per-agent cap holds under
// concurrency, and concurrent expiry runs return stock exactly once. Runs only with DB_TESTS=1
// (`pnpm test:db`) against the Neon dev branch; creates its own rows and deletes them afterwards.
import { generateEd25519KeyPair, randomNonce } from "@handshake/core";
import { createDb } from "@handshake/db";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OFFER_HOLD_S, priceOffer, type MerchantSelf } from "../src/offers/service.js";
import { prismaOfferStore, type OfferLine } from "../src/offers/store.js";

const enabled = process.env.DB_TESTS === "1";
const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (enabled && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

describe.skipIf(!enabled)("offer store on Postgres (DB_TESTS=1)", () => {
  const db = enabled ? createDb() : (undefined as never);
  const store = enabled ? prismaOfferStore(db) : (undefined as never);
  const tag = randomBytes(4).toString("hex").toUpperCase();
  const agentId = `agt_c_offers${tag}`;
  const sku = (s: string) => `T${tag}-${s}`;
  const keys = generateEd25519KeyPair();
  const self: MerchantSelf = {
    merchantId: "mer_test",
    merchantAgentId: "agt_m_test",
    paypalMerchantId: "TESTMERCHANT1",
    name: "Test",
    ...keys,
  };
  const T0 = Date.now();

  const create = (lines: OfferLine[], opts: { now?: number; maxOpen?: number } = {}) => {
    const now = opts.now ?? T0;
    return store.createOffer({
      agentId,
      nonce: randomNonce(),
      nonceExp: Math.floor(now / 1000) + 120,
      lines,
      maxOpen: opts.maxOpen ?? 100,
      maxHeldUnits: 100_000,
      now,
      build: (products) => priceOffer(self, lines, products, Math.floor(now / 1000)),
    });
  };
  const stock = async (s: string) => (await db.product.findUniqueOrThrow({ where: { sku: s } })).stock;
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: { code?: string }) => e.code ?? "error",
    );

  beforeAll(async () => {
    await db.registryAgent.create({ data: { id: agentId, role: "consumer", publicKey: keys.publicKey } });
    await db.product.createMany({
      data: [
        { sku: sku("LAST"), name: "Last unit", category: "grocery", priceMinor: 100, stock: 1 },
        { sku: sku("MANY"), name: "Plenty", category: "grocery", priceMinor: 100, stock: 1000 },
        { sku: sku("EXP"), name: "Expiring", category: "grocery", priceMinor: 100, stock: 10 },
      ],
    });
  });

  afterAll(async () => {
    const offers = await db.offer.findMany({ where: { agentId }, select: { id: true } });
    const ids = offers.map((o) => o.id);
    await db.stockHold.deleteMany({ where: { offerId: { in: ids } } });
    await db.offer.deleteMany({ where: { id: { in: ids } } });
    await db.product.deleteMany({ where: { sku: { startsWith: `T${tag}-` } } });
    await db.registryAgent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  it("two offers racing for the last unit: exactly one gets it", async () => {
    const results = await Promise.all([1, 2].map(() => outcome(create([{ sku: sku("LAST"), qty: 1 }]))));
    expect(results.sort()).toEqual(["OUT_OF_STOCK", "ok"]);
    expect(await stock(sku("LAST"))).toBe(0);
  });

  it("overlapping offers in opposite sku order don't deadlock", async () => {
    const [a, b] = [sku("MANY"), sku("EXP")];
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        outcome(
          create(
            i % 2
              ? [
                  { sku: a, qty: 1 },
                  { sku: b, qty: 1 },
                ]
              : [
                  { sku: b, qty: 1 },
                  { sku: a, qty: 1 },
                ],
          ),
        ),
      ),
    );
    expect(results).toEqual(["ok", "ok", "ok", "ok"]);
    expect(await stock(b)).toBe(6);
    // Give the units back by expiring them, so later tests start from known stock.
    await db.offer.updateMany({
      where: { agentId, holds: { some: { sku: b } } },
      data: { holdUntil: new Date(T0 - 1000) },
    });
    await store.releaseExpired(T0);
    expect(await stock(a)).toBe(1000);
    expect(await stock(b)).toBe(10);
  });

  it("the open-offer cap holds when requests race", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => outcome(create([{ sku: sku("MANY"), qty: 1 }], { maxOpen: 3 }))),
    );
    // One offer already exists from the previous test (LAST), so 2 more fit under 3.
    expect(results.filter((r) => r === "ok")).toHaveLength(2);
    expect(results.filter((r) => r === "RATE_LIMITED")).toHaveLength(2);
    expect(await stock(sku("MANY"))).toBe(998);
  });

  it("a replayed nonce holds nothing", async () => {
    const lines = [{ sku: sku("MANY"), qty: 1 }];
    const nonce = randomNonce();
    const input = {
      agentId,
      nonce,
      nonceExp: Math.floor(T0 / 1000) + 120,
      lines,
      maxOpen: 100,
      maxHeldUnits: 100_000,
      now: T0,
      build: (p: Parameters<typeof priceOffer>[2]) => priceOffer(self, lines, p, Math.floor(T0 / 1000)),
    };
    await store.createOffer(input);
    await expect(store.createOffer(input)).rejects.toMatchObject({ code: "APPROVAL_REPLAY" });
    expect(await stock(sku("MANY"))).toBe(997);
  });

  it("concurrent expiry runs return each hold exactly once", async () => {
    const past = T0 - (OFFER_HOLD_S + 5) * 1000;
    await create([{ sku: sku("EXP"), qty: 3 }], { now: past });
    await create([{ sku: sku("EXP"), qty: 2 }], { now: past });
    expect(await stock(sku("EXP"))).toBe(5);
    const [a, b] = await Promise.all([store.releaseExpired(T0), store.releaseExpired(T0)]);
    expect((a ?? 0) + (b ?? 0)).toBeGreaterThanOrEqual(2);
    expect(await stock(sku("EXP"))).toBe(10);
    const stillOpen = await db.offer.count({ where: { agentId, status: "open", holds: { some: { sku: sku("EXP") } } } });
    expect(stillOpen).toBe(0);
  });
});
