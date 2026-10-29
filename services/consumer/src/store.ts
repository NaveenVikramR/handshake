// Persistence for the wallet: users, passkeys, registration challenges, approvals.
// Prisma for real runs; memory for tests. Same contract.
import { CartApproval, HandshakeError, type WebAuthnAssertion } from "@handshake/core";
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

export type ApprovalStatus = "pending" | "approved";

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

export interface WalletStore {
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
}

class Abort extends Error {}

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
    async createApproval({ id, userId, payload, hash, expiresAt }) {
      await db.approval.create({
        data: { id, userId, payloadJson: payload as Prisma.InputJsonValue, hash, expiresAt: new Date(expiresAt) },
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
      };
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
export function memoryWalletStore(): WalletStore {
  const users = new Map<string, { id: string; displayName: string }>();
  const challenges = new Map<string, { challenge: string; expiresAt: number }>();
  const credentials = new Map<string, StoredCredential>();
  const approvals = new Map<string, StoredApproval>();

  return {
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
