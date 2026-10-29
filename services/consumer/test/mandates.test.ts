import { IntentMandate, hash, shipToHash } from "@handshake/core";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { FakeAuthenticator, type AssertOptions } from "../../../packages/core/test/fake-authenticator.js";
import { createApp } from "../src/app.js";
import type { AppContext } from "../src/context.js";
import { memoryWalletStore } from "../src/store.js";

const webauthn = { rpId: "wallet.handshake.test", rpName: "Handshake", origin: "https://wallet.handshake.test" };
const T0 = 1_762_000_000_000;
const shipTo = { name: "Alice", line1: "1 Main St", city: "Springfield", postalCode: "12345", country: "US" };

function setup() {
  const clock = { t: T0 };
  const store = memoryWalletStore({
    merchants: [
      { id: "mer_corner", name: "Corner Grocery", paypalMerchantId: "PPCORNER1", status: "active" },
      { id: "mer_bakery", name: "Bakery", paypalMerchantId: "PPBAKERY1", status: "active" },
      { id: "mer_gone", name: "Suspended Shop", paypalMerchantId: "PPGONE1", status: "suspended" },
    ],
  });
  const ctx: AppContext = { store, webauthn, consumerAgentId: "agt_c_wallet", now: () => clock.t };
  return { ctx, app: createApp(ctx), clock };
}
type Setup = ReturnType<typeof setup>;

async function register(s: Setup) {
  const auth = new FakeAuthenticator(webauthn.rpId, webauthn.origin);
  const { body } = await request(s.app).post("/passkeys/register/options").send({ displayName: "Alice" });
  const res = await request(s.app)
    .post("/passkeys/register/verify")
    .send({ userId: body.userId, response: auth.register(body.options.challenge) });
  expect(res.status).toBe(200);
  return { userId: body.userId as string, auth };
}

const request_ = (userId: string, patch: object = {}) => ({
  userId,
  merchants: ["mer_corner"],
  categories: ["grocery"],
  perOrderMinor: 3000,
  periodMinor: 8000,
  period: "week",
  shipTo,
  days: 7,
  ...patch,
});

async function options(s: Setup, userId: string, patch: object = {}) {
  return request(s.app).post("/mandates/options").send(request_(userId, patch));
}

async function approve(
  s: Setup,
  mandateId: string,
  challenge: string,
  auth: FakeAuthenticator,
  opts: AssertOptions = {},
) {
  return request(s.app)
    .post("/mandates/verify")
    .send({ mandateId, response: auth.assertJSON(challenge, opts) });
}

describe("POST /mandates/options", () => {
  it("builds the mandate server-side and returns options whose challenge is hash(mandate)", async () => {
    const s = setup();
    const { userId, auth } = await register(s);
    const res = await options(s, userId);
    expect(res.status).toBe(200);
    const mandate = IntentMandate.parse(res.body.mandate);
    expect(mandate).toMatchObject({
      userId,
      consumerAgentId: "agt_c_wallet",
      scope: { merchants: ["mer_corner"], categories: ["grocery"] },
      limits: { perOrderMinor: 3000, periodMinor: 8000, period: "week" },
      shipToHash: shipToHash(shipTo),
      iat: T0 / 1000,
      exp: T0 / 1000 + 7 * 86400,
    });
    expect(res.body.mandateId).toBe(mandate.mandateId);
    expect(res.body.options.challenge).toBe(hash(mandate));
    expect(res.body.options.userVerification).toBe("required");
    expect(res.body.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([auth.credentialId]);
    expect((await s.ctx.store.getMandate(mandate.mandateId))?.status).toBe("pending");
  });

  it("ignores any client attempt to set agent, ids, nonce or times (strict body)", async () => {
    const s = setup();
    const { userId } = await register(s);
    for (const extra of [
      { consumerAgentId: "agt_c_evil" },
      { mandateId: "man_x" },
      { exp: 9_999_999_999 },
      { nonce: "x" },
    ]) {
      expect((await options(s, userId, extra)).body).toEqual({ error: "SCHEMA_INVALID" });
    }
  });

  it.each([
    ["perOrder above period", { perOrderMinor: 9000 }],
    ["non-integer amount", { perOrderMinor: 30.5 }],
    ["lifetime over 30 days", { days: 31 }],
    ["unknown period", { period: "year" }],
    ["bad merchant id", { merchants: ["corner"] }],
    ["bad address", { shipTo: { line1: "1 Main St" } }],
  ])("400 SCHEMA_INVALID on %s", async (_n, patch) => {
    const s = setup();
    const { userId } = await register(s);
    const res = await options(s, userId, patch);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "SCHEMA_INVALID" });
  });

  it("returns the registry names of the merchants in scope", async () => {
    const s = setup();
    const { userId } = await register(s);
    const res = await options(s, userId, { merchants: ["mer_bakery", "mer_corner"] });
    expect(res.body.merchants).toEqual([
      { id: "mer_bakery", name: "Bakery" },
      { id: "mer_corner", name: "Corner Grocery" },
    ]);
  });

  it.each([
    ["unknown merchant", ["mer_corner", "mer_nobody"]],
    ["suspended merchant", ["mer_gone"]],
  ])("%s → 401 MERCHANT_UNTRUSTED", async (_n, merchants) => {
    const s = setup();
    const { userId } = await register(s);
    const res = await options(s, userId, { merchants });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "MERCHANT_UNTRUSTED" });
  });

  it("refuses a user without a passkey", async () => {
    const s = setup();
    const res = await options(s, "usr_nobody");
    expect(res.body).toEqual({ error: "MANDATE_INVALID" });
  });
});

describe("POST /mandates/verify", () => {
  async function pending(s: Setup) {
    const r = await register(s);
    const res = await options(s, r.userId);
    return {
      ...r,
      mandateId: res.body.mandateId as string,
      challenge: res.body.options.challenge as string,
      mandate: res.body.mandate,
    };
  }

  it("activates the mandate with a UV passkey and stores the assertion", async () => {
    const s = setup();
    const p = await pending(s);
    const res = await approve(s, p.mandateId, p.challenge, p.auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mandateId: p.mandateId, status: "active" });
    const stored = await s.ctx.store.getMandate(p.mandateId);
    expect(stored?.status).toBe("active");
    expect(stored?.assertion?.credentialId).toBe(p.auth.credentialId);
    expect((await s.ctx.store.getCredential(p.auth.credentialId))?.signCount).toBe(1);
  });

  it("UV missing → MANDATE_INVALID, stays pending", async () => {
    const s = setup();
    const p = await pending(s);
    expect((await approve(s, p.mandateId, p.challenge, p.auth, { uv: false })).body).toEqual({
      error: "MANDATE_INVALID",
    });
    expect((await s.ctx.store.getMandate(p.mandateId))?.status).toBe("pending");
  });

  it("assertion over a different mandate (limits raised) → MANDATE_INVALID", async () => {
    const s = setup();
    const p = await pending(s);
    const raised = hash({ ...p.mandate, limits: { ...p.mandate.limits, periodMinor: 80000 } });
    expect((await approve(s, p.mandateId, raised, p.auth)).body).toEqual({ error: "MANDATE_INVALID" });
  });

  it("wrong origin → MANDATE_INVALID", async () => {
    const s = setup();
    const p = await pending(s);
    expect((await approve(s, p.mandateId, p.challenge, p.auth, { origin: "https://evil.example" })).body).toEqual({
      error: "MANDATE_INVALID",
    });
  });

  it("another user's passkey → MANDATE_INVALID", async () => {
    const s = setup();
    const alice = await pending(s);
    const bob = await register(s);
    expect((await approve(s, alice.mandateId, alice.challenge, bob.auth)).body).toEqual({ error: "MANDATE_INVALID" });
  });

  it("replay → 409 APPROVAL_REPLAY", async () => {
    const s = setup();
    const p = await pending(s);
    const body = { mandateId: p.mandateId, response: p.auth.assertJSON(p.challenge) };
    expect((await request(s.app).post("/mandates/verify").send(body)).status).toBe(200);
    const again = await request(s.app).post("/mandates/verify").send(body);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "APPROVAL_REPLAY" });
  });

  it("approval window (5 min) passed → APPROVAL_EXPIRED", async () => {
    const s = setup();
    const p = await pending(s);
    s.clock.t += 5 * 60_000 + 1;
    expect((await approve(s, p.mandateId, p.challenge, p.auth)).body).toEqual({ error: "APPROVAL_EXPIRED" });
  });

  it("unknown mandate → MANDATE_INVALID; malformed body → SCHEMA_INVALID", async () => {
    const s = setup();
    const p = await pending(s);
    expect((await approve(s, "man_AAAAAAAAAAAAAAAAAAAAAA", p.challenge, p.auth)).body).toEqual({
      error: "MANDATE_INVALID",
    });
    expect((await request(s.app).post("/mandates/verify").send({ mandateId: p.mandateId })).body).toEqual({
      error: "SCHEMA_INVALID",
    });
  });
});
