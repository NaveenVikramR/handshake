// End to end through the real route and the real PayPal client, with PayPal's HTTP mocked.
// The fixture follows the documented PAYMENT.CAPTURE.COMPLETED envelope (docs/PAYPAL.md § Webhooks);
// its capture/authorization ids come from the 2026-10-29 sandbox smoke run. Transmission headers are samples.
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { PAYPAL_SANDBOX_BASE_URL, createPayPalClient } from "../src/paypal/client.js";
import type { MappedOrderEvent } from "../src/webhooks/events.js";
import { memoryWebhookStore } from "../src/webhooks/store.js";

const captureCompleted = readFileSync(new URL("./fixtures/paypal-capture-completed.json", import.meta.url), "utf8");
const SECRET = "demo-secret-0123456789";

const transmission: Record<string, string> = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "paypal-transmission-sig": "bWlja2Vk-c2lnbmF0dXJl",
  "paypal-transmission-time": "2026-10-29T10:15:28Z",
};

/**
 * PayPal mocked at the HTTP layer. Like the real service, verify answers SUCCESS only for
 * event bytes that were "signed" (`signed`), and only when `status` is SUCCESS.
 */
function paypalHttp(status: "SUCCESS" | "FAILURE", signed: string[]) {
  const verifyBodies: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
      const body = init?.body as string;
      verifyBodies.push(body);
      const marker = '"webhook_event":';
      const eventBytes = body.slice(body.indexOf(marker) + marker.length, -1);
      const result = status === "SUCCESS" && signed.includes(eventBytes) ? "SUCCESS" : "FAILURE";
      return new Response(JSON.stringify({ verification_status: result }), { status: 200 });
    }
    throw new Error(`unexpected PayPal call ${url}`);
  }) as typeof globalThis.fetch;
  const paypal = createPayPalClient({ baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: "c", clientSecret: "s", fetch });
  return { paypal, verifyBodies };
}

function setup(status: "SUCCESS" | "FAILURE", opts: { demoMode?: boolean; signed?: string[] } = {}) {
  const { paypal, verifyBodies } = paypalHttp(status, opts.signed ?? [captureCompleted]);
  const store = memoryWebhookStore();
  const applied: { event: MappedOrderEvent; simulated: boolean }[] = [];
  const server = createApp({
    webhooks: {
      paypal,
      store,
      webhookId: "WHID-SANDBOX",
      onOrderEvent: async (event, _raw, _tx, meta) => {
        applied.push({ event, simulated: meta.simulated });
      },
      log: () => {},
    },
    demoMode: opts.demoMode ?? false,
    ...(opts.demoMode ? { demoSecret: SECRET } : {}),
  });
  return { server, store, applied, verifyBodies };
}

const deliver = (server: ReturnType<typeof createApp>, body: string, headers = transmission) =>
  request(server).post("/webhooks/paypal").set(headers).set("Content-Type", "application/json").send(body);

describe("PayPal webhook end to end (mocked PayPal HTTP)", () => {
  it("valid event: verified with the raw bytes, stored once, applied as captured", async () => {
    const { server, store, applied, verifyBodies } = setup("SUCCESS");
    const res = await deliver(server, captureCompleted);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: "processed" });
    expect(verifyBodies).toHaveLength(1);
    expect(JSON.parse(verifyBodies[0]!)).toMatchObject({
      webhook_id: "WHID-SANDBOX",
      transmission_id: transmission["paypal-transmission-id"],
    });
    expect(verifyBodies[0]).toContain(`"webhook_event":${captureCompleted}}`);
    expect(store.events.map((e) => e.eventId)).toEqual(["WH-58D329510W468432D-8HN650336L201105X"]);
    expect(applied).toEqual([
      { event: { ref: { kind: "capture", id: "5D1521094W662190B" }, to: "captured" }, simulated: false },
    ]);
  });

  it("bad signature: PayPal says FAILURE → 400, nothing stored or applied", async () => {
    const { server, store, applied, verifyBodies } = setup("FAILURE");
    const res = await deliver(server, captureCompleted);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ outcome: "forged" });
    expect(verifyBodies).toHaveLength(1);
    expect(store.events).toHaveLength(0);
    expect(applied).toHaveLength(0);
  });

  it("body altered after signing (amount changed): 400, nothing stored or applied", async () => {
    const { server, store, applied, verifyBodies } = setup("SUCCESS");
    const tampered = captureCompleted.replace('"value": "13.48"', '"value": "1348.00"');
    expect(tampered).not.toBe(captureCompleted);
    const res = await deliver(server, tampered);
    expect(res.status).toBe(400);
    expect(verifyBodies).toHaveLength(1);
    expect(store.events).toHaveLength(0);
    expect(applied).toHaveLength(0);
  });

  it("missing transmission headers: rejected without asking PayPal", async () => {
    const { server, store, applied, verifyBodies } = setup("SUCCESS");
    const res = await deliver(server, captureCompleted, {});
    expect(res.status).toBe(400);
    expect(verifyBodies).toHaveLength(0);
    expect(store.events).toHaveLength(0);
    expect(applied).toHaveLength(0);
  });

  it("duplicate event id: second delivery is 200 duplicate, stored and applied once", async () => {
    const { server, store, applied } = setup("SUCCESS");
    await deliver(server, captureCompleted);
    const again = await deliver(server, captureCompleted);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ outcome: "duplicate" });
    expect(store.events).toHaveLength(1);
    expect(applied).toHaveLength(1);
  });

  it("unknown event type: 200 ignored, recorded, state machine untouched", async () => {
    const unknown = JSON.stringify({
      ...JSON.parse(captureCompleted),
      id: "WH-UNKNOWN-1",
      event_type: "CUSTOMER.DISPUTE.CREATED",
    });
    const { server, store, applied } = setup("SUCCESS", { signed: [unknown] });
    const res = await deliver(server, unknown);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: "ignored" });
    expect(store.events.map((e) => e.eventId)).toEqual(["WH-UNKNOWN-1"]);
    expect(applied).toHaveLength(0);
  });

  describe("DEMO_MODE simulator", () => {
    const sim = { event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "5D1521094W662190B" } };

    it("is not mounted when DEMO_MODE is off, even with the secret", async () => {
      const { server, store } = setup("SUCCESS", { demoMode: false });
      const res = await request(server).post("/webhooks/paypal/simulate").set("x-demo-secret", SECRET).send(sim);
      expect(res.status).toBe(404);
      expect(store.events).toHaveLength(0);
    });

    it("refuses requests without DEMO_SECRET", async () => {
      const { server, store } = setup("SUCCESS", { demoMode: true });
      const res = await request(server).post("/webhooks/paypal/simulate").send(sim);
      expect(res.status).toBe(401);
      expect(store.events).toHaveLength(0);
    });

    it("accepts with DEMO_SECRET, skips PayPal verify and tags the event simulated", async () => {
      const { server, applied, verifyBodies } = setup("FAILURE", { demoMode: true });
      const res = await request(server).post("/webhooks/paypal/simulate").set("x-demo-secret", SECRET).send(sim);
      expect(res.status).toBe(200);
      expect(verifyBodies).toHaveLength(0);
      expect(applied.map((a) => a.simulated)).toEqual([true]);
    });
  });
});
