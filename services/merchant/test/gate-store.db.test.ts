// M7 on real Postgres: the gate's commit is all-or-nothing and race-safe. Parallel split orders on
// one mandate can't pass the period limit together, a replayed nonce lands once, and releasing an
// order gives back spend and stock exactly once. Runs only with DB_TESTS=1 (`pnpm test:db`).
import { generateEd25519KeyPair, randomNonce } from "@handshake/core";
import { createDb } from "@handshake/db";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaGateStore, type CommitInput } from "../src/gate/store.js";

const enabled = process.env.DB_TESTS === "1";
const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (enabled && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

describe.skipIf(!enabled)("gate store on Postgres (DB_TESTS=1)", () => {
  const db = enabled ? createDb() : (undefined as never);
  const store = enabled ? prismaGateStore(db) : (undefined as never);
  const tag = randomBytes(4).toString("hex");
  const TAG = tag.toUpperCase();
  const userId = `usr_gate${tag}`;
  const agentId = `agt_c_gate${tag}`;
  const mandateId = `man_gate${tag}`;
  const sku = `T${TAG}-G`;
  const LIMIT = 8000;
  const BUCKET = 1_762_128_000;
  let n = 0;

  async function newOffer(qty = 1): Promise<string> {
    const id = `off_gate${tag}${n++}`;
    await db.offer.create({
      data: {
        id,
        agentId,
        payloadJson: {},
        hash: `h${id}`,
        status: "open",
        holdUntil: new Date(Date.now() + 600_000),
        holds: { create: [{ sku, qty }] },
      },
    });
    await db.product.update({ where: { sku }, data: { stock: { decrement: qty } } });
    return id;
  }

  const commit = (offerId: string, patch: Partial<CommitInput> = {}): Promise<void> => {
    const requestId = `req_gate${tag}${offerId.slice(-3)}${randomBytes(3).toString("hex")}`;
    return store.commit({
      requestId,
      agentId,
      userId,
      offerId,
      offerHash: `h${offerId}`,
      now: Date.now(),
      nonce: { value: randomNonce(), exp: Math.floor(Date.now() / 1000) + 300 },
      ledger: { mandateId, periodStart: BUCKET, amountMinor: 3000, limitMinor: LIMIT },
      order: {
        id: `ord_${requestId.slice(4)}`,
        requestId,
        userId,
        offerId,
        path: "mandate",
        totalMinor: 3000,
        currency: "USD",
        offerHash: `h${offerId}`,
        approvalHash: "a",
        mandateId,
        periodStart: BUCKET,
        fulfilBy: Date.now() + 86_400_000,
      },
      ...patch,
    });
  };
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: { code?: string }) => e.code ?? `error ${String(e)}`,
    );
  const spent = async () =>
    Number(
      (
        await db.mandateSpend.findUnique({
          where: { mandateId_periodStart: { mandateId, periodStart: new Date(BUCKET * 1000) } },
        })
      )?.spentMinor ?? 0n,
    );
  const stock = async () => (await db.product.findUniqueOrThrow({ where: { sku } })).stock;

  beforeAll(async () => {
    await db.user.create({ data: { id: userId, displayName: "gate test" } });
    await db.mandate.create({
      data: { id: mandateId, userId, payloadJson: {}, hash: `hm${tag}`, status: "active", pendingUntil: new Date() },
    });
    await db.registryAgent.create({
      data: { id: agentId, role: "consumer", publicKey: generateEd25519KeyPair().publicKey },
    });
    await db.product.create({ data: { sku, name: "Gate test", category: "grocery", priceMinor: 3000, stock: 100 } });
  });

  afterAll(async () => {
    const reqs = (await db.paymentRequestRow.findMany({ where: { agentId }, select: { requestId: true } })).map(
      (r) => r.requestId,
    );
    await db.decision.deleteMany({ where: { requestId: { in: reqs } } });
    await db.order.deleteMany({ where: { requestId: { in: reqs } } });
    await db.paymentRequestRow.deleteMany({ where: { agentId } });
    await db.usedNonce.deleteMany({ where: { kid: agentId } });
    const offers = (await db.offer.findMany({ where: { agentId }, select: { id: true } })).map((o) => o.id);
    await db.stockHold.deleteMany({ where: { offerId: { in: offers } } });
    await db.offer.deleteMany({ where: { agentId } });
    await db.mandateSpend.deleteMany({ where: { mandateId } });
    await db.mandate.deleteMany({ where: { id: mandateId } });
    await db.product.deleteMany({ where: { sku } });
    await db.registryAgent.deleteMany({ where: { id: agentId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it("parallel split orders on one mandate: exactly 2 × 3000 fit 8000; the losers roll back fully", async () => {
    const offers = await Promise.all([1, 2, 3, 4].map(() => newOffer()));
    const results = await Promise.all(offers.map((o) => outcome(commit(o))));
    expect(results.filter((r) => r === "ok")).toHaveLength(2);
    expect(results.filter((r) => r === "MANDATE_LIMIT")).toHaveLength(2);
    expect(await spent()).toBe(6000);
    // Rolled back: the losers' offers are still open, and no request row or order exists for them.
    const statuses = await db.offer.findMany({ where: { id: { in: offers } }, select: { status: true } });
    expect(statuses.map((s) => s.status).sort()).toEqual(["open", "open", "used", "used"]);
    expect(await db.order.count({ where: { offerId: { in: offers } } })).toBe(2);
  });

  it("the same cart nonce on two offers at once lands once → APPROVAL_REPLAY", async () => {
    await db.mandateSpend.deleteMany({ where: { mandateId } });
    const [a, b] = [await newOffer(), await newOffer()];
    const nonce = { value: randomNonce(), exp: Math.floor(Date.now() / 1000) + 300 };
    const results = await Promise.all([outcome(commit(a, { nonce })), outcome(commit(b, { nonce }))]);
    expect(results.sort()).toEqual(["APPROVAL_REPLAY", "ok"]);
  });

  it("one offer, two requests → one wins (DUPLICATE_REQUEST or OFFER_USED for the other)", async () => {
    await db.mandateSpend.deleteMany({ where: { mandateId } });
    const o = await newOffer();
    const results = await Promise.all([outcome(commit(o)), outcome(commit(o))]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(["DUPLICATE_REQUEST", "OFFER_USED"]).toContain(results.find((r) => r !== "ok"));
  });

  it("releasing an order twice at once gives spend and stock back exactly once", async () => {
    await db.mandateSpend.deleteMany({ where: { mandateId } });
    const o = await newOffer(2);
    await commit(o);
    const order = (await db.order.findFirstOrThrow({ where: { offerId: o } })).id;
    const [spentBefore, stockBefore] = [await spent(), await stock()];
    const done = await Promise.all([
      store.updateOrder({ orderId: order, from: "offered", to: "failed", release: true }),
      store.updateOrder({ orderId: order, from: "offered", to: "failed", release: true }),
    ]);
    expect(done.filter(Boolean)).toHaveLength(1);
    expect(await spent()).toBe(spentBefore - 3000);
    expect(await stock()).toBe(stockBefore + 2);
    expect((await db.offer.findUniqueOrThrow({ where: { id: o } })).status).toBe("expired");
  });

  it("an unknown mandate → MANDATE_INVALID, nothing written", async () => {
    const o = await newOffer();
    const res = await outcome(
      commit(o, { ledger: { mandateId: `man_nope${tag}`, periodStart: BUCKET, amountMinor: 1, limitMinor: 10 } }),
    );
    expect(res).toBe("MANDATE_INVALID");
    expect((await db.offer.findUniqueOrThrow({ where: { id: o } })).status).toBe("open");
  });

  it("purgeNonces drops only rows past the cutoff", async () => {
    const now = Math.floor(Date.now() / 1000);
    await db.usedNonce.createMany({
      data: [
        { kid: agentId, type: "cart_approval", nonce: `old${tag}`, exp: new Date((now - 3600) * 1000) },
        { kid: agentId, type: "cart_approval", nonce: `new${tag}`, exp: new Date((now + 3600) * 1000) },
      ],
    });
    await store.purgeNonces(now - 1800);
    const left = await db.usedNonce.findMany({ where: { kid: agentId, nonce: { in: [`old${tag}`, `new${tag}`] } } });
    expect(left.map((r) => r.nonce)).toEqual([`new${tag}`]);
  });

  it("saved wallets: unbound until bound, then pending; a confirmed one is never replaced by another payer", async () => {
    const u = `usr_vault${tag}`;
    try {
      expect(await store.saveVault({ userId: u, orderId: "ord_v1", vaultId: "V1", payerId: "P1", payerEmail: "p1@x" })).toBe("unbound");
      expect(await store.getVault(u)).toBeUndefined();
      // Only the order that saved it can bind it (D31).
      expect(await store.bindVault(u, "ord_other")).toBe(false);
      expect(await store.bindVault(u, "ord_v1")).toBe(true);
      await db.paypalVault.update({ where: { userId: u }, data: { status: "confirmed" } });
      expect(await store.getVault(u)).toBe("V1");
      const both = await Promise.all([
        store.saveVault({ userId: u, vaultId: "V2", payerId: "P2" }),
        store.saveVault({ userId: u, vaultId: "V3", payerId: "P1" }),
      ]);
      expect(both.sort()).toEqual(["kept", "refused"]);
      expect(await db.paypalVault.findUniqueOrThrow({ where: { userId: u } })).toMatchObject({ status: "confirmed", payerId: "P1", vaultId: "V3" });
    } finally {
      await db.paypalVault.deleteMany({ where: { userId: u } });
    }
  });

  it("owner returned (D29): the wallet ends pending whichever of save and bind runs first, also concurrently", async () => {
    const mkOrder = async (i: number) => {
      const requestId = `req_own${tag}${i}`;
      const id = `ord_own${tag}${i}`;
      await db.paymentRequestRow.create({ data: { requestId, agentId, userId, offerId: `off_own${tag}${i}` } });
      await db.order.create({
        data: {
          id,
          requestId,
          userId,
          offerId: `off_own${tag}${i}`,
          status: "authorized",
          path: "passkey",
          totalMinor: 499,
          currency: "USD",
          offerHash: "h",
          approvalHash: "a",
          fulfilBy: new Date(Date.now() + 3_600_000),
        },
      });
      return id;
    };
    const status = async (u: string) => (await db.paypalVault.findUnique({ where: { userId: u } }))?.status;
    const users: string[] = [];
    try {
      // Bind before save: the browser's mark + bind find no vault yet; the agent's save stores it bound.
      const u1 = `usr_own1${tag}`;
      users.push(u1);
      const o1 = await mkOrder(1);
      await store.markOwnerReturned(o1);
      expect(await store.bindVault(u1, o1)).toBe(false);
      await store.saveVault({ userId: u1, orderId: o1, vaultId: "V1", payerId: "P1" });
      expect(await status(u1)).toBe("pending");

      // Save before bind: stored unbound, then the owner's return binds it.
      const u2 = `usr_own2${tag}`;
      users.push(u2);
      const o2 = await mkOrder(2);
      await store.saveVault({ userId: u2, orderId: o2, vaultId: "V2", payerId: "P2" });
      expect(await status(u2)).toBe("unbound");
      await store.markOwnerReturned(o2);
      expect(await store.bindVault(u2, o2)).toBe(true);
      expect(await status(u2)).toBe("pending");

      // Another order's owner returning binds nothing here.
      const u3 = `usr_own3${tag}`;
      users.push(u3);
      const o3 = await mkOrder(3);
      await store.saveVault({ userId: u3, orderId: o3, vaultId: "V3", payerId: "P3" });
      expect(await status(u3)).toBe("unbound");

      // Concurrent: the agent's save and the browser's mark-then-bind race; always pending.
      for (let i = 0; i < 6; i++) {
        const u = `usr_ownc${i}${tag}`;
        users.push(u);
        const o = await mkOrder(10 + i);
        await Promise.all([
          store.saveVault({ userId: u, orderId: o, vaultId: `VC${i}`, payerId: "PC" }),
          (async () => {
            await store.markOwnerReturned(o);
            await store.bindVault(u, o);
          })(),
        ]);
        expect(await status(u)).toBe("pending");
      }
    } finally {
      await db.paypalVault.deleteMany({ where: { userId: { in: users } } });
    }
  });
});

