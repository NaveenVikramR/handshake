import { describe, expect, it } from "vitest";
import { PAYPAL_SANDBOX_BASE_URL, createPayPalClient, type PayPalWebhook } from "../src/paypal/client.js";
import { WEBHOOK_EVENT_TYPES, ensureWebhook, webhookUrlFor } from "../src/paypal/webhook-setup.js";

const URL_ = "https://handshake-merchant.onrender.com/webhooks/paypal";

function fakePayPal(existing: PayPalWebhook[]) {
  const created: { url: string; events: string[]; requestId: string }[] = [];
  return {
    created,
    listWebhooks: async () => existing,
    createWebhook: async (url: string, events: string[], requestId: string) => {
      created.push({ url, events, requestId });
      return { id: "WH-NEW", url, event_types: events.map((name) => ({ name })) };
    },
  };
}

describe("webhookUrlFor", () => {
  it("appends the webhook path to the origin", () => {
    expect(webhookUrlFor("https://handshake-merchant.onrender.com/")).toBe(URL_);
    expect(webhookUrlFor("https://handshake-merchant.onrender.com/anything?x=1")).toBe(URL_);
  });

  it.each([
    "http://handshake-merchant.onrender.com",
    "https://localhost:4001",
    "https://<my-merchant-host>",
    "",
    "nope",
  ])("rejects %j", (u) => {
    expect(() => webhookUrlFor(u)).toThrow();
  });
});

describe("ensureWebhook", () => {
  it("returns the existing webhook for the url without creating one", async () => {
    const pp = fakePayPal([
      { id: "WH-OTHER", url: "https://elsewhere.example/webhooks/paypal" },
      { id: "WH-1", url: URL_, event_types: WEBHOOK_EVENT_TYPES.map((name) => ({ name })) },
    ]);
    expect(await ensureWebhook(pp, URL_)).toMatchObject({ webhook: { id: "WH-1" }, created: false, missing: [] });
    expect(pp.created).toHaveLength(0);
  });

  it("reports events an existing webhook lacks", async () => {
    const pp = fakePayPal([{ id: "WH-1", url: URL_, event_types: [{ name: "PAYMENT.CAPTURE.COMPLETED" }] }]);
    const r = await ensureWebhook(pp, URL_);
    expect(r.missing).toContain("PAYMENT.CAPTURE.REFUNDED");
    expect(r.missing).not.toContain("PAYMENT.CAPTURE.COMPLETED");
  });

  it("creates one with every handled event and a request id stable across runs", async () => {
    const a = fakePayPal([]);
    const b = fakePayPal([]);
    expect(await ensureWebhook(a, URL_)).toMatchObject({ webhook: { id: "WH-NEW" }, created: true });
    await ensureWebhook(b, URL_);
    expect(a.created[0]?.events).toEqual(WEBHOOK_EVENT_TYPES);
    expect(a.created[0]?.requestId).toBe(b.created[0]?.requestId);
  });
});

describe("PayPal client webhook calls", () => {
  function client(replies: { status: number; body: unknown }[]) {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const queue = [{ status: 200, body: { access_token: "tok", token_type: "Bearer", expires_in: 3600 } }, ...replies];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      const r = queue.shift();
      if (!r) throw new Error("unexpected request");
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as typeof globalThis.fetch;
    const paypal = createPayPalClient({ baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: "c", clientSecret: "s", fetch });
    return { paypal, calls };
  }

  it("lists webhooks with a GET", async () => {
    const { paypal, calls } = client([{ status: 200, body: { webhooks: [{ id: "WH-1", url: URL_ }] } }]);
    expect(await paypal.listWebhooks()).toEqual([{ id: "WH-1", url: URL_ }]);
    expect(calls[1]).toMatchObject({ method: "GET", url: `${PAYPAL_SANDBOX_BASE_URL}/v1/notifications/webhooks` });
  });

  it("creates a webhook with PayPal-Request-Id and event_types as {name}", async () => {
    const { paypal, calls } = client([{ status: 201, body: { id: "WH-2", url: URL_, event_types: [] } }]);
    await paypal.createWebhook(URL_, ["PAYMENT.CAPTURE.COMPLETED"], "webhook-abc");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.headers["PayPal-Request-Id"]).toBe("webhook-abc");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      url: URL_,
      event_types: [{ name: "PAYMENT.CAPTURE.COMPLETED" }],
    });
  });
});
