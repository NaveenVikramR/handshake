import { hash, randomNonce, type CartApproval } from "@handshake/core";
import { FakeAuthenticator, type AssertOptions } from "../../../packages/core/test/fake-authenticator.js";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createApproval } from "../src/approvals/service.js";
import type { AppContext } from "../src/context.js";
import { memoryWalletStore } from "../src/store.js";

const webauthn = { rpId: "wallet.handshake.test", rpName: "Handshake", origin: "https://wallet.handshake.test" };
const T0 = 1_762_000_000_000;

function setup() {
  const clock = { t: T0 };
  const ctx: AppContext = { store: memoryWalletStore(), webauthn, consumerAgentId: "agt_c_alice", now: () => clock.t };
  return { ctx, app: createApp(ctx), clock };
}

type Setup = ReturnType<typeof setup>;

async function register(s: Setup, auth = new FakeAuthenticator(webauthn.rpId, webauthn.origin)) {
  const opts = await request(s.app).post("/passkeys/register/options").send({ displayName: "Alice" });
  expect(opts.status).toBe(200);
  const { userId, options } = opts.body as { userId: string; options: { challenge: string } };
  const res = await request(s.app)
    .post("/passkeys/register/verify")
    .send({ userId, response: auth.register(options.challenge) });
  expect(res.status).toBe(200);
  return { userId, auth };
}

function cartFor(userId: string, nowMs: number, overrides: Partial<CartApproval> = {}): CartApproval {
  const iat = Math.floor(nowMs / 1000);
  const items = [{ sku: "RICE-2KG", name: "Rice 2 kg", qty: 1, unitMinor: 499 }];
  return {
    v: 1,
    type: "cart_approval",
    offerId: "off_1",
    offerHash: hash({ offer: 1 }),
    merchantId: "mer_corner",
    items,
    totalMinor: 499,
    currency: "USD",
    shipToHash: hash({ line1: "1 Main St" }),
    consumerAgentId: "agt_c_alice",
    userId,
    iat,
    exp: iat + 300,
    nonce: randomNonce(),
    ...overrides,
  };
}

async function approve(s: Setup, id: string, auth: FakeAuthenticator, opts: AssertOptions = {}) {
  const got = await request(s.app).get(`/approvals/${id}`);
  expect(got.status).toBe(200);
  const challenge = (got.body as { options: { challenge: string } }).options.challenge;
  return request(s.app)
    .post(`/approvals/${id}/verify`)
    .send({ response: auth.assertJSON(challenge, opts) });
}

describe("passkey registration", () => {
  it("creates a user, stores the COSE key in the registry, requires UV", async () => {
    const s = setup();
    const { userId, auth } = await register(s);
    const creds = await s.ctx.store.listCredentials(userId);
    expect(creds).toEqual([
      {
        credentialId: auth.credentialId,
        userId,
        publicKey: auth.publicKeyCose,
        signCount: 0,
        transports: ["internal"],
      },
    ]);
  });

  it("asks for userVerification required and a resident key when possible", async () => {
    const s = setup();
    const res = await request(s.app).post("/passkeys/register/options").send({ displayName: "Alice" });
    expect(res.body.options.authenticatorSelection).toMatchObject({
      userVerification: "required",
      residentKey: "preferred",
    });
    expect(res.body.options.rp).toEqual({ name: "Handshake", id: webauthn.rpId });
  });

  it.each<[string, { uv?: boolean; origin?: string; rpId?: string }]>([
    ["UV missing", { uv: false }],
    ["wrong origin", { origin: "https://evil.example" }],
    ["wrong rpId", { rpId: "evil.example" }],
  ])("rejects %s and stores nothing", async (_name, opts) => {
    const s = setup();
    const { body } = await request(s.app).post("/passkeys/register/options").send({ displayName: "Alice" });
    const auth = new FakeAuthenticator(webauthn.rpId, webauthn.origin);
    const res = await request(s.app)
      .post("/passkeys/register/verify")
      .send({ userId: body.userId, response: auth.register(body.options.challenge, opts) });
    expect(res.status).toBe(400);
    expect(await s.ctx.store.listCredentials(body.userId)).toEqual([]);
  });

  it("rejects a response signed over a different challenge", async () => {
    const s = setup();
    const { body } = await request(s.app).post("/passkeys/register/options").send({ displayName: "Alice" });
    const auth = new FakeAuthenticator(webauthn.rpId, webauthn.origin);
    const res = await request(s.app)
      .post("/passkeys/register/verify")
      .send({ userId: body.userId, response: auth.register("b3RoZXItY2hhbGxlbmdl") });
    expect(res.body).toEqual({ error: "REGISTRATION_INVALID" });
  });

  it("a challenge can be used once, and expires after 5 minutes", async () => {
    const s = setup();
    const { body } = await request(s.app).post("/passkeys/register/options").send({ displayName: "Alice" });
    const auth = new FakeAuthenticator(webauthn.rpId, webauthn.origin);
    const resp = auth.register(body.options.challenge);
    expect(
      (await request(s.app).post("/passkeys/register/verify").send({ userId: body.userId, response: resp })).status,
    ).toBe(200);
    const again = await request(s.app).post("/passkeys/register/verify").send({ userId: body.userId, response: resp });
    expect(again.body).toEqual({ error: "REGISTRATION_EXPIRED" });

    const late = await request(s.app).post("/passkeys/register/options").send({ displayName: "Bob" });
    s.clock.t += 5 * 60_000 + 1;
    const b = new FakeAuthenticator(webauthn.rpId, webauthn.origin);
    const res = await request(s.app)
      .post("/passkeys/register/verify")
      .send({ userId: late.body.userId, response: b.register(late.body.options.challenge) });
    expect(res.body).toEqual({ error: "REGISTRATION_EXPIRED" });
  });

  it("can't add a second passkey to an existing user (no sign-in yet → takeover risk)", async () => {
    const s = setup();
    const { userId } = await register(s);
    await s.ctx.store.putRegistrationChallenge(userId, "Y2hhbGxlbmdl", s.clock.t + 60_000);
    const mallory = new FakeAuthenticator(webauthn.rpId, webauthn.origin);
    const res = await request(s.app)
      .post("/passkeys/register/verify")
      .send({ userId, response: mallory.register("Y2hhbGxlbmdl") });
    expect(res.status).toBe(409);
    expect((await s.ctx.store.listCredentials(userId)).map((c) => c.credentialId)).not.toContain(mallory.credentialId);
  });

  it.each([
    ["missing displayName", "/passkeys/register/options", {}],
    ["bad userId", "/passkeys/register/verify", { userId: "admin", response: {} }],
  ])("400 on %s", async (_n, path, body) => {
    const s = setup();
    expect((await request(s.app).post(path).send(body)).status).toBe(400);
  });

  it("400 on malformed JSON without leaking a stack", async () => {
    const s = setup();
    const res = await request(s.app)
      .post("/passkeys/register/options")
      .set("Content-Type", "application/json")
      .send("{bad");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "SCHEMA_INVALID" });
  });
});

describe("cart approval", () => {
  it("GET shows the exact cart and options whose challenge is hash(cart)", async () => {
    const s = setup();
    const { userId, auth } = await register(s);
    const cart = cartFor(userId, s.clock.t);
    const { id } = await createApproval(s.ctx, cart);
    const res = await request(s.app).get(`/approvals/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.cart).toEqual(cart);
    expect(res.body.options.challenge).toBe(hash(cart));
    expect(res.body.options.userVerification).toBe("required");
    expect(res.body.options.rpId).toBe(webauthn.rpId);
    expect(res.body.options.allowCredentials).toEqual([
      { id: auth.credentialId, type: "public-key", transports: ["internal"] },
    ]);
  });

  it("approves with a UV passkey, stores the assertion, advances the wallet sign count", async () => {
    const s = setup();
    const { userId, auth } = await register(s);
    const { id } = await createApproval(s.ctx, cartFor(userId, s.clock.t));
    const res = await approve(s, id, auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, status: "approved" });
    const stored = await s.ctx.store.getApproval(id);
    expect(stored?.status).toBe("approved");
    expect(stored?.assertion?.credentialId).toBe(auth.credentialId);
    expect((await s.ctx.store.getCredential(auth.credentialId))?.signCount).toBe(1);
  });

  it("works for a synced passkey that always reports 0", async () => {
    const s = setup();
    const { userId, auth } = await register(s, new FakeAuthenticator(webauthn.rpId, webauthn.origin, false));
    for (let i = 0; i < 2; i++) {
      const { id } = await createApproval(s.ctx, cartFor(userId, s.clock.t));
      expect((await approve(s, id, auth)).status).toBe(200);
    }
  });

  it("UV missing → 401 APPROVAL_UV_MISSING, approval stays pending", async () => {
    const s = setup();
    const { userId, auth } = await register(s);
    const { id } = await createApproval(s.ctx, cartFor(userId, s.clock.t));
    const res = await approve(s, id, auth, { uv: false });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "APPROVAL_UV_MISSING" });
    expect((await s.ctx.store.getApproval(id))?.status).toBe("pending");
  });

  it("signCount rollback → APPROVAL_INVALID", async () => {
    const s = setup();
    const { userId, auth } = await register(s);
    const first = await createApproval(s.ctx, cartFor(userId, s.clock.t));
    expect((await approve(s, first.id, auth)).status).toBe(200);
    const second = await createApproval(s.ctx, cartFor(userId, s.clock.t));
    const res = await approve(s, second.id, auth, { signCount: 1 });
    expect(res.body).toEqual({ error: "APPROVAL_INVALID" });
  });

  it("wrong origin → APPROVAL_INVALID", async () => {
    const s = setup();
    const { userId, auth } = await register(s);
    const { id } = await createApproval(s.ctx, cartFor(userId, s.clock.t));
    expect((await approve(s, id, auth, { origin: "https://evil.example" })).body).toEqual({
      error: "APPROVAL_INVALID",
    });
  });

  it("wrong rpId → APPROVAL_INVALID", async () => {
    const s = setup();
    const { userId, auth } = await register(s);
    const { id } = await createApproval(s.ctx, cartFor(userId, s.clock.t));
    expect((await approve(s, id, auth, { rpId: "evil.example" })).body).toEqual({ error: "APPROVAL_INVALID" });
  });

  it("wrong challenge (signed a different cart) → CART_HASH_MISMATCH", async () => {
    const s = setup();
    const { userId, auth } = await register(s);
    const { id } = await createApproval(s.ctx, cartFor(userId, s.clock.t));
    const other = hash(
      cartFor(userId, s.clock.t, {
        totalMinor: 998,
        items: [{ sku: "RICE-2KG", name: "Rice 2 kg", qty: 2, unitMinor: 499 }],
      }),
    );
    const res = await approve(s, id, auth, { challenge: other });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "CART_HASH_MISMATCH" });
  });

  it("replaying an approval → 409 APPROVAL_REPLAY", async () => {
    const s = setup();
    const { userId, auth } = await register(s);
    const { id } = await createApproval(s.ctx, cartFor(userId, s.clock.t));
    const got = await request(s.app).get(`/approvals/${id}`);
    const body = { response: auth.assertJSON(got.body.options.challenge) };
    expect((await request(s.app).post(`/approvals/${id}/verify`).send(body)).status).toBe(200);
    const again = await request(s.app).post(`/approvals/${id}/verify`).send(body);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "APPROVAL_REPLAY" });
    expect((await request(s.app).get(`/approvals/${id}`)).body).toEqual({ error: "APPROVAL_REPLAY" });
  });

  it("expired approval → APPROVAL_EXPIRED", async () => {
    const s = setup();
    const { userId, auth } = await register(s);
    const { id } = await createApproval(s.ctx, cartFor(userId, s.clock.t));
    const got = await request(s.app).get(`/approvals/${id}`);
    s.clock.t += 301_000;
    const res = await request(s.app)
      .post(`/approvals/${id}/verify`)
      .send({ response: auth.assertJSON(got.body.options.challenge) });
    expect(res.body).toEqual({ error: "APPROVAL_EXPIRED" });
  });

  it("another user's passkey can't approve → APPROVAL_INVALID", async () => {
    const s = setup();
    const alice = await register(s);
    const bob = await register(s);
    const { id } = await createApproval(s.ctx, cartFor(alice.userId, s.clock.t));
    expect((await approve(s, id, bob.auth)).body).toEqual({ error: "APPROVAL_INVALID" });
  });

  it("unregistered authenticator → APPROVAL_INVALID", async () => {
    const s = setup();
    const { userId } = await register(s);
    const { id } = await createApproval(s.ctx, cartFor(userId, s.clock.t));
    const stranger = new FakeAuthenticator(webauthn.rpId, webauthn.origin);
    expect((await approve(s, id, stranger)).body).toEqual({ error: "APPROVAL_INVALID" });
  });

  it("unknown or malformed approval id → APPROVAL_INVALID", async () => {
    const s = setup();
    expect((await request(s.app).get("/approvals/apr_AAAAAAAAAAAAAAAAAAAAAA")).body).toEqual({
      error: "APPROVAL_INVALID",
    });
    expect((await request(s.app).get("/approvals/../../etc")).status).toBe(404);
  });

  it("malformed verify body → 400 SCHEMA_INVALID", async () => {
    const s = setup();
    const { userId } = await register(s);
    const { id } = await createApproval(s.ctx, cartFor(userId, s.clock.t));
    for (const body of [{}, { response: { id: "a", rawId: "b", type: "public-key", response: {} } }]) {
      expect((await request(s.app).post(`/approvals/${id}/verify`).send(body)).body).toEqual({
        error: "SCHEMA_INVALID",
      });
    }
  });

  it("createApproval refuses bad carts, unknown users and expired carts", async () => {
    const s = setup();
    const { userId } = await register(s);
    await expect(createApproval(s.ctx, { ...cartFor(userId, s.clock.t), totalMinor: 1 })).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
    await expect(createApproval(s.ctx, cartFor("usr_nobodyAAAAAAAAAAAAAAA", s.clock.t))).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
    });
    await expect(createApproval(s.ctx, cartFor(userId, s.clock.t - 600_000))).rejects.toMatchObject({
      code: "APPROVAL_EXPIRED",
    });
  });
});
