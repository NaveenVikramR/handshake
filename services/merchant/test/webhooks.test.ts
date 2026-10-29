import { HandshakeError } from "@handshake/core";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { InvalidTransitionError } from "../src/orders/state.js";
import { orderEventFor, type WebhookEvent } from "../src/webhooks/events.js";
import { handlePayPalWebhook, type WebhookDeps } from "../src/webhooks/handler.js";
import { memoryWebhookStore } from "../src/webhooks/store.js";

const event = (id: string, event_type: string, resourceId = "RES-1") =>
  JSON.stringify({ id, event_type, resource_type: "capture", resource: { id: resourceId, status: "COMPLETED" } });

function setup(verify: boolean | "throw" = true, opts: { failApply?: boolean | "conflict" } = {}) {
  const store = memoryWebhookStore();
  const applied: { to: string; ref: unknown; simulated: boolean }[] = [];
  const verifyCalls: string[] = [];
  const deps: WebhookDeps<undefined> = {
    paypal: {
      verifyWebhook: async ({ rawBody }) => {
        verifyCalls.push(rawBody);
        if (verify === "throw") throw new HandshakeError("PAYPAL_ERROR", "down");
        return verify;
      },
    },
    store,
    webhookId: "WHID",
    onOrderEvent: async (e, _raw, _tx, meta) => {
      if (opts.failApply === "conflict") throw new InvalidTransitionError("voided", { to: e.to, source: "webhook" });
      if (opts.failApply) throw new Error("db down");
      applied.push({ to: e.to, ref: e.ref, simulated: meta.simulated });
    },
    log: () => {},
  };
  return { deps, store, applied, verifyCalls };
}

const req = (rawBody: string) => ({ headers: {}, rawBody });
const SECRET = "demo-secret-0123456789";

describe("handlePayPalWebhook", () => {
  it("verifies, records and applies a genuine event", async () => {
    const { deps, store, applied } = setup();
    const r = await handlePayPalWebhook(deps, req(event("WH-1", "PAYMENT.CAPTURE.COMPLETED", "CAP-1")));
    expect(r).toEqual({ httpStatus: 200, outcome: "processed" });
    expect(store.events.map((e) => e.eventId)).toEqual(["WH-1"]);
    expect(applied).toEqual([{ to: "captured", ref: { kind: "capture", id: "CAP-1" }, simulated: false }]);
  });

  it("rejects a forged event before recording or applying anything", async () => {
    const { deps, store, applied } = setup(false);
    const r = await handlePayPalWebhook(deps, req(event("WH-1", "PAYMENT.CAPTURE.COMPLETED")));
    expect(r).toEqual({ httpStatus: 400, outcome: "forged" });
    expect(store.events).toHaveLength(0);
    expect(applied).toHaveLength(0);
  });

  it("returns 503 (PayPal redelivers) when verification is unavailable", async () => {
    const { deps, store } = setup("throw");
    const r = await handlePayPalWebhook(deps, req(event("WH-1", "PAYMENT.CAPTURE.COMPLETED")));
    expect(r).toEqual({ httpStatus: 503, outcome: "verify_unavailable" });
    expect(store.events).toHaveLength(0);
  });

  it("dedupes by event id: second delivery is 200 and applied once", async () => {
    const { deps, applied } = setup();
    const body = event("WH-1", "PAYMENT.CAPTURE.COMPLETED");
    expect((await handlePayPalWebhook(deps, req(body))).outcome).toBe("processed");
    expect(await handlePayPalWebhook(deps, req(body))).toEqual({ httpStatus: 200, outcome: "duplicate" });
    expect(applied).toHaveLength(1);
  });

  it("dedupes even when the duplicate's payload differs", async () => {
    const { deps, applied } = setup();
    await handlePayPalWebhook(deps, req(event("WH-1", "PAYMENT.CAPTURE.COMPLETED")));
    const r = await handlePayPalWebhook(deps, req(event("WH-1", "PAYMENT.CAPTURE.REFUNDED")));
    expect(r.outcome).toBe("duplicate");
    expect(applied.map((a) => a.to)).toEqual(["captured"]);
  });

  it("records unhandled event types without applying them", async () => {
    const { deps, store, applied } = setup();
    const r = await handlePayPalWebhook(deps, req(event("WH-2", "CHECKOUT.ORDER.APPROVED")));
    expect(r).toEqual({ httpStatus: 200, outcome: "ignored" });
    expect(store.events).toHaveLength(1);
    expect(applied).toHaveLength(0);
  });

  it("rejects a verified but malformed event", async () => {
    const { deps, store } = setup();
    for (const bad of [
      "not json",
      JSON.stringify({ id: "WH-3", event_type: "X" }),
      JSON.stringify({ event_type: "X", resource: { id: "r" } }),
    ]) {
      expect(await handlePayPalWebhook(deps, req(bad))).toEqual({ httpStatus: 400, outcome: "malformed" });
    }
    expect(store.events).toHaveLength(0);
  });

  it("rolls back on apply failure so the redelivery is processed, not deduped", async () => {
    const failing = setup(true, { failApply: true });
    const body = event("WH-4", "PAYMENT.AUTHORIZATION.VOIDED");
    expect(await handlePayPalWebhook(failing.deps, req(body))).toEqual({ httpStatus: 500, outcome: "apply_failed" });
    expect(failing.store.events).toHaveLength(0);

    const healthy = { ...failing.deps, onOrderEvent: async () => {} };
    expect((await handlePayPalWebhook(healthy, req(body))).outcome).toBe("processed");
    expect(failing.store.events).toHaveLength(1);
  });
});

describe("state conflicts", () => {
  it("records the event, alerts and returns 200 so PayPal stops redelivering", async () => {
    const { deps, store } = setup(true, { failApply: "conflict" });
    const logs: string[] = [];
    const body = event("WH-5", "PAYMENT.CAPTURE.COMPLETED");
    const r = await handlePayPalWebhook({ ...deps, log: (m) => logs.push(m) }, req(body));
    expect(r).toEqual({ httpStatus: 200, outcome: "conflict" });
    expect(store.events.map((e) => e.eventId)).toEqual(["WH-5"]);
    expect(logs.some((m) => m.includes("RECONCILE"))).toBe(true);
    expect((await handlePayPalWebhook(deps, req(body))).outcome).toBe("duplicate");
  });
});

describe("orderEventFor", () => {
  const ev = (event_type: string): WebhookEvent => ({ id: "WH", event_type, resource: { id: "R" } });
  it.each([
    ["PAYMENT.AUTHORIZATION.CREATED", "authorization", "authorized"],
    ["PAYMENT.AUTHORIZATION.VOIDED", "authorization", "voided"],
    ["PAYMENT.CAPTURE.COMPLETED", "capture", "captured"],
    ["PAYMENT.CAPTURE.DECLINED", "capture", "failed"],
    ["PAYMENT.CAPTURE.DENIED", "capture", "failed"],
    ["PAYMENT.CAPTURE.REFUNDED", "refund", "refunded"],
  ])("maps %s → %s %s", (type, kind, to) => {
    expect(orderEventFor(ev(type))).toEqual({ ref: { kind, id: "R" }, to });
  });

  it.each(["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.REVERSED", "SOMETHING.ELSE"])(
    "does not move the state machine for %s",
    (type) => {
      expect(orderEventFor(ev(type))).toBeUndefined();
    },
  );
});

describe("webhook routes", () => {
  it("passes the raw body bytes to verification", async () => {
    const { deps, verifyCalls } = setup();
    const raw = '{ "id":"WH-9",   "event_type":"CHECKOUT.ORDER.APPROVED", "resource":{"id":"O-1"} }';
    const app = createApp({ webhooks: deps, demoMode: false });
    const res = await request(app).post("/webhooks/paypal").set("Content-Type", "application/json").send(raw);
    expect(res.status).toBe(200);
    expect(verifyCalls).toEqual([raw]);
  });

  it("returns 400 for a forged delivery", async () => {
    const { deps } = setup(false);
    const app = createApp({ webhooks: deps, demoMode: false });
    const res = await request(app)
      .post("/webhooks/paypal")
      .set("Content-Type", "application/json")
      .send(event("WH-1", "PAYMENT.CAPTURE.COMPLETED"));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ outcome: "forged" });
  });

  it("does not mount the simulator unless DEMO_MODE", async () => {
    const { deps, store } = setup();
    const app = createApp({ webhooks: deps, demoMode: false });
    const res = await request(app)
      .post("/webhooks/paypal/simulate")
      .set("x-demo-secret", SECRET)
      .send({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } });
    expect(res.status).toBe(404);
    expect(store.events).toHaveLength(0);
  });

  it("DEMO_MODE simulator skips signature verification but still dedupes", async () => {
    const { deps, verifyCalls, applied } = setup(false);
    const app = createApp({ webhooks: deps, demoMode: true, demoSecret: SECRET });
    const body = { id: "WH-SIM-demo1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } };
    const first = await request(app).post("/webhooks/paypal/simulate").set("x-demo-secret", SECRET).send(body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ outcome: "processed", eventId: "WH-SIM-demo1" });
    const again = await request(app).post("/webhooks/paypal/simulate").set("x-demo-secret", SECRET).send(body);
    expect(again.body.outcome).toBe("duplicate");
    expect(verifyCalls).toHaveLength(0);
    expect(applied).toHaveLength(1);
  });

  it("DEMO_MODE simulator refuses ids that could collide with real PayPal events", async () => {
    const { deps } = setup();
    const app = createApp({ webhooks: deps, demoMode: true, demoSecret: SECRET });
    const res = await request(app)
      .post("/webhooks/paypal/simulate")
      .set("x-demo-secret", SECRET)
      .send({ id: "WH-1AB23456CD789012E", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } });
    expect(res.status).toBe(400);
  });

  it("DEMO_MODE simulator requires the shared secret", async () => {
    const { deps, store } = setup();
    const app = createApp({ webhooks: deps, demoMode: true, demoSecret: SECRET });
    const body = { event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } };
    expect((await request(app).post("/webhooks/paypal/simulate").send(body)).status).toBe(401);
    const wrong = await request(app).post("/webhooks/paypal/simulate").set("x-demo-secret", `${SECRET}x`).send(body);
    expect(wrong.status).toBe(401);
    expect(store.events).toHaveLength(0);
  });

  it("DEMO_MODE refuses to start without a strong secret", () => {
    const { deps } = setup();
    expect(() => createApp({ webhooks: deps, demoMode: true })).toThrow(/DEMO_SECRET/);
    expect(() => createApp({ webhooks: deps, demoMode: true, demoSecret: "short" })).toThrow(/DEMO_SECRET/);
  });

  it("tags simulated events so M7 can refuse to fulfil on them", async () => {
    const { deps, applied } = setup();
    const app = createApp({ webhooks: deps, demoMode: true, demoSecret: SECRET });
    await request(app)
      .post("/webhooks/paypal/simulate")
      .set("x-demo-secret", SECRET)
      .send({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } });
    expect(applied.map((a) => a.simulated)).toEqual([true]);
  });
});
