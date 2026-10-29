// Registry reads, catalog, and the stock-holding offer write (SPEC §4.1, §9).
// Prisma for real runs; memory for tests. Same contract.
import { HandshakeError, type SignedOffer } from "@handshake/core";
import type { Prisma, PrismaClient } from "@handshake/db";

export interface ProductRow {
  sku: string;
  name: string;
  category: string;
  priceMinor: number;
  stock: number;
}

export interface RegistryAgentRow {
  id: string;
  role: string;
  publicKey: string;
  status: string;
  merchantId: string | null;
}

export interface RegistryMerchantRow {
  id: string;
  name: string;
  paypalMerchantId: string;
  status: string;
}

export interface OfferLine {
  sku: string;
  qty: number;
}

export interface PricedOffer {
  offer: SignedOffer;
  hash: string;
}

export interface CreateOfferInput {
  /** The consumer agent asking; open offers are capped per agent. */
  agentId: string;
  /** The offer request's nonce, recorded once. */
  nonce: string;
  /** unix seconds; when the nonce may be forgotten. */
  nonceExp: number;
  lines: OfferLine[];
  maxOpen: number;
  /** Cap on units this agent may hold across its open offers, including this one. */
  maxHeldUnits: number;
  /** ms since epoch */
  now: number;
  /** Prices and signs the offer from the catalog rows read inside the transaction. */
  build: (products: Map<string, ProductRow>) => PricedOffer;
}

export interface OfferStore {
  getAgent(id: string): Promise<RegistryAgentRow | undefined>;
  getMerchant(id: string): Promise<RegistryMerchantRow | undefined>;
  listProducts(): Promise<ProductRow[]>;
  /**
   * In one transaction: records the nonce (APPROVAL_REPLAY if seen), enforces the per-agent caps on
   * open offers and held units (RATE_LIMITED), takes stock for every line (OUT_OF_STOCK, SCHEMA_INVALID for an unknown sku),
   * then stores the offer and its holds. Any failure leaves nothing behind.
   */
  createOffer(input: CreateOfferInput): Promise<PricedOffer>;
  /**
   * Flips open offers whose hold has passed to `expired` and returns their stock, once per offer
   * (compare-and-set on status, so a concurrent run or the M7 gate can't double-release).
   * Returns how many offers it expired.
   */
  releaseExpired(now: number, limit?: number): Promise<number>;
}

const TX = { maxWait: 10_000, timeout: 15_000 };

const units = (lines: OfferLine[]) => lines.reduce((n, l) => n + l.qty, 0);
const bySku = (lines: OfferLine[]) => [...lines].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

function offerData(input: CreateOfferInput, priced: PricedOffer) {
  const p = priced.offer.payload;
  return {
    id: p.offerId,
    agentId: input.agentId,
    payloadJson: priced.offer as unknown as Prisma.InputJsonValue,
    hash: priced.hash,
    holdUntil: new Date(p.holdUntil * 1000),
  };
}

export function prismaOfferStore(db: PrismaClient): OfferStore {
  return {
    async getAgent(id) {
      return (await db.registryAgent.findUnique({ where: { id } })) ?? undefined;
    },
    async getMerchant(id) {
      return (await db.registryMerchant.findUnique({ where: { id } })) ?? undefined;
    },
    async listProducts() {
      return db.product.findMany({ orderBy: { sku: "asc" } });
    },

    async createOffer(input) {
      const { agentId, nonce, nonceExp, lines, maxOpen, maxHeldUnits, now } = input;
      return db.$transaction(async (tx) => {
        // Serialise this agent's offer creation so the cap can't be raced past.
        await tx.$queryRaw`SELECT 1 FROM registry_agents WHERE id = ${agentId} FOR UPDATE`;
        const { count: fresh } = await tx.usedNonce.createMany({
          data: [{ nonce, exp: new Date(nonceExp * 1000) }],
          skipDuplicates: true,
        });
        if (fresh === 0) throw new HandshakeError("APPROVAL_REPLAY", "offer request already used");
        const open = await tx.offer.count({ where: { agentId, status: "open", holdUntil: { gte: new Date(now) } } });
        if (open >= maxOpen) throw new HandshakeError("RATE_LIMITED", "too many open offers");
        const held = await tx.stockHold.aggregate({
          _sum: { qty: true },
          where: { offer: { agentId, status: "open", holdUntil: { gte: new Date(now) } } },
        });
        if ((held._sum.qty ?? 0) + units(lines) > maxHeldUnits) {
          throw new HandshakeError("RATE_LIMITED", "too many units held");
        }

        const rows = await tx.product.findMany({ where: { sku: { in: lines.map((l) => l.sku) } } });
        if (rows.length !== lines.length) throw new HandshakeError("SCHEMA_INVALID", "unknown sku");
        // Lock product rows in sku order, so overlapping offers can't deadlock.
        for (const { sku, qty } of bySku(lines)) {
          // Conditional decrement: Postgres re-checks stock ≥ qty after the row lock, so two
          // offers can't both take the last unit.
          const { count } = await tx.product.updateMany({
            where: { sku, stock: { gte: qty } },
            data: { stock: { decrement: qty } },
          });
          if (count === 0) throw new HandshakeError("OUT_OF_STOCK", `insufficient stock for ${sku}`);
        }
        const priced = input.build(new Map(rows.map((r) => [r.sku, r])));
        await tx.offer.create({ data: { ...offerData(input, priced), holds: { create: lines } } });
        return priced;
      }, TX);
    },

    async releaseExpired(now, limit = 100) {
      const due = await db.offer.findMany({
        where: { status: "open", holdUntil: { lt: new Date(now) } },
        select: { id: true },
        orderBy: { holdUntil: "asc" },
        take: limit,
      });
      let released = 0;
      for (const { id } of due) {
        const done = await db.$transaction(async (tx) => {
          const { count } = await tx.offer.updateMany({ where: { id, status: "open" }, data: { status: "expired" } });
          if (count === 0) return false;
          const holds = await tx.stockHold.findMany({ where: { offerId: id }, orderBy: { sku: "asc" } });
          for (const h of holds) {
            await tx.product.update({ where: { sku: h.sku }, data: { stock: { increment: h.qty } } });
          }
          return true;
        }, TX);
        if (done) released++;
      }
      return released;
    },
  };
}

interface MemoryOffer {
  agentId: string;
  status: "open" | "used" | "expired";
  holdUntil: number;
  lines: OfferLine[];
  offer: SignedOffer;
}

/** In-memory store for tests only. Each method runs without awaiting mid-way, so it is atomic in JS. */
export function memoryOfferStore(seed: {
  agents?: RegistryAgentRow[];
  merchants?: RegistryMerchantRow[];
  products?: ProductRow[];
}): OfferStore & { offers: Map<string, MemoryOffer>; products: Map<string, ProductRow> } {
  const agents = new Map((seed.agents ?? []).map((a) => [a.id, { ...a }]));
  const merchants = new Map((seed.merchants ?? []).map((m) => [m.id, { ...m }]));
  const products = new Map((seed.products ?? []).map((p) => [p.sku, { ...p }]));
  const nonces = new Set<string>();
  const offers = new Map<string, MemoryOffer>();

  return {
    offers,
    products,
    async getAgent(id) {
      const a = agents.get(id);
      return a && { ...a };
    },
    async getMerchant(id) {
      const m = merchants.get(id);
      return m && { ...m };
    },
    async listProducts() {
      return [...products.values()].sort((a, b) => a.sku.localeCompare(b.sku)).map((p) => ({ ...p }));
    },
    async createOffer(input) {
      const { agentId, nonce, lines, maxOpen, maxHeldUnits, now } = input;
      if (nonces.has(nonce)) throw new HandshakeError("APPROVAL_REPLAY", "offer request already used");
      const open = [...offers.values()].filter(
        (o) => o.agentId === agentId && o.status === "open" && o.holdUntil >= now,
      );
      if (open.length >= maxOpen) throw new HandshakeError("RATE_LIMITED", "too many open offers");
      if (open.reduce((n, o) => n + units(o.lines), 0) + units(lines) > maxHeldUnits) {
        throw new HandshakeError("RATE_LIMITED", "too many units held");
      }
      const rows = new Map<string, ProductRow>();
      for (const { sku, qty } of lines) {
        const p = products.get(sku);
        if (!p) throw new HandshakeError("SCHEMA_INVALID", "unknown sku");
        if (p.stock < qty) throw new HandshakeError("OUT_OF_STOCK", `insufficient stock for ${sku}`);
        rows.set(sku, { ...p });
      }
      const priced = input.build(rows);
      nonces.add(nonce);
      for (const { sku, qty } of lines) products.get(sku)!.stock -= qty;
      const p = priced.offer.payload;
      offers.set(p.offerId, { agentId, status: "open", holdUntil: p.holdUntil * 1000, lines, offer: priced.offer });
      return priced;
    },
    async releaseExpired(now, limit = 100) {
      let released = 0;
      for (const o of offers.values()) {
        if (released >= limit) break;
        if (o.status !== "open" || o.holdUntil >= now) continue;
        o.status = "expired";
        for (const { sku, qty } of o.lines) products.get(sku)!.stock += qty;
        released++;
      }
      return released;
    },
  };
}
