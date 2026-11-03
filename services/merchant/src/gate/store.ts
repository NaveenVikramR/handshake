// Persistence for the gate and settlement (SPEC §6, §7.1, §9). Prisma for real runs; memory for
// tests. Same contract. Every state change is a compare-and-set, so concurrent requests, the expiry
// job and webhooks can race without double-spending, double-releasing or skipping a state.
import { HandshakeError, type Decision, type OrderStatus, type Receipt } from "@handshake/core";
import { memoryMandateLedger, prismaMandateLedger, type Prisma, type PrismaClient } from "@handshake/db";

export interface PasskeyRow {
  credentialId: string;
  userId: string;
  publicKey: string;
  /** The merchant's own last-seen count (D16). */
  signCount: number;
}

export interface OfferRow {
  id: string;
  agentId: string;
  hash: string;
  status: string;
  /** ms since epoch */
  holdUntil: number;
}

export type GatePath = "passkey" | "mandate";

export interface OrderRow {
  id: string;
  requestId: string;
  userId: string;
  offerId: string;
  status: OrderStatus;
  path: GatePath;
  totalMinor: number;
  currency: string;
  offerHash: string;
  approvalHash: string;
  mandateId: string | null;
  /** unix seconds, the ledger bucket reserved at the gate */
  periodStart: number | null;
  paypalOrderId: string | null;
  authorizationId: string | null;
  captureId: string | null;
  refundId: string | null;
  refundedMinor: number;
  payerActionUrl: string | null;
  trackingNumber: string | null;
  /** ms since epoch */
  fulfilBy: number;
  /** ms since epoch */
  createdAt: number;
}

export interface RecentRequest {
  requestId: string;
  /** ms since epoch of the latest decision */
  at: number;
  decisions: Decision[];
  order: OrderRow | null;
}

export interface VaultInput {
  userId: string;
  vaultId: string;
  customerId?: string | undefined;
  payerId?: string | undefined;
  payerEmail?: string | undefined;
}

export interface CommitInput {
  requestId: string;
  agentId: string;
  userId: string;
  offerId: string;
  offerHash: string;
  /** ms since epoch; the offer must still be held */
  now: number;
  /** The cart's nonce, recorded for (agentId, "cart_approval"). */
  nonce: { value: string; exp: number };
  /** 6a: advance the merchant's sign count expected → next. */
  passkey?: { credentialId: string; expected: number; next: number };
  /** 6b: reserve the cart total in the mandate's bucket. */
  ledger?: { mandateId: string; periodStart: number; amountMinor: number; limitMinor: number };
  order: Omit<
    OrderRow,
    | "status"
    | "paypalOrderId"
    | "authorizationId"
    | "captureId"
    | "refundId"
    | "refundedMinor"
    | "payerActionUrl"
    | "trackingNumber"
    | "createdAt"
  >;
}

export interface OrderUpdate {
  orderId: string;
  /** Applies only if the order is still in this state. */
  from: OrderStatus;
  to: OrderStatus;
  set?: Partial<
    Pick<
      OrderRow,
      | "paypalOrderId"
      | "authorizationId"
      | "captureId"
      | "refundId"
      | "refundedMinor"
      | "payerActionUrl"
      | "trackingNumber"
    >
  >;
  /** Money never moved or was released: give back the ledger reservation and the stock, once. */
  release?: boolean;
}

/** Pending fields only (no status change), e.g. the PayPal order id while the buyer approves. */
export interface OrderPatch {
  orderId: string;
  status: OrderStatus;
  set: OrderUpdate["set"];
}

export interface GateStore<Tx = unknown> {
  getPasskey(credentialId: string): Promise<PasskeyRow | undefined>;
  /** Wallet-side mandate row (shared DB, D22): status and hash. */
  getMandateRow(id: string): Promise<{ status: string; hash: string } | undefined>;
  getOffer(id: string): Promise<OfferRow | undefined>;
  categories(skus: string[]): Promise<Map<string, string>>;
  nonceSeen(kid: string, type: string, nonce: string): Promise<boolean>;
  getPaymentRequest(requestId: string): Promise<{ receipt: Receipt | null; order: OrderRow | null } | undefined>;
  ordersSince(userId: string, sinceMs: number): Promise<number>;
  /**
   * Steps 2/4/6/7 authoritative, in one transaction (D17): the request row (DUPLICATE_REQUEST),
   * offer open → used while held (OFFER_USED / OFFER_EXPIRED), the nonce (APPROVAL_REPLAY), the
   * passkey sign count (APPROVAL_INVALID if it moved), the ledger (MANDATE_LIMIT, MANDATE_INVALID)
   * and the order row (status `offered`). Any failure rolls all of it back.
   */
  commit(input: CommitInput): Promise<void>;
  addDecisions(requestId: string, decisions: Decision[]): Promise<void>;
  listDecisions(requestId: string): Promise<Decision[]>;
  getOrder(id: string): Promise<OrderRow | undefined>;
  findOrder(ref: {
    authorizationId?: string;
    captureId?: string;
    refundId?: string;
    paypalOrderId?: string;
  }): Promise<OrderRow | undefined>;
  /** Compare-and-set on status; false if another writer got there first. */
  updateOrder(u: OrderUpdate, tx?: Tx): Promise<boolean>;
  patchOrder(p: OrderPatch): Promise<boolean>;
  saveReceipt(requestId: string, receipt: Receipt): Promise<void>;
  /** The user's saved wallet, only once they confirmed its payer (M8); pending vaults never pay. */
  getVault(userId: string): Promise<string | undefined>;
  /**
   * Stores a newly saved wallet as pending confirmation. "refused" if the user already confirmed a
   * different PayPal payer: a phished approve link can't replace their wallet (D22).
   */
  saveVault(v: VaultInput): Promise<"unbound" | "kept" | "refused">;
  /**
   * The order's own wallet user came back from PayPal in their signed-in browser: their unbound
   * vault becomes pending (confirmable). Without this, a phished approve link can't attach a
   * victim's PayPal to the attacker's wallet, because the attacker never holds the victim's return.
   */
  bindVault(userId: string, payerId: string | undefined): Promise<boolean>;
  /** Authorized past fulfilBy, or offered (awaiting the buyer) created before `staleOfferedBefore`. */
  dueOrders(now: number, staleOfferedBefore: number, limit?: number): Promise<OrderRow[]>;
  /** Adds a refund to a captured order atomically; the new refunded total, or undefined if not captured. */
  addRefund(r: { orderId: string; refundId: string; amountMinor: number }, tx?: Tx): Promise<number | undefined>;
  /** Newest gate runs for the dashboard: each request's decisions and its order, if one was created. */
  listRecent(limit?: number): Promise<RecentRequest[]>;
  /** Deletes nonce rows whose payload expired before `before` (unix seconds); returns how many. */
  purgeNonces(before: number): Promise<number>;
  addReconciliation(r: {
    eventId: string;
    eventType: string;
    orderId?: string;
    from?: string;
    to?: string;
    note: string;
  }, tx?: Tx): Promise<void>;
}

const TX = { maxWait: 10_000, timeout: 15_000 };
class Abort extends HandshakeError {}

type DbOrder = {
  id: string;
  requestId: string;
  userId: string;
  offerId: string;
  status: string;
  path: string;
  totalMinor: number;
  currency: string;
  offerHash: string;
  approvalHash: string;
  mandateId: string | null;
  periodStart: Date | null;
  paypalOrderId: string | null;
  authorizationId: string | null;
  captureId: string | null;
  refundId: string | null;
  refundedMinor: number;
  payerActionUrl: string | null;
  trackingNumber: string | null;
  fulfilBy: Date;
  createdAt: Date;
};

const toOrder = (o: DbOrder): OrderRow => ({
  ...o,
  status: o.status as OrderStatus,
  path: o.path as GatePath,
  periodStart: o.periodStart ? o.periodStart.getTime() / 1000 : null,
  fulfilBy: o.fulfilBy.getTime(),
  createdAt: o.createdAt.getTime(),
});

export function prismaGateStore(db: PrismaClient): GateStore<Prisma.TransactionClient> {
  const ledger = prismaMandateLedger(db);

  /** Ledger + stock back, inside the caller's order CAS transaction (once per order). */
  async function releaseIn(tx: Prisma.TransactionClient, o: DbOrder): Promise<void> {
    if (o.mandateId && o.periodStart) {
      const ok = await ledger.release(
        { mandateId: o.mandateId, periodStart: o.periodStart.getTime() / 1000, amountMinor: o.totalMinor },
        tx,
      );
      if (!ok) throw new Error(`ledger release refused for order ${o.id}`);
    }
    const { count } = await tx.offer.updateMany({
      where: { id: o.offerId, status: "used" },
      data: { status: "expired" },
    });
    if (count === 1) {
      const holds = await tx.stockHold.findMany({ where: { offerId: o.offerId }, orderBy: { sku: "asc" } });
      for (const h of holds) await tx.product.update({ where: { sku: h.sku }, data: { stock: { increment: h.qty } } });
    }
  }

  return {
    async getPasskey(credentialId) {
      const r = await db.registryPasskey.findUnique({ where: { credentialId } });
      return r
        ? { credentialId: r.credentialId, userId: r.userId, publicKey: r.publicKey, signCount: Number(r.signCount) }
        : undefined;
    },
    async getMandateRow(id) {
      return (await db.mandate.findUnique({ where: { id }, select: { status: true, hash: true } })) ?? undefined;
    },
    async getOffer(id) {
      const o = await db.offer.findUnique({ where: { id } });
      return o
        ? { id: o.id, agentId: o.agentId, hash: o.hash, status: o.status, holdUntil: o.holdUntil.getTime() }
        : undefined;
    },
    async categories(skus) {
      const rows = await db.product.findMany({ where: { sku: { in: skus } }, select: { sku: true, category: true } });
      return new Map(rows.map((r) => [r.sku, r.category]));
    },
    async nonceSeen(kid, type, nonce) {
      return (await db.usedNonce.count({ where: { kid, type, nonce } })) > 0;
    },
    async getPaymentRequest(requestId) {
      const r = await db.paymentRequestRow.findUnique({ where: { requestId }, include: { order: true } });
      if (!r) return undefined;
      return { receipt: (r.receiptJson as Receipt | null) ?? null, order: r.order ? toOrder(r.order) : null };
    },
    async ordersSince(userId, sinceMs) {
      return db.order.count({ where: { userId, createdAt: { gte: new Date(sinceMs) } } });
    },

    async commit(input) {
      try {
        await db.$transaction(async (tx) => {
          const req = await tx.paymentRequestRow.createMany({
            data: [
              { requestId: input.requestId, agentId: input.agentId, userId: input.userId, offerId: input.offerId },
            ],
            skipDuplicates: true,
          });
          if (req.count === 0) throw new Abort("DUPLICATE_REQUEST", "request id or offer already paid for");
          const offer = await tx.offer.updateMany({
            where: { id: input.offerId, hash: input.offerHash, status: "open", holdUntil: { gt: new Date(input.now) } },
            data: { status: "used" },
          });
          if (offer.count === 0) {
            const o = await tx.offer.findUnique({ where: { id: input.offerId }, select: { status: true } });
            throw new Abort(o?.status === "used" ? "OFFER_USED" : "OFFER_EXPIRED", "offer no longer open");
          }
          const nonce = await tx.usedNonce.createMany({
            data: [
              {
                kid: input.agentId,
                type: "cart_approval",
                nonce: input.nonce.value,
                exp: new Date(input.nonce.exp * 1000),
              },
            ],
            skipDuplicates: true,
          });
          if (nonce.count === 0) throw new Abort("APPROVAL_REPLAY", "cart nonce already used");
          if (input.passkey) {
            const c = await tx.registryPasskey.updateMany({
              where: { credentialId: input.passkey.credentialId, signCount: BigInt(input.passkey.expected) },
              data: { signCount: BigInt(input.passkey.next) },
            });
            if (c.count !== 1) throw new Abort("APPROVAL_INVALID", "passkey sign count moved concurrently");
          }
          if (input.ledger) {
            let ok: boolean;
            try {
              ok = await ledger.reserve(input.ledger, tx);
            } catch (e) {
              // FK violation: the mandate row doesn't exist.
              if ((e as { code?: string }).code === "P2003") throw new Abort("MANDATE_INVALID", "unknown mandate");
              throw e;
            }
            if (!ok) throw new Abort("MANDATE_LIMIT", "over the mandate's period limit");
          }
          const o = input.order;
          await tx.order.create({
            data: {
              ...o,
              status: "offered",
              periodStart: o.periodStart === null ? null : new Date(o.periodStart * 1000),
              fulfilBy: new Date(o.fulfilBy),
            },
          });
        }, TX);
      } catch (e) {
        if (e instanceof Abort) throw new HandshakeError(e.code, e.message);
        throw e;
      }
    },

    async addDecisions(requestId, decisions) {
      if (decisions.length) await db.decision.createMany({ data: decisions.map((d) => ({ requestId, ...d })) });
    },
    async listDecisions(requestId) {
      const rows = await db.decision.findMany({ where: { requestId }, orderBy: { id: "asc" } });
      return rows.map((r) => ({ step: r.step, result: r.result as Decision["result"], reason: r.reason }));
    },
    async getOrder(id) {
      const o = await db.order.findUnique({ where: { id } });
      return o ? toOrder(o) : undefined;
    },
    async findOrder(ref) {
      const where = ref.authorizationId
        ? { authorizationId: ref.authorizationId }
        : ref.captureId
          ? { captureId: ref.captureId }
          : ref.paypalOrderId
            ? { paypalOrderId: ref.paypalOrderId }
            : ref.refundId
              ? { refundId: ref.refundId }
              : undefined;
      if (!where) return undefined;
      const o = await db.order.findFirst({ where });
      return o ? toOrder(o) : undefined;
    },
    async updateOrder(u, outer) {
      const run = async (tx: Prisma.TransactionClient) => {
        const { count } = await tx.order.updateMany({
          where: { id: u.orderId, status: u.from },
          data: { status: u.to, ...(u.set ?? {}) },
        });
        if (count !== 1) return false;
        if (u.release) {
          const o = await tx.order.findUniqueOrThrow({ where: { id: u.orderId } });
          await releaseIn(tx, o);
        }
        return true;
      };
      return outer ? run(outer) : db.$transaction(run, TX);
    },
    async patchOrder(p) {
      const { count } = await db.order.updateMany({ where: { id: p.orderId, status: p.status }, data: p.set ?? {} });
      return count === 1;
    },
    async saveReceipt(requestId, receipt) {
      await db.paymentRequestRow.update({
        where: { requestId },
        data: { receiptJson: receipt as unknown as Prisma.InputJsonValue },
      });
    },
    async getVault(userId) {
      const v = await db.paypalVault.findUnique({ where: { userId } });
      return v?.status === "confirmed" ? v.vaultId : undefined;
    },
    async saveVault({ userId, vaultId, customerId, payerId, payerEmail }) {
      const data = { vaultId, customerId: customerId ?? null, payerId: payerId ?? null, payerEmail: payerEmail ?? null };
      return db.$transaction(async (tx) => {
        // Lock the row: a confirm committing between read and write must not be overwritten.
        await tx.$queryRaw`SELECT 1 FROM paypal_vaults WHERE user_id = ${userId} FOR UPDATE`;
        const cur = await tx.paypalVault.findUnique({ where: { userId } });
        if (cur?.status === "confirmed") {
          if (!payerId || cur.payerId !== payerId) return "refused" as const;
          await tx.paypalVault.update({ where: { userId }, data: { vaultId, customerId: data.customerId } });
          return "kept" as const;
        }
        // A pending vault for the same payer stays pending (already bound by its owner's return).
        const status = cur?.status === "pending" && cur.payerId === payerId && payerId ? "pending" : "unbound";
        await tx.paypalVault.upsert({
          where: { userId },
          create: { userId, ...data, status },
          update: { ...data, status, confirmedAt: null },
        });
        return "unbound" as const;
      }, TX);
    },
    async bindVault(userId, payerId) {
      const { count } = await db.paypalVault.updateMany({
        where: { userId, status: "unbound", ...(payerId ? { payerId } : {}) },
        data: { status: "pending" },
      });
      return count === 1;
    },
    async dueOrders(now, staleOfferedBefore, limit = 50) {
      const rows = await db.order.findMany({
        where: {
          OR: [
            { status: "authorized", fulfilBy: { lt: new Date(now) } },
            { status: "offered", createdAt: { lt: new Date(staleOfferedBefore) } },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
      return rows.map(toOrder);
    },
    async purgeNonces(before) {
      return (await db.usedNonce.deleteMany({ where: { exp: { lt: new Date(before * 1000) } } })).count;
    },
    async listRecent(limit = 50) {
      const rows = await db.decision.findMany({ orderBy: { id: "desc" }, take: limit * 12 });
      const byReq = new Map<string, { at: number; decisions: Decision[] }>();
      for (const r of rows.reverse()) {
        const e = byReq.get(r.requestId) ?? { at: 0, decisions: [] };
        e.decisions.push({ step: r.step, result: r.result as Decision["result"], reason: r.reason });
        e.at = Math.max(e.at, r.at.getTime());
        byReq.set(r.requestId, e);
      }
      const ids = [...byReq.keys()];
      const orders = await db.order.findMany({ where: { requestId: { in: ids } } });
      const orderOf = new Map(orders.map((o) => [o.requestId, toOrder(o)]));
      return [...byReq.entries()]
        .map(([requestId, e]) => ({ requestId, ...e, order: orderOf.get(requestId) ?? null }))
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
    },
    async addRefund({ orderId, refundId, amountMinor }, tx) {
      const c = tx ?? db;
      const { count } = await c.order.updateMany({
        where: { id: orderId, status: "captured" },
        data: { refundedMinor: { increment: amountMinor }, refundId },
      });
      if (count !== 1) return undefined;
      return (await c.order.findUniqueOrThrow({ where: { id: orderId }, select: { refundedMinor: true } })).refundedMinor;
    },
    async addReconciliation(r, tx) {
      await (tx ?? db).reconciliation.create({
        data: {
          eventId: r.eventId,
          eventType: r.eventType,
          orderId: r.orderId ?? null,
          fromState: r.from ?? null,
          toState: r.to ?? null,
          note: r.note,
        },
      });
    },
  };
}

/** In-memory store for tests only. Each method is synchronous between awaits, so atomic in JS. */
export function memoryGateStore(seed: {
  passkeys?: PasskeyRow[];
  mandates?: { id: string; status: string; hash: string }[];
  offers?: OfferRow[];
  categories?: Record<string, string>;
  /** Restock hook: the offer store's stock, so release is observable. */
  restock?: (offerId: string) => void;
  /** Saved wallets, shareable with the wallet's memory store (one table in Postgres). */
  vaults?: Map<string, { vaultId: string; payerId?: string; payerEmail?: string; status: "unbound" | "pending" | "confirmed" }>;
  /**
   * Shared-DB stand-ins for tests that run the whole flow in memory: in Postgres these are the
   * same tables the offer store and wallet write. The gate keeps its own passkey sign counts (D16).
   */
  links?: {
    offer?: (id: string) => OfferRow | undefined;
    setOfferStatus?: (id: string, status: string) => void;
    passkey?: (id: string) => Promise<Omit<PasskeyRow, "signCount"> | undefined>;
    mandate?: (id: string) => Promise<{ status: string; hash: string } | undefined>;
    categories?: (skus: string[]) => Map<string, string>;
  };
}) {
  const links = seed.links ?? {};
  const passkeys = new Map((seed.passkeys ?? []).map((p) => [p.credentialId, { ...p }]));
  const mandates = new Map((seed.mandates ?? []).map((m) => [m.id, { ...m }]));
  const offers = new Map((seed.offers ?? []).map((o) => [o.id, { ...o }]));
  const cats = new Map(Object.entries(seed.categories ?? {}));
  const nonces = new Set<string>();
  const requests = new Map<string, { offerId: string; receipt: Receipt | null }>();
  const orders = new Map<string, OrderRow>();
  const vaults =
    seed.vaults ??
    new Map<string, { vaultId: string; payerId?: string; payerEmail?: string; status: "unbound" | "pending" | "confirmed" }>();
  const decisions: (Decision & { requestId: string })[] = [];
  const reconciliations: Parameters<GateStore["addReconciliation"]>[0][] = [];
  const ledger = memoryMandateLedger();

  const release = async (o: OrderRow) => {
    if (o.mandateId && o.periodStart !== null) {
      const ok = await ledger.release({
        mandateId: o.mandateId,
        periodStart: o.periodStart,
        amountMinor: o.totalMinor,
      });
      if (!ok) throw new Error(`ledger release refused for order ${o.id}`);
    }
    const offer = offerRow(o.offerId);
    if (offer?.status === "used") {
      setOfferStatus(o.offerId, "expired");
      seed.restock?.(o.offerId);
    }
  };
  const offerRow = (id: string) => links.offer?.(id) ?? offers.get(id);
  const setOfferStatus = (id: string, status: string) => {
    const o = offers.get(id);
    if (o) o.status = status;
    links.setOfferStatus?.(id, status);
  };

  const store: GateStore<undefined> = {
    async getPasskey(id) {
      const p = passkeys.get(id);
      if (p) return { ...p };
      const linked = await links.passkey?.(id);
      if (!linked) return undefined;
      passkeys.set(id, { ...linked, signCount: 0 });
      return { ...linked, signCount: 0 };
    },
    async getMandateRow(id) {
      const m = mandates.get(id) ?? (await links.mandate?.(id));
      return m && { status: m.status, hash: m.hash };
    },
    async getOffer(id) {
      const o = offerRow(id);
      return o && { ...o };
    },
    async categories(skus) {
      if (links.categories) return links.categories(skus);
      return new Map(skus.flatMap((s) => (cats.has(s) ? [[s, cats.get(s)!] as const] : [])));
    },
    async nonceSeen(kid, type, nonce) {
      return nonces.has(`${kid}|${type}|${nonce}`);
    },
    async getPaymentRequest(requestId) {
      const r = requests.get(requestId);
      if (!r) return undefined;
      const order = [...orders.values()].find((o) => o.requestId === requestId) ?? null;
      return { receipt: r.receipt, order: order && { ...order } };
    },
    async ordersSince(userId, since) {
      return [...orders.values()].filter((o) => o.userId === userId && o.createdAt >= since).length;
    },
    async commit(input) {
      // The only awaits come first (mandate lookup, ledger reserve). The synchronous checks and writes
      // after them can't interleave with another commit, so it's all-or-nothing as in Postgres.
      const nk = `${input.agentId}|cart_approval|${input.nonce.value}`;
      const check = () => {
        if (requests.has(input.requestId) || [...requests.values()].some((r) => r.offerId === input.offerId)) {
          return new HandshakeError("DUPLICATE_REQUEST", "request id or offer already paid for");
        }
        const offer = offerRow(input.offerId);
        if (!offer || offer.hash !== input.offerHash || offer.status !== "open" || offer.holdUntil <= input.now) {
          return new HandshakeError(offer?.status === "used" ? "OFFER_USED" : "OFFER_EXPIRED", "offer no longer open");
        }
        if (nonces.has(nk)) return new HandshakeError("APPROVAL_REPLAY", "cart nonce already used");
        const p = input.passkey && passkeys.get(input.passkey.credentialId);
        if (input.passkey && (!p || p.signCount !== input.passkey.expected)) {
          return new HandshakeError("APPROVAL_INVALID", "passkey sign count moved concurrently");
        }
        return undefined;
      };
      const early = check();
      if (early) throw early;
      if (input.ledger) {
        const known = mandates.has(input.ledger.mandateId) || (await links.mandate?.(input.ledger.mandateId));
        if (!known) throw new HandshakeError("MANDATE_INVALID", "unknown mandate");
        if (!(await ledger.reserve(input.ledger))) {
          throw new HandshakeError("MANDATE_LIMIT", "over the mandate's period limit");
        }
      }
      const late = check();
      if (late) {
        if (input.ledger) await ledger.release(input.ledger);
        throw late;
      }
      const pk = input.passkey && passkeys.get(input.passkey.credentialId);
      requests.set(input.requestId, { offerId: input.offerId, receipt: null });
      setOfferStatus(input.offerId, "used");
      nonces.add(nk);
      if (pk && input.passkey) pk.signCount = input.passkey.next;
      orders.set(input.order.id, {
        ...input.order,
        status: "offered",
        paypalOrderId: null,
        authorizationId: null,
        captureId: null,
        refundId: null,
        refundedMinor: 0,
        payerActionUrl: null,
        trackingNumber: null,
        createdAt: input.now,
      });
    },
    async addDecisions(requestId, ds) {
      decisions.push(...ds.map((d) => ({ requestId, ...d })));
    },
    async listDecisions(requestId) {
      return decisions.filter((d) => d.requestId === requestId).map(({ step, result, reason }) => ({ step, result, reason }));
    },
    async getOrder(id) {
      const o = orders.get(id);
      return o && { ...o };
    },
    async findOrder(ref) {
      const o = [...orders.values()].find(
        (x) =>
          (ref.authorizationId && x.authorizationId === ref.authorizationId) ||
          (ref.captureId && x.captureId === ref.captureId) ||
          (ref.paypalOrderId && x.paypalOrderId === ref.paypalOrderId) ||
          (ref.refundId && x.refundId === ref.refundId),
      );
      return o && { ...o };
    },
    async updateOrder(u) {
      const o = orders.get(u.orderId);
      if (!o || o.status !== u.from) return false;
      Object.assign(o, u.set ?? {}, { status: u.to });
      if (u.release) await release(o);
      return true;
    },
    async patchOrder(p) {
      const o = orders.get(p.orderId);
      if (!o || o.status !== p.status) return false;
      Object.assign(o, p.set ?? {});
      return true;
    },
    async saveReceipt(requestId, receipt) {
      const r = requests.get(requestId);
      if (r) r.receipt = receipt;
    },
    async getVault(userId) {
      const v = vaults.get(userId);
      return v?.status === "confirmed" ? v.vaultId : undefined;
    },
    async saveVault({ userId, vaultId, payerId, payerEmail }) {
      const cur = vaults.get(userId);
      if (cur?.status === "confirmed") {
        if (!payerId || cur.payerId !== payerId) return "refused";
        cur.vaultId = vaultId;
        return "kept";
      }
      const status = cur?.status === "pending" && payerId && cur.payerId === payerId ? "pending" : "unbound";
      vaults.set(userId, {
        vaultId,
        status,
        ...(payerId ? { payerId } : {}),
        ...(payerEmail ? { payerEmail } : {}),
      });
      return "unbound";
    },
    async bindVault(userId, payerId) {
      const v = vaults.get(userId);
      if (!v || v.status !== "unbound" || (payerId && v.payerId !== payerId)) return false;
      v.status = "pending";
      return true;
    },
    async dueOrders(now, staleOfferedBefore) {
      return [...orders.values()]
        .filter(
          (o) =>
            (o.status === "authorized" && o.fulfilBy < now) ||
            (o.status === "offered" && o.createdAt < staleOfferedBefore),
        )
        .map((o) => ({ ...o }));
    },
    async purgeNonces() {
      return 0;
    },
    async listRecent(limit = 50) {
      const byReq = new Map<string, Decision[]>();
      for (const d of decisions) byReq.set(d.requestId, [...(byReq.get(d.requestId) ?? []), d]);
      return [...byReq.entries()]
        .reverse()
        .slice(0, limit)
        .map(([requestId, ds]) => ({
          requestId,
          at: Date.now(),
          decisions: ds.map(({ step, result, reason }) => ({ step, result, reason })),
          order: [...orders.values()].find((o) => o.requestId === requestId) ?? null,
        }));
    },
    async addRefund({ orderId, refundId, amountMinor }) {
      const o = orders.get(orderId);
      if (!o || o.status !== "captured") return undefined;
      o.refundedMinor += amountMinor;
      o.refundId = refundId;
      return o.refundedMinor;
    },
    async addReconciliation(r) {
      reconciliations.push(r);
    },
  };
  return { store, ledger, orders, offers, passkeys, mandates, nonces, vaults, decisions, reconciliations };
}
