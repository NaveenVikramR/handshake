import {
  CLOCK_SKEW_S,
  SignedOffer,
  generateEd25519KeyPair,
  hash,
  randomNonce,
  signEnvelope,
  verifyOfferEnvelope,
  type OfferRequest,
} from "@handshake/core";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { startHoldExpiry } from "../src/offers/expiry.js";
import {
  MAX_HELD_UNITS_PER_AGENT,
  MAX_OPEN_OFFERS_PER_AGENT,
  MAX_QTY_PER_LINE,
  OFFER_HOLD_S,
  loadSelf,
  type OfferContext,
} from "../src/offers/service.js";
import { memoryOfferStore, type ProductRow } from "../src/offers/store.js";
import { memoryWebhookStore } from "../src/webhooks/store.js";

const T0 = 1_762_000_000_000;
const merchantKeys = generateEd25519KeyPair();
const consumerKeys = generateEd25519KeyPair();
const otherKeys = generateEd25519KeyPair();

const PRODUCTS: ProductRow[] = [
  { sku: "RICE-2KG", name: "Rice 2 kg", category: "grocery", priceMinor: 499, stock: 5 },
  { sku: "DET-1L", name: "Detergent 1 L", category: "household", priceMinor: 650, stock: 1 },
];

async function setup(opts: { consumerStatus?: string } = {}) {
  const clock = { t: T0 };
  const store = memoryOfferStore({
    merchants: [{ id: "mer_corner", name: "Corner Grocery", paypalMerchantId: "ABCD1234EFGH5", status: "active" }],
    agents: [
      {
        id: "agt_m_corner",
        role: "merchant",
        publicKey: merchantKeys.publicKey,
        status: "active",
        merchantId: "mer_corner",
      },
      {
        id: "agt_c_alice",
        role: "consumer",
        publicKey: consumerKeys.publicKey,
        status: opts.consumerStatus ?? "active",
        merchantId: null,
      },
      {
        id: "agt_m_other",
        role: "merchant",
        publicKey: otherKeys.publicKey,
        status: "active",
        merchantId: "mer_corner",
      },
    ],
    products: PRODUCTS,
  });
  const self = await loadSelf(store, "agt_m_corner", merchantKeys.privateKey);
  const ctx: OfferContext = { store, self, now: () => clock.t };
  const webhooks = {
    paypal: { verifyWebhook: async () => false },
    store: memoryWebhookStore(),
    webhookId: "WHID",
    onOrderEvent: async () => {},
    log: () => {},
  };
  return { app: createApp({ webhooks, offers: ctx, demoMode: false }), store, clock, ctx };
}

const nowS = (t: number) => Math.floor(t / 1000);

function offerRequest(patch: Partial<OfferRequest> = {}, t = T0): OfferRequest {
  return {
    v: 1,
    type: "offer_request",
    consumerAgentId: "agt_c_alice",
    merchantId: "mer_corner",
    items: [
      { sku: "RICE-2KG", qty: 2 },
      { sku: "DET-1L", qty: 1 },
    ],
    iat: nowS(t),
    exp: nowS(t) + 60,
    nonce: randomNonce(),
    ...patch,
  };
}

const sign = (p: OfferRequest, key = consumerKeys.privateKey, kid = "agt_c_alice") => signEnvelope(p, key, kid);

async function post(app: Awaited<ReturnType<typeof setup>>["app"], body: unknown) {
  return request(app)
    .post("/offers")
    .send(body as object);
}

describe("discovery", () => {
  it("serves the agent card with this merchant's registry identity", async () => {
    const { app } = await setup();
    const res = await request(app).get("/.well-known/agent.json");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      merchantId: "mer_corner",
      merchantAgentId: "agt_m_corner",
      paypalMerchantId: "ABCD1234EFGH5",
    });
    // Unsigned card: no key to verify against, so consumers must use the registry.
    expect(res.body).not.toHaveProperty("publicKey");
  });

  it("serves the catalog with DB prices and availability", async () => {
    const { app } = await setup();
    const res = await request(app).get("/catalog");
    expect(res.body.products).toEqual([
      { sku: "DET-1L", name: "Detergent 1 L", category: "household", priceMinor: 650, currency: "USD", inStock: true },
      { sku: "RICE-2KG", name: "Rice 2 kg", category: "grocery", priceMinor: 499, currency: "USD", inStock: true },
    ]);
  });
});

describe("loadSelf", () => {
  it("refuses a private key that doesn't match the registry", async () => {
    const { store } = await setup();
    await expect(loadSelf(store, "agt_m_corner", otherKeys.privateKey)).rejects.toThrow(/does not match/);
  });

  it("refuses a consumer agent id or an unknown agent", async () => {
    const { store } = await setup();
    await expect(loadSelf(store, "agt_c_alice", consumerKeys.privateKey)).rejects.toThrow(/not an active merchant/);
    await expect(loadSelf(store, "agt_m_nobody", merchantKeys.privateKey)).rejects.toThrow(/not an active merchant/);
  });
});

describe("POST /offers", () => {
  it("signs an offer priced from the DB that verifies with core, and holds the stock", async () => {
    const { app, store, ctx } = await setup();
    const res = await post(app, sign(offerRequest()));
    expect(res.status).toBe(201);
    const offer = SignedOffer.parse(res.body.offer);
    verifyOfferEnvelope(offer, { id: "agt_m_corner", publicKey: merchantKeys.publicKey }, nowS(T0) + 1);
    expect(offer.payload).toMatchObject({
      merchantId: "mer_corner",
      paypalMerchantId: "ABCD1234EFGH5",
      items: [
        { sku: "RICE-2KG", name: "Rice 2 kg", qty: 2, unitMinor: 499 },
        { sku: "DET-1L", name: "Detergent 1 L", qty: 1, unitMinor: 650 },
      ],
      totalMinor: 1648,
      holdUntil: nowS(T0) + OFFER_HOLD_S,
    });
    expect(res.body.offerHash).toBe(hash(offer.payload));
    expect(store.products.get("RICE-2KG")?.stock).toBe(3);
    expect(store.products.get("DET-1L")?.stock).toBe(0);
    expect(ctx.self.merchantId).toBe("mer_corner");
  });

  it("a tampered offer (price lowered) no longer verifies", async () => {
    const { app } = await setup();
    const offer = SignedOffer.parse((await post(app, sign(offerRequest()))).body.offer);
    const items = offer.payload.items.map((i) => ({ ...i, unitMinor: 1 }));
    const tampered = { ...offer, payload: { ...offer.payload, items, totalMinor: 3 } };
    expect(() =>
      verifyOfferEnvelope(tampered, { id: "agt_m_corner", publicKey: merchantKeys.publicKey }, nowS(T0) + 1),
    ).toThrow(expect.objectContaining({ code: "OFFER_SIG_INVALID" }));
  });

  it.each<[string, () => unknown, number, string]>([
    ["unsigned body", () => offerRequest(), 400, "SCHEMA_INVALID"],
    [
      "client-supplied price",
      () => sign({ ...offerRequest(), items: [{ sku: "RICE-2KG", qty: 1, unitMinor: 1 }] } as unknown as OfferRequest),
      400,
      "SCHEMA_INVALID",
    ],
    [
      "unknown agent",
      () => sign(offerRequest({ consumerAgentId: "agt_c_mallory" }), otherKeys.privateKey, "agt_c_mallory"),
      401,
      "AGENT_UNTRUSTED",
    ],
    [
      "a merchant agent asking",
      () => sign(offerRequest({ consumerAgentId: "agt_c_alice" }), otherKeys.privateKey, "agt_m_other"),
      400,
      "SCHEMA_INVALID",
    ],
    ["signed by another key", () => sign(offerRequest(), otherKeys.privateKey), 401, "AGENT_SIG_INVALID"],
    ["addressed to another merchant", () => sign(offerRequest({ merchantId: "mer_other" })), 401, "AGENT_SIG_INVALID"],
    ["stale request", () => sign(offerRequest({}, T0 - (120 + CLOCK_SKEW_S + 1) * 1000)), 401, "AGENT_SIG_INVALID"],
    ["unknown sku", () => sign(offerRequest({ items: [{ sku: "GOLD-1KG", qty: 1 }] })), 400, "SCHEMA_INVALID"],
    ["more than in stock", () => sign(offerRequest({ items: [{ sku: "RICE-2KG", qty: 6 }] })), 409, "OUT_OF_STOCK"],
  ])("%s → %s", async (_n, body, status, code) => {
    const { app, store } = await setup();
    const res = await post(app, body());
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: code });
    expect(store.offers.size).toBe(0);
    expect(store.products.get("RICE-2KG")?.stock).toBe(5);
  });

  it("a suspended consumer agent → AGENT_UNTRUSTED", async () => {
    const { app } = await setup({ consumerStatus: "suspended" });
    expect((await post(app, sign(offerRequest()))).body).toEqual({ error: "AGENT_UNTRUSTED" });
  });

  it("a replayed offer request → APPROVAL_REPLAY and holds nothing more", async () => {
    const { app, store } = await setup();
    const body = sign(offerRequest({ items: [{ sku: "RICE-2KG", qty: 1 }] }));
    expect((await post(app, body)).status).toBe(201);
    const res = await post(app, body);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "APPROVAL_REPLAY" });
    expect(store.products.get("RICE-2KG")?.stock).toBe(4);
  });

  it("partial stock failure rolls back every line", async () => {
    const { app, store } = await setup();
    const body = sign(
      offerRequest({
        items: [
          { sku: "RICE-2KG", qty: 1 },
          { sku: "DET-1L", qty: 2 },
        ],
      }),
    );
    expect((await post(app, body)).body).toEqual({ error: "OUT_OF_STOCK" });
    expect(store.products.get("RICE-2KG")?.stock).toBe(5);
  });

  it(`qty above ${MAX_QTY_PER_LINE} on a line → SCHEMA_INVALID`, async () => {
    const { app, store } = await setup();
    store.products.get("RICE-2KG")!.stock = 1000;
    const res = await post(app, sign(offerRequest({ items: [{ sku: "RICE-2KG", qty: MAX_QTY_PER_LINE + 1 }] })));
    expect(res.body).toEqual({ error: "SCHEMA_INVALID" });
  });

  it(`caps units held per agent at ${MAX_HELD_UNITS_PER_AGENT} → RATE_LIMITED`, async () => {
    const { app, store } = await setup();
    store.products.get("RICE-2KG")!.stock = 1000;
    const full = () => sign(offerRequest({ items: [{ sku: "RICE-2KG", qty: MAX_QTY_PER_LINE }] }));
    for (let i = 0; i < MAX_HELD_UNITS_PER_AGENT / MAX_QTY_PER_LINE; i++) {
      expect((await post(app, full())).status).toBe(201);
    }
    const res = await post(app, sign(offerRequest({ items: [{ sku: "RICE-2KG", qty: 1 }] })));
    expect(res.body).toEqual({ error: "RATE_LIMITED" });
    expect(store.products.get("RICE-2KG")?.stock).toBe(1000 - MAX_HELD_UNITS_PER_AGENT);
  });

  it(`caps open offers per agent at ${MAX_OPEN_OFFERS_PER_AGENT} → RATE_LIMITED`, async () => {
    const { app, store } = await setup();
    store.products.get("RICE-2KG")!.stock = 1000;
    const one = () => sign(offerRequest({ items: [{ sku: "RICE-2KG", qty: 1 }] }));
    for (let i = 0; i < MAX_OPEN_OFFERS_PER_AGENT; i++) expect((await post(app, one())).status).toBe(201);
    const res = await post(app, one());
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "RATE_LIMITED" });
  });

  it("rejects malformed JSON without a stack", async () => {
    const { app } = await setup();
    const res = await request(app).post("/offers").set("content-type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "SCHEMA_INVALID" });
  });
});

describe("hold expiry", () => {
  it("returns stock once the hold has passed, exactly once", async () => {
    const { app, store, clock } = await setup();
    await post(app, sign(offerRequest()));
    expect(await store.releaseExpired(clock.t + OFFER_HOLD_S * 1000)).toBe(0); // at holdUntil: still held
    const later = clock.t + (OFFER_HOLD_S + 1) * 1000;
    expect(await store.releaseExpired(later)).toBe(1);
    expect(await store.releaseExpired(later)).toBe(0);
    expect(store.products.get("RICE-2KG")?.stock).toBe(5);
    expect(store.products.get("DET-1L")?.stock).toBe(1);
    expect([...store.offers.values()][0]?.status).toBe("expired");
  });

  it("an expired offer no longer counts toward the per-agent cap", async () => {
    const { app, store, clock } = await setup();
    store.products.get("RICE-2KG")!.stock = 1000;
    const one = () => sign(offerRequest({ items: [{ sku: "RICE-2KG", qty: 1 }] }, clock.t));
    for (let i = 0; i < MAX_OPEN_OFFERS_PER_AGENT; i++) await post(app, one());
    clock.t += (OFFER_HOLD_S + 1) * 1000;
    expect((await post(app, one())).status).toBe(201);
  });

  it("the job runs releaseExpired on its interval and logs failures without detail", async () => {
    const calls: number[] = [];
    const logs: string[] = [];
    let fail = false;
    const store = {
      ...memoryOfferStore({}),
      releaseExpired: async (now: number) => {
        calls.push(now);
        if (fail) throw new Error("db down: secret detail");
        return 0;
      },
    };
    const stop = startHoldExpiry(store, () => 42, { intervalMs: 5, log: (m) => logs.push(m) });
    await new Promise((r) => setTimeout(r, 30));
    fail = true;
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((t) => t === 42)).toBe(true);
    expect(logs.some((l) => l === "hold expiry failed: Error")).toBe(true);
    expect(logs.join()).not.toContain("secret");
  });
});
