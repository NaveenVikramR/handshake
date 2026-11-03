// Persistence for the wallet: users, passkeys, registration challenges, approvals.
// Prisma for real runs; memory for tests. Same contract.
import { CartApproval, HandshakeError, IntentMandate, ShipTo, hash, type WebAuthnAssertion } from "@handshake/core";
import type { Prisma, PrismaClient } from "@handshake/db";

export interface StoredCredential {
  credentialId: string;
  userId: string;
  /** COSE public key, base64url. */
  publicKey: string;
  /** The wallet's own last-seen sign count (D16). */
  signCount: number;
  transports: string[];
}

export type ApprovalStatus = "pending" | "approved" | "cancelled";

export interface StoredApproval {
  id: string;
  userId: string;
  payload: CartApproval;
  hash: string;
  status: ApprovalStatus;
  /** ms since epoch */
  expiresAt: number;
  credentialId?: string;
  assertion?: WebAuthnAssertion;
  /** Delivery address matching payload.shipToHash, for the phone page. */
  shipTo?: ShipTo;
}

export interface CompleteApprovalInput {
  id: string;
  credentialId: string;
  /** The sign count the assertion was checked against; the update only applies if it's still current. */
  expectedSignCount: number;
  newSignCount: number;
  assertion: WebAuthnAssertion;
  /** ms since epoch */
  now: number;
}

export type MandateStatus = "pending" | "active" | "revoked";

export interface StoredMandate {
  id: string;
  userId: string;
  payload: IntentMandate;
  hash: string;
  status: MandateStatus;
  /** ms since epoch: a pending mandate can only be activated before this. */
  pendingUntil: number;
  credentialId?: string;
  assertion?: WebAuthnAssertion;
}

/** A trust-registry merchant row. */
export interface RegistryMerchant {
  id: string;
  name: string;
  paypalMerchantId: string;
  status: string;
}

/** A trust-registry agent row. */
export interface RegistryAgentRow {
  id: string;
  role: string;
  /** Ed25519 SPKI DER, base64url. */
  publicKey: string;
  status: string;
  merchantId: string | null;
}

/** An order as the wallet's activity list shows it (the merchant's orders table, shared DB). */
export interface ActivityRow {
  orderId: string;
  requestId: string;
  merchantId: string | null;
  totalMinor: number;
  currency: string;
  status: string;
  path: string;
  /** ms since epoch */
  createdAt: number;
}

/** The user's saved PayPal wallet as the wallet may show it: never the vault id itself. */
export interface VaultView {
  status: "pending" | "confirmed";
  payerId: string | null;
  payerEmail: string | null;
  /** hash of the vault id, so a confirmation is bound to this exact vault. */
  vaultRef: string;
}

export interface LoginChallengeRow {
  id: string;
  userId: string;
  /** The value whose hash is the WebAuthn challenge. */
  payload: unknown;
  /** ms since epoch */
  expiresAt: number;
}

export interface WalletStore {
  /** Registry rows for these merchant ids; unknown ids are simply absent. */
  getMerchants(ids: string[]): Promise<RegistryMerchant[]>;
  getRegistryAgent(id: string): Promise<RegistryAgentRow | undefined>;
  getUser(id: string): Promise<{ id: string; displayName: string } | undefined>;
  /** All of the user's mandates, newest first. */
  listMandates(userId: string): Promise<StoredMandate[]>;
  /** pending|active → revoked for this user's mandate; false if not theirs or already revoked. */
  revokeMandate(id: string, userId: string): Promise<boolean>;
  /** pending → cancelled (the chat waiting for it closed); false otherwise. */
  cancelApproval(id: string): Promise<boolean>;
  deleteSession(tokenHash: string): Promise<void>;
  listActivity(userId: string, limit?: number): Promise<ActivityRow[]>;
  getVault(userId: string): Promise<VaultView | undefined>;
  /** pending → confirmed, only for the same payer and vault the user saw; false otherwise. */
  confirmVault(userId: string, payerId: string, vaultRef: string): Promise<boolean>;
  /** Active mandates of this user, newest first (the caller still checks exp and scope). */
  listActiveMandates(userId: string): Promise<StoredMandate[]>;
  putLoginChallenge(c: LoginChallengeRow): Promise<void>;
  /** Deletes the challenge; returns it only if this call deleted it and it had not expired. */
  takeLoginChallenge(id: string, now: number): Promise<LoginChallengeRow | undefined>;
  /** Wallet sign count compare-and-set (D16); false if it moved since it was read. */
  advanceWalletSignCount(credentialId: string, expected: number, next: number): Promise<boolean>;
  createSession(s: { tokenHash: string; userId: string; expiresAt: number }): Promise<void>;
  /** The session's user if it exists and hasn't expired. */
  getSessionUser(tokenHash: string, now: number): Promise<string | undefined>;
  createUser(user: { id: string; displayName: string }): Promise<void>;
  userExists(id: string): Promise<boolean>;
  hasCredentials(userId: string): Promise<boolean>;
  putRegistrationChallenge(userId: string, challenge: string, expiresAt: number): Promise<void>;
  /** Deletes the challenge; returns it only if it had not expired. */
  takeRegistrationChallenge(userId: string, now: number): Promise<string | undefined>;
  /** Registers in the trust registry (merchant count 0) and the wallet (wallet count 0). */
  addCredential(c: Omit<StoredCredential, "signCount">): Promise<"added" | "exists">;
  getCredential(credentialId: string): Promise<StoredCredential | undefined>;
  listCredentials(userId: string): Promise<StoredCredential[]>;
  createApproval(a: Omit<StoredApproval, "status" | "credentialId" | "assertion">): Promise<void>;
  getApproval(id: string): Promise<StoredApproval | undefined>;
  /**
   * Atomically: pending + unexpired → approved, and wallet sign count expected → new.
   * false if either precondition no longer holds (replay or a concurrent approval).
   */
  completeApproval(input: CompleteApprovalInput): Promise<boolean>;
  createMandate(m: Omit<StoredMandate, "status" | "credentialId" | "assertion">): Promise<void>;
  getMandate(id: string): Promise<StoredMandate | undefined>;
  /** Same contract as completeApproval: pending + within pendingUntil → active, with the sign count CAS. */
  activateMandate(input: CompleteApprovalInput): Promise<boolean>;
}

class Abort extends Error {}

const shipToOf = (v: unknown): ShipTo | undefined => {
  const p = ShipTo.safeParse(v);
  return p.success ? p.data : undefined;
};

// Neon over the pooler can take >2 s (Prisma's default) to hand out a connection on a cold start.
const TX = { maxWait: 10_000, timeout: 15_000 };

export function prismaWalletStore(db: PrismaClient): WalletStore {
  const toCredential = (r: {
    credentialId: string;
    userId: string;
    publicKey: string;
    transports: string[];
    wallet: { signCount: bigint } | null;
  }): StoredCredential => ({
    credentialId: r.credentialId,
    userId: r.userId,
    publicKey: r.publicKey,
    transports: r.transports,
    signCount: Number(r.wallet?.signCount ?? 0n),
  });

  return {
    async getMerchants(ids) {
      return db.registryMerchant.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, paypalMerchantId: true, status: true },
      });
    },
    async getRegistryAgent(id) {
      return (await db.registryAgent.findUnique({ where: { id } })) ?? undefined;
    },
    async getUser(id) {
      return (await db.user.findUnique({ where: { id }, select: { id: true, displayName: true } })) ?? undefined;
    },
    async listMandates(userId) {
      const rows = await db.mandate.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
        take: 50,
      });
      const out: StoredMandate[] = [];
      for (const { id } of rows) {
        const m = await this.getMandate(id);
        if (m) out.push(m);
      }
      return out;
    },
    async revokeMandate(id, userId) {
      const { count } = await db.mandate.updateMany({
        where: { id, userId, status: { in: ["pending", "active"] } },
        data: { status: "revoked" },
      });
      return count === 1;
    },
    async cancelApproval(id) {
      const { count } = await db.approval.updateMany({ where: { id, status: "pending" }, data: { status: "cancelled" } });
      return count === 1;
    },
    async deleteSession(tokenHash) {
      await db.session.deleteMany({ where: { tokenHash } });
    },
    async listActivity(userId, limit = 30) {
      const orders = await db.order.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: limit });
      const offers = await db.offer.findMany({
        where: { id: { in: orders.map((o) => o.offerId) } },
        select: { id: true, payloadJson: true },
      });
      const merchantOf = new Map(
        offers.map((o) => [o.id, ((o.payloadJson as { payload?: { merchantId?: string } }).payload?.merchantId ?? null)]),
      );
      return orders.map((o) => ({
        orderId: o.id,
        requestId: o.requestId,
        merchantId: merchantOf.get(o.offerId) ?? null,
        totalMinor: o.totalMinor,
        currency: o.currency,
        status: o.status,
        path: o.path,
        createdAt: o.createdAt.getTime(),
      }));
    },
    async getVault(userId) {
      const v = await db.paypalVault.findUnique({ where: { userId } });
      // Unbound: saved by an agent payment the owner hasn't come back from yet; not theirs to confirm.
      if (!v || (v.status !== "pending" && v.status !== "confirmed")) return undefined;
      return {
        status: v.status === "confirmed" ? "confirmed" : "pending",
        payerId: v.payerId,
        payerEmail: v.payerEmail,
        vaultRef: hash({ vaultId: v.vaultId }),
      };
    },
    async confirmVault(userId, payerId, vaultRef) {
      return db.$transaction(async (tx) => {
        const v = await tx.paypalVault.findUnique({ where: { userId } });
        if (!v || v.status !== "pending" || v.payerId !== payerId || hash({ vaultId: v.vaultId }) !== vaultRef) return false;
        const { count } = await tx.paypalVault.updateMany({
          where: { userId, status: "pending", vaultId: v.vaultId, payerId },
          data: { status: "confirmed", confirmedAt: new Date() },
        });
        return count === 1;
      }, TX);
    },
    async listActiveMandates(userId) {
      const rows = await db.mandate.findMany({
        where: { userId, status: "active" },
        orderBy: { activatedAt: "desc" },
        select: { id: true },
        take: 20,
      });
      const out: StoredMandate[] = [];
      for (const { id } of rows) {
        const m = await this.getMandate(id);
        if (m) out.push(m);
      }
      return out;
    },
    async putLoginChallenge({ id, userId, payload, expiresAt }) {
      await db.loginChallenge.create({
        data: { id, userId, payloadJson: payload as Prisma.InputJsonValue, expiresAt: new Date(expiresAt) },
      });
    },
    async takeLoginChallenge(id, now) {
      const row = await db.loginChallenge.findUnique({ where: { id } });
      if (!row) return undefined;
      // Of two concurrent takes, only one deletes the row.
      const { count } = await db.loginChallenge.deleteMany({ where: { id } });
      if (count !== 1 || row.expiresAt.getTime() <= now) return undefined;
      return { id: row.id, userId: row.userId, payload: row.payloadJson, expiresAt: row.expiresAt.getTime() };
    },
    async advanceWalletSignCount(credentialId, expected, next) {
      const { count } = await db.walletCredential.updateMany({
        where: { credentialId, signCount: BigInt(expected) },
        data: { signCount: BigInt(next) },
      });
      return count === 1;
    },
    async createSession({ tokenHash, userId, expiresAt }) {
      await db.session.create({ data: { tokenHash, userId, expiresAt: new Date(expiresAt) } });
    },
    async getSessionUser(tokenHash, now) {
      const s = await db.session.findUnique({ where: { tokenHash } });
      return s && s.expiresAt.getTime() > now ? s.userId : undefined;
    },
    async createUser({ id, displayName }) {
      await db.user.create({ data: { id, displayName } });
    },
    async userExists(id) {
      return (await db.user.count({ where: { id } })) > 0;
    },
    async hasCredentials(userId) {
      return (await db.registryPasskey.count({ where: { userId } })) > 0;
    },
    async putRegistrationChallenge(userId, challenge, expiresAt) {
      const data = { challenge, expiresAt: new Date(expiresAt) };
      await db.registrationChallenge.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    },
    async takeRegistrationChallenge(userId, now) {
      const row = await db.registrationChallenge.findUnique({ where: { userId } });
      if (!row) return undefined;
      // Delete by exact value: of two concurrent takes, only one sees count 1.
      const { count } = await db.registrationChallenge.deleteMany({ where: { userId, challenge: row.challenge } });
      return count === 1 && row.expiresAt.getTime() > now ? row.challenge : undefined;
    },
    async addCredential({ credentialId, userId, publicKey, transports }) {
      return db.$transaction(async (tx) => {
        const { count } = await tx.registryPasskey.createMany({
          data: [{ credentialId, userId, publicKey, transports }],
          skipDuplicates: true,
        });
        if (count === 0) return "exists";
        await tx.walletCredential.create({ data: { credentialId } });
        return "added";
      }, TX);
    },
    async getCredential(credentialId) {
      const r = await db.registryPasskey.findUnique({ where: { credentialId }, include: { wallet: true } });
      return r ? toCredential(r) : undefined;
    },
    async listCredentials(userId) {
      const rows = await db.registryPasskey.findMany({ where: { userId }, include: { wallet: true } });
      return rows.map(toCredential);
    },
    async createApproval({ id, userId, payload, hash, expiresAt, shipTo }) {
      await db.approval.create({
        data: {
          id,
          userId,
          payloadJson: payload as Prisma.InputJsonValue,
          hash,
          expiresAt: new Date(expiresAt),
          ...(shipTo ? { shipToJson: shipTo as Prisma.InputJsonValue } : {}),
        },
      });
    },
    async getApproval(id) {
      const r = await db.approval.findUnique({ where: { id } });
      if (!r) return undefined;
      // Re-parse: what goes to the phone and gets verified must still be a valid cart.
      const payload = CartApproval.safeParse(r.payloadJson);
      if (!payload.success) throw new HandshakeError("APPROVAL_INVALID", "stored cart is invalid");
      return {
        id: r.id,
        userId: r.userId,
        payload: payload.data,
        hash: r.hash,
        status: r.status as ApprovalStatus,
        expiresAt: r.expiresAt.getTime(),
        ...(r.credentialId ? { credentialId: r.credentialId } : {}),
        ...(r.assertionJson ? { assertion: r.assertionJson as unknown as WebAuthnAssertion } : {}),
        ...(shipToOf(r.shipToJson) ? { shipTo: shipToOf(r.shipToJson)! } : {}),
      };
    },
    async createMandate({ id, userId, payload, hash, pendingUntil }) {
      await db.mandate.create({
        data: { id, userId, payloadJson: payload as Prisma.InputJsonValue, hash, pendingUntil: new Date(pendingUntil) },
      });
    },
    async getMandate(id) {
      const r = await db.mandate.findUnique({ where: { id } });
      if (!r) return undefined;
      const payload = IntentMandate.safeParse(r.payloadJson);
      if (!payload.success) throw new HandshakeError("MANDATE_INVALID", "stored mandate is invalid");
      return {
        id: r.id,
        userId: r.userId,
        payload: payload.data,
        hash: r.hash,
        status: r.status as MandateStatus,
        pendingUntil: r.pendingUntil.getTime(),
        ...(r.credentialId ? { credentialId: r.credentialId } : {}),
        ...(r.assertionJson ? { assertion: r.assertionJson as unknown as WebAuthnAssertion } : {}),
      };
    },
    async activateMandate({ id, credentialId, expectedSignCount, newSignCount, assertion, now }) {
      try {
        await db.$transaction(async (tx) => {
          const m = await tx.mandate.updateMany({
            where: { id, status: "pending", pendingUntil: { gt: new Date(now) } },
            data: {
              status: "active",
              credentialId,
              assertionJson: assertion as unknown as Prisma.InputJsonValue,
              activatedAt: new Date(now),
            },
          });
          if (m.count !== 1) throw new Abort();
          const c = await tx.walletCredential.updateMany({
            where: { credentialId, signCount: BigInt(expectedSignCount) },
            data: { signCount: BigInt(newSignCount) },
          });
          if (c.count !== 1) throw new Abort();
        }, TX);
        return true;
      } catch (e) {
        if (e instanceof Abort) return false;
        throw e;
      }
    },
    async completeApproval({ id, credentialId, expectedSignCount, newSignCount, assertion, now }) {
      try {
        await db.$transaction(async (tx) => {
          const a = await tx.approval.updateMany({
            where: { id, status: "pending", expiresAt: { gt: new Date(now) } },
            data: {
              status: "approved",
              credentialId,
              assertionJson: assertion as unknown as Prisma.InputJsonValue,
              approvedAt: new Date(now),
            },
          });
          if (a.count !== 1) throw new Abort();
          const c = await tx.walletCredential.updateMany({
            where: { credentialId, signCount: BigInt(expectedSignCount) },
            data: { signCount: BigInt(newSignCount) },
          });
          if (c.count !== 1) throw new Abort();
        }, TX);
        return true;
      } catch (e) {
        if (e instanceof Abort) return false;
        throw e;
      }
    },
  };
}

/** In-memory store for tests only: no isolation between concurrent requests. */
export function memoryWalletStore(
  seed: {
    merchants?: RegistryMerchant[];
    agents?: RegistryAgentRow[];
    /** Shared-DB stand-ins: the merchant's orders and saved wallets (same rows in Postgres). */
    activity?: (userId: string) => ActivityRow[];
    vaults?: Map<string, { vaultId: string; payerId?: string; payerEmail?: string; status: "unbound" | "pending" | "confirmed" }>;
  } = {},
): WalletStore {
  const merchants = new Map((seed.merchants ?? []).map((m) => [m.id, { ...m }]));
  const agents = new Map((seed.agents ?? []).map((a) => [a.id, { ...a }]));
  const logins = new Map<string, LoginChallengeRow>();
  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  const users = new Map<string, { id: string; displayName: string }>();
  const challenges = new Map<string, { challenge: string; expiresAt: number }>();
  const credentials = new Map<string, StoredCredential>();
  const approvals = new Map<string, StoredApproval>();
  const mandates = new Map<string, StoredMandate>();

  return {
    async getMerchants(ids) {
      return ids.flatMap((id) => {
        const m = merchants.get(id);
        return m ? [{ ...m }] : [];
      });
    },
    async getRegistryAgent(id) {
      const a = agents.get(id);
      return a && { ...a };
    },
    async getUser(id) {
      const u = users.get(id);
      return u && { ...u };
    },
    async listMandates(userId) {
      return [...mandates.values()].filter((m) => m.userId === userId).reverse().map((m) => ({ ...m }));
    },
    async revokeMandate(id, userId) {
      const m = mandates.get(id);
      if (!m || m.userId !== userId || m.status === "revoked") return false;
      mandates.set(id, { ...m, status: "revoked" });
      return true;
    },
    async cancelApproval(id) {
      const a = approvals.get(id);
      if (!a || a.status !== "pending") return false;
      approvals.set(id, { ...a, status: "cancelled" });
      return true;
    },
    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },
    async listActivity(userId) {
      return (seed.activity?.(userId) ?? []).map((r) => ({ ...r }));
    },
    async getVault(userId) {
      const v = seed.vaults?.get(userId);
      if (!v || v.status === "unbound") return undefined;
      return v && { status: v.status, payerId: v.payerId ?? null, payerEmail: v.payerEmail ?? null, vaultRef: hash({ vaultId: v.vaultId }) };
    },
    async confirmVault(userId, payerId, vaultRef) {
      const v = seed.vaults?.get(userId);
      if (!v || v.status !== "pending" || v.payerId !== payerId || hash({ vaultId: v.vaultId }) !== vaultRef) {
        return false;
      }
      v.status = "confirmed";
      return true;
    },
    async listActiveMandates(userId) {
      return [...mandates.values()].filter((m) => m.userId === userId && m.status === "active").reverse();
    },
    async putLoginChallenge(c) {
      logins.set(c.id, { ...c });
    },
    async takeLoginChallenge(id, now) {
      const c = logins.get(id);
      logins.delete(id);
      return c && c.expiresAt > now ? c : undefined;
    },
    async advanceWalletSignCount(credentialId, expected, next) {
      const c = credentials.get(credentialId);
      if (!c || c.signCount !== expected) return false;
      credentials.set(credentialId, { ...c, signCount: next });
      return true;
    },
    async createSession({ tokenHash, userId, expiresAt }) {
      sessions.set(tokenHash, { userId, expiresAt });
    },
    async getSessionUser(tokenHash, now) {
      const s = sessions.get(tokenHash);
      return s && s.expiresAt > now ? s.userId : undefined;
    },
    async createUser(u) {
      if (users.has(u.id)) throw new Error("user exists");
      users.set(u.id, u);
    },
    async userExists(id) {
      return users.has(id);
    },
    async hasCredentials(userId) {
      return [...credentials.values()].some((c) => c.userId === userId);
    },
    async putRegistrationChallenge(userId, challenge, expiresAt) {
      challenges.set(userId, { challenge, expiresAt });
    },
    async takeRegistrationChallenge(userId, now) {
      const c = challenges.get(userId);
      challenges.delete(userId);
      return c && c.expiresAt > now ? c.challenge : undefined;
    },
    async addCredential(c) {
      if (credentials.has(c.credentialId)) return "exists";
      credentials.set(c.credentialId, { ...c, signCount: 0 });
      return "added";
    },
    async getCredential(id) {
      const c = credentials.get(id);
      return c && { ...c };
    },
    async listCredentials(userId) {
      return [...credentials.values()].filter((c) => c.userId === userId).map((c) => ({ ...c }));
    },
    async createApproval(a) {
      if ([...approvals.values()].some((x) => x.hash === a.hash)) throw new Error("approval hash exists");
      approvals.set(a.id, { ...a, status: "pending" });
    },
    async getApproval(id) {
      const a = approvals.get(id);
      return a && { ...a };
    },
    async createMandate(m) {
      if ([...mandates.values()].some((x) => x.hash === m.hash)) throw new Error("mandate hash exists");
      mandates.set(m.id, { ...m, status: "pending" });
    },
    async getMandate(id) {
      const m = mandates.get(id);
      return m && { ...m };
    },
    async activateMandate({ id, credentialId, expectedSignCount, newSignCount, assertion, now }) {
      const m = mandates.get(id);
      const c = credentials.get(credentialId);
      if (!m || m.status !== "pending" || m.pendingUntil <= now) return false;
      if (!c || c.signCount !== expectedSignCount) return false;
      mandates.set(id, { ...m, status: "active", credentialId, assertion });
      credentials.set(credentialId, { ...c, signCount: newSignCount });
      return true;
    },
    async completeApproval({ id, credentialId, expectedSignCount, newSignCount, assertion, now }) {
      const a = approvals.get(id);
      const c = credentials.get(credentialId);
      if (!a || a.status !== "pending" || a.expiresAt <= now) return false;
      if (!c || c.signCount !== expectedSignCount) return false;
      approvals.set(id, { ...a, status: "approved", credentialId, assertion });
      credentials.set(credentialId, { ...c, signCount: newSignCount });
      return true;
    },
  };
}
