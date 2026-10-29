// prismaWalletStore against the Neon dev branch (`pnpm test:db`): the compare-and-set paths that
// the in-memory store can't prove. Creates its own rows and deletes them afterwards.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CartApproval, IntentMandate, hash, randomNonce } from "@handshake/core";
import { createDb } from "@handshake/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaWalletStore } from "../src/store.js";

const enabled = process.env.DB_TESTS === "1";
const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (enabled && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

describe.skipIf(!enabled)("prismaWalletStore on Postgres (DB_TESTS=1)", () => {
  const db = enabled ? createDb() : (undefined as never);
  const store = enabled ? prismaWalletStore(db) : (undefined as never);
  const tag = randomBytes(6).toString("hex");
  const userId = `usr_store${tag}`;
  const credentialId = `cred${tag}`;
  const now = Date.now();
  const iat = Math.floor(now / 1000);
  const assertion = { credentialId, authenticatorData: "a", clientDataJSON: "b", signature: "c" };

  beforeAll(async () => {
    await store.createUser({ id: userId, displayName: "store test" });
    await store.addCredential({ credentialId, userId, publicKey: "pk", transports: ["internal"] });
  });

  afterAll(async () => {
    await db.approval.deleteMany({ where: { userId } });
    await db.mandate.deleteMany({ where: { userId } });
    await db.walletCredential.deleteMany({ where: { credentialId } });
    await db.registryPasskey.deleteMany({ where: { userId } });
    await db.registrationChallenge.deleteMany({ where: { userId } });
    await db.loginChallenge.deleteMany({ where: { userId } });
    await db.session.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.registryMerchant.deleteMany({ where: { id: { startsWith: `mer_store${tag}` } } });
    await db.$disconnect();
  });

  it("registration challenge: upsert replaces, concurrent takes yield it once", async () => {
    await store.putRegistrationChallenge(userId, "c1", now + 60_000);
    await store.putRegistrationChallenge(userId, "c2", now + 60_000);
    const taken = await Promise.all([
      store.takeRegistrationChallenge(userId, now),
      store.takeRegistrationChallenge(userId, now),
    ]);
    expect(taken.filter((t) => t === "c2")).toHaveLength(1);
    expect(taken).toContain(undefined);
  });

  it("credential: duplicate add refused; wallet count starts 0; merchant count untouched", async () => {
    expect(await store.addCredential({ credentialId, userId, publicKey: "pk2", transports: [] })).toBe("exists");
    expect((await store.getCredential(credentialId))?.signCount).toBe(0);
  });

  it("approval: unique hash, re-parsed on read, concurrent completes → exactly one wins", async () => {
    const cart = CartApproval.parse({
      v: 1,
      type: "cart_approval",
      offerId: "off_store",
      offerHash: hash({ o: tag }),
      merchantId: "mer_corner",
      items: [{ sku: "RICE-2KG", name: "Rice 2 kg", qty: 1, unitMinor: 499 }],
      totalMinor: 499,
      currency: "USD",
      shipToHash: hash({ s: 1 }),
      consumerAgentId: "agt_c_demo",
      userId,
      iat,
      exp: iat + 300,
      nonce: randomNonce(),
    });
    const id = `apr_store${tag}`;
    await store.createApproval({ id, userId, payload: cart, hash: hash(cart), expiresAt: now + 60_000 });
    await expect(
      store.createApproval({ id: `${id}x`, userId, payload: cart, hash: hash(cart), expiresAt: now + 60_000 }),
    ).rejects.toThrow();
    expect((await store.getApproval(id))?.payload).toEqual(cart);

    const before = (await store.getCredential(credentialId))!.signCount;
    const input = { id, credentialId, expectedSignCount: before, newSignCount: before + 1, assertion, now };
    const results = await Promise.all([store.completeApproval(input), store.completeApproval(input)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.getApproval(id))?.status).toBe("approved");
    expect((await store.getCredential(credentialId))?.signCount).toBe(before + 1);
    const reg = await db.registryPasskey.findUnique({ where: { credentialId } });
    expect(reg?.signCount).toBe(0n); // the merchant's count is separate (D16)
  });

  it("mandate: pending → active once, with the sign count CAS; expired window refused", async () => {
    const draft = (n: string) =>
      IntentMandate.parse({
        v: 1,
        type: "intent_mandate",
        mandateId: `man_store${tag}${n}`,
        userId,
        consumerAgentId: "agt_c_demo",
        scope: { merchants: ["mer_corner"], categories: ["grocery"] },
        limits: { perOrderMinor: 3000, periodMinor: 8000, period: "week" },
        shipToHash: hash({ s: 1 }),
        iat,
        exp: iat + 7 * 86400,
        nonce: randomNonce(),
      });
    const m = draft("a");
    await store.createMandate({ id: m.mandateId, userId, payload: m, hash: hash(m), pendingUntil: now + 60_000 });
    expect((await store.getMandate(m.mandateId))?.payload).toEqual(m);

    const before = (await store.getCredential(credentialId))!.signCount;
    const input = {
      id: m.mandateId,
      credentialId,
      expectedSignCount: before,
      newSignCount: before + 1,
      assertion,
      now,
    };
    const results = await Promise.all([store.activateMandate(input), store.activateMandate(input)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.getMandate(m.mandateId))?.status).toBe("active");

    const late = draft("b");
    await store.createMandate({ id: late.mandateId, userId, payload: late, hash: hash(late), pendingUntil: now - 1 });
    const cur = (await store.getCredential(credentialId))!.signCount;
    expect(
      await store.activateMandate({ ...input, id: late.mandateId, expectedSignCount: cur, newSignCount: cur + 1 }),
    ).toBe(false);
    expect((await store.getMandate(late.mandateId))?.status).toBe("pending");
  });

  it("getMerchants returns registry rows for known ids only, with status", async () => {
    const [a, b] = [`mer_store${tag}a`, `mer_store${tag}b`];
    await db.registryMerchant.createMany({
      data: [
        { id: a, name: "Active", paypalMerchantId: `PPA${tag}`, status: "active" },
        { id: b, name: "Gone", paypalMerchantId: `PPB${tag}`, status: "suspended" },
      ],
    });
    const rows = await store.getMerchants([a, b, `mer_store${tag}none`]);
    expect(rows.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: a, name: "Active", paypalMerchantId: `PPA${tag}`, status: "active" },
      { id: b, name: "Gone", paypalMerchantId: `PPB${tag}`, status: "suspended" },
    ]);
  });

  it("login challenge: concurrent takes yield it once; expired yields nothing", async () => {
    await store.putLoginChallenge({ id: `lgn_${tag}a`, userId, payload: { p: 1 }, expiresAt: now + 60_000 });
    const taken = await Promise.all([store.takeLoginChallenge(`lgn_${tag}a`, now), store.takeLoginChallenge(`lgn_${tag}a`, now)]);
    expect(taken.filter(Boolean)).toHaveLength(1);
    expect(taken.find(Boolean)?.payload).toEqual({ p: 1 });
    await store.putLoginChallenge({ id: `lgn_${tag}b`, userId, payload: {}, expiresAt: now - 1 });
    expect(await store.takeLoginChallenge(`lgn_${tag}b`, now)).toBeUndefined();
  });

  it("sessions resolve by token hash until they expire; wallet sign count CAS", async () => {
    await store.createSession({ tokenHash: `th${tag}`, userId, expiresAt: now + 60_000 });
    expect(await store.getSessionUser(`th${tag}`, now)).toBe(userId);
    expect(await store.getSessionUser(`th${tag}`, now + 60_001)).toBeUndefined();
    const cur = (await store.getCredential(credentialId))!.signCount;
    const cas = await Promise.all([
      store.advanceWalletSignCount(credentialId, cur, cur + 1),
      store.advanceWalletSignCount(credentialId, cur, cur + 1),
    ]);
    expect(cas.filter(Boolean)).toHaveLength(1);
  });

  it("listActiveMandates returns only active ones, re-parsed", async () => {
    const active = await store.listActiveMandates(userId);
    expect(active.length).toBeGreaterThan(0);
    expect(active.every((m) => m.status === "active" && m.payload.type === "intent_mandate")).toBe(true);
  });
});
