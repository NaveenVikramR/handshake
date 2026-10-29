// Mandate period ledger (SPEC §6 step 6b, D17). Shared by both services: the merchant gate
// reserves at authorize and releases on void; the consumer only reads (policy, wallet UI).
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

export interface SpendKey {
  mandateId: string;
  /** Start of the UTC calendar bucket, unix seconds (core `periodStart`). */
  periodStart: number;
}

export interface MandateLedger<Tx = unknown> {
  /** Minor units spent in the bucket so far (0 if none). */
  spent(key: SpendKey): Promise<number>;
  /**
   * Adds `amountMinor` only if the bucket stays within `limitMinor`. Atomic against concurrent
   * reservations, so split orders can't jointly exceed the limit. false = would exceed.
   * Pass `tx` to run inside the caller's transaction (the gate's nonce + order insert).
   */
  reserve(key: SpendKey & { amountMinor: number; limitMinor: number }, tx?: Tx): Promise<boolean>;
  /**
   * Gives back a previous reservation (void). false, changing nothing, if the bucket holds less
   * than `amountMinor` (a double release or a bug upstream). Not idempotent by itself: M7 calls it
   * only in the same transaction as the order's authorized → voided CAS, so each order releases once.
   */
  release(key: SpendKey & { amountMinor: number }, tx?: Tx): Promise<boolean>;
}

function assertAmount(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

type Db = PrismaClient | Prisma.TransactionClient;

export function prismaMandateLedger(db: PrismaClient): MandateLedger<Prisma.TransactionClient> {
  const where = ({ mandateId, periodStart }: SpendKey) => ({
    mandateId_periodStart: { mandateId, periodStart: new Date(periodStart * 1000) },
  });

  return {
    async spent(key) {
      const row = await db.mandateSpend.findUnique({ where: where(key) });
      return Number(row?.spentMinor ?? 0n);
    },

    async reserve({ mandateId, periodStart, amountMinor, limitMinor }, tx) {
      assertAmount("amountMinor", amountMinor);
      assertAmount("limitMinor", limitMinor);
      if (amountMinor > limitMinor) return false;
      const run = async (c: Db) => {
        const at = new Date(periodStart * 1000);
        await c.mandateSpend.createMany({ data: [{ mandateId, periodStart: at }], skipDuplicates: true });
        // spent + amount ≤ limit ⇔ spent ≤ limit − amount. Postgres re-checks the WHERE after
        // taking the row lock, so a concurrent reservation that committed first is counted.
        const { count } = await c.mandateSpend.updateMany({
          where: { mandateId, periodStart: at, spentMinor: { lte: BigInt(limitMinor - amountMinor) } },
          data: { spentMinor: { increment: BigInt(amountMinor) } },
        });
        return count === 1;
      };
      return tx ? run(tx) : run(db);
    },

    async release({ mandateId, periodStart, amountMinor }, tx) {
      assertAmount("amountMinor", amountMinor);
      const c: Db = tx ?? db;
      const at = new Date(periodStart * 1000);
      const { count } = await c.mandateSpend.updateMany({
        where: { mandateId, periodStart: at, spentMinor: { gte: BigInt(amountMinor) } },
        data: { spentMinor: { decrement: BigInt(amountMinor) } },
      });
      // Never clamp: zeroing the bucket would also erase other orders' reservations.
      return count === 1;
    },
  };
}

/** In-memory ledger for tests only. */
export function memoryMandateLedger(): MandateLedger<undefined> {
  const rows = new Map<string, number>();
  const k = ({ mandateId, periodStart }: SpendKey) => `${mandateId}@${periodStart}`;
  return {
    async spent(key) {
      return rows.get(k(key)) ?? 0;
    },
    async reserve(key) {
      assertAmount("amountMinor", key.amountMinor);
      assertAmount("limitMinor", key.limitMinor);
      const cur = rows.get(k(key)) ?? 0;
      if (cur + key.amountMinor > key.limitMinor) return false;
      rows.set(k(key), cur + key.amountMinor);
      return true;
    },
    async release(key) {
      assertAmount("amountMinor", key.amountMinor);
      const cur = rows.get(k(key)) ?? 0;
      if (cur < key.amountMinor) return false;
      rows.set(k(key), cur - key.amountMinor);
      return true;
    },
  };
}
